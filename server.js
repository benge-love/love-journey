/*
 * 恋爱心路历程 · 授权后端服务（零依赖 Node.js）
 * 功能：联网校验激活码（防造码+防一码多用）、批次停用、密钥轮换、
 *       订单/收款流程（手动确认 + 微信/支付宝回调扩展位）。
 *
 * 启动：  node server.js
 * 配置（环境变量，可选）：
 *   PORT       端口，默认 3000
 *   ADMIN_KEY  管理密钥，不填则首次启动随机生成并写入 admin.key
 *   PUBLIC_DIR 前端文件目录，默认本文件所在目录
 *
 * 说明：本服务同时托管前端 HTML（/ 与 /admin），因此前后端同源，无需额外跨域配置。
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// 微信支付模块（未配置时 isConfigured() 返回 false，自动降级为手动确认模式）
let wx = { isConfigured: () => false, createNativeOrder: null, ensureCerts: null, verifyCallback: null, decryptResource: null };
try { wx = require("./wechatpay"); } catch (e) { /* 文件缺失则保持降级 */ }
// 二维码库（可选；用于微信支付二维码与购买页分享海报。未安装不影响核心授权）
let QR = null;
function qrLib() { if (QR === null) { try { QR = require("qrcode"); } catch (e) { QR = false; } } return QR; }

// 极简 .env 加载（无第三方依赖）：若存在 .env 文件，把其中未设置的变量注入 process.env
(function loadEnv() {
  try {
    const ep = path.join(__dirname, ".env");
    if (!fs.existsSync(ep)) return;
    const txt = fs.readFileSync(ep, "utf8");
    txt.split(/\r?\n/).forEach(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const i = line.indexOf("=");
      if (i < 0) return;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[k] === undefined) process.env[k] = v;
    });
  } catch (e) { /* 忽略，按默认行为运行 */ }
})();

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_FILE = path.join(DIR, "data.json");
const ADMIN_KEY_FILE = path.join(DIR, "admin.key");

// 必须与 前端(恋爱心路历程.html) 和 激活码生成工具.js 的默认 SECRET 一致
const DEFAULT_SECRET = "LJ-LOVE-JOURNEY-2026-PROD-7f3a";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/* ----------------------------- 基础工具 ----------------------------- */
function bytesToBase32(bytes) {
  let out = "", buffer = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(buffer >>> bits) & 31]; }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}
function hmacSig(secret, serial) {
  return bytesToBase32(crypto.createHmac("sha256", secret).update(serial).digest()).slice(0, 8);
}
function randomSerial() {
  const b = crypto.randomBytes(8); let s = "";
  for (let i = 0; i < 8; i++) s += B32[b[i] & 31];
  return s;
}
function makeCode(batch, secret) {
  const serial = randomSerial();
  const sig = hmacSig(secret || DEFAULT_SECRET, serial);
  return (batch ? batch + "-" : "") + serial + "-" + sig;
}
function parseCode(raw) {
  if (!raw) return null;
  const code = raw.trim().toUpperCase().replace(/\s+/g, "");
  const parts = code.split("-");
  if (parts.length < 2) return null;
  let batch, serial, sig;
  if (parts.length >= 3) { batch = parts.slice(0, -2).join("-"); serial = parts[parts.length - 2]; sig = parts[parts.length - 1]; }
  else { batch = ""; serial = parts[0]; sig = parts[1]; }
  if (serial.length < 6 || sig.length < 6) return null;
  return { code, batch, serial, sig };
}
function previewSecret(s) { return s.slice(0, 8) + "…"; }

/* ----------------------------- 数据存储 ----------------------------- */
function defaultData() {
  return {
    keys: {
      active: DEFAULT_SECRET,
      history: [{ secret: DEFAULT_SECRET, status: "active", label: "默认密钥", rotatedAt: null }]
    },
    invalidBatches: [],
    activations: {}, // serial -> {maxActivations, used, records:[{device,ip,at}], code, batch, createdAt, generated}
    orders: {},      // orderId -> {amount,status,code,createdAt,paidAt,note}
    settings: { price: 9.9, product: "恋爱心路历程·永久激活" }
  };
}
let data;
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); return; }
    catch (e) { console.error("data.json 损坏，已用默认数据重建"); }
  }
  data = defaultData();
  saveData();
}
let saveTimer = null;
function saveData() {
  // 简单串行落盘，避免并发写损坏
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error("保存失败:", e.message); }
  }, 50);
}
function validSecrets() {
  const set = new Set();
  if (data.keys.active) set.add(data.keys.active);
  (data.keys.history || []).forEach(k => { if (k.status === "active") set.add(k.secret); });
  return Array.from(set);
}

/* ----------------------------- 授权令牌 ----------------------------- */
function makeToken(serial, device) {
  const exp = Date.now() + 365 * 86400000;
  const body = serial + "|" + device + "|" + exp;
  const sig = crypto.createHmac("sha256", data.keys.active).update(body).digest("base64");
  return Buffer.from(body, "utf8").toString("base64") + "." + sig;
}
function checkToken(token, device) {
  try {
    const [b, sig] = token.split(".");
    const body = Buffer.from(b, "base64").toString("utf8");
    const [serial, dev, exp] = body.split("|");
    if (Date.now() > Number(exp)) return { ok: false, reason: "令牌已过期" };
    if (dev !== device) return { ok: false, reason: "设备不匹配" };
    const expect = crypto.createHmac("sha256", data.keys.active).update(body).digest("base64");
    if (sig !== expect) return { ok: false, reason: "令牌无效" };
    return { ok: true, serial };
  } catch (e) { return { ok: false, reason: "令牌格式错误" }; }
}

/* ----------------------------- 管理密钥 ----------------------------- */
let ADMIN_KEY;
function ensureAdminKey() {
  if (process.env.ADMIN_KEY) { ADMIN_KEY = process.env.ADMIN_KEY; return; }
  if (fs.existsSync(ADMIN_KEY_FILE)) {
    try { ADMIN_KEY = fs.readFileSync(ADMIN_KEY_FILE, "utf8").trim(); if (ADMIN_KEY) return; } catch (e) {}
  }
  ADMIN_KEY = crypto.randomBytes(18).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  try { fs.writeFileSync(ADMIN_KEY_FILE, ADMIN_KEY); } catch (e) {}
}

/* ----------------------------- 速率限制（防暴力试码） ----------------------------- */
const rateMap = new Map(); // ip -> [ts,...]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 30) { rateMap.set(ip, arr); return true; }
  arr.push(now); rateMap.set(ip, arr); return false;
}

/* ----------------------------- 业务处理 ----------------------------- */
function verifyCodeInternal(code, device, ip) {
  const p = parseCode(code);
  if (!p) return { ok: false, reason: "激活码格式不正确" };
  let sigOk = false;
  for (const s of validSecrets()) { if (hmacSig(s, p.serial) === p.sig) { sigOk = true; break; } }
  if (!sigOk) return { ok: false, reason: "激活码无效（签名错误）" };
  if (data.invalidBatches.includes(p.batch)) return { ok: false, reason: "该批次已被停用" };
  let entry = data.activations[p.serial];
  if (!entry) {
    entry = data.activations[p.serial] = {
      maxActivations: 1, used: 0, records: [], code: p.code, batch: p.batch, createdAt: new Date().toISOString(), generated: false
    };
  }
  if (entry.used >= entry.maxActivations) {
    return { ok: false, reason: "该激活码已达激活上限（一码一设备）" };
  }
  entry.used += 1;
  entry.records.push({ device: device || "unknown", ip: ip || "", at: new Date().toISOString() });
  saveData();
  return { ok: true, serial: p.serial, token: makeToken(p.serial, device) };
}

function requireAdmin(reqBody, query) {
  const k = (reqBody && reqBody.adminKey) || query.adminKey;
  return k && k === ADMIN_KEY;
}

// 给订单发卡（手动确认 / 微信回调共用）：幂等，已发卡直接返回原码
function issueCodeForOrder(order, orderId) {
  if (order.status === "paid" && order.code) return order.code;
  const code = makeCode("PAID", data.keys.active);
  const parts = code.split("-");
  const serial = parts[parts.length - 2];
  order.status = "paid"; order.code = code; order.paidAt = new Date().toISOString();
  data.activations[serial] = {
    maxActivations: 1, used: 0, records: [], code, batch: "PAID", createdAt: new Date().toISOString(), generated: true
  };
  saveData();
  return code;
}

/* ----------------------------- HTTP 层 ----------------------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  res.end(body);
}
function serveFile(res, file) {
  const fp = path.join(DIR, file);
  if (!fs.existsSync(fp) || !fp.startsWith(DIR)) { res.writeHead(404); res.end("404"); return; }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
}
function readRaw(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on("end", () => resolve(buf));
  });
}
function readBody(req) {
  return readRaw(req).then(b => { try { return b ? JSON.parse(b) : {}; } catch (e) { return {}; } });
}
function getQuery(url) {
  const q = {}; const i = url.indexOf("?");
  if (i >= 0) url.slice(i + 1).split("&").forEach(p => { const [k, v] = p.split("="); q[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  return q;
}
function clientIP(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const query = getQuery(req.url);

  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); res.end(); return; }

  // 静态页面
  if (req.method === "GET" && (url === "/" || url === "/app" || url === "/index.html")) { serveFile(res, "恋爱心路历程.html"); return; }
  if (req.method === "GET" && (url === "/admin" || url === "/admin.html")) { serveFile(res, "admin.html"); return; }
  if (req.method === "GET" && (url === "/buy" || url === "/buy.html")) { serveFile(res, "购买页.html"); return; }
  if (req.method === "GET" && url === "/health") { serveFile(res, "恋爱心路历程.html"); return; }

  // API
  if (url.startsWith("/api/")) {
    let body = {};
    if (req.method === "POST") body = await readBody(req);

    /* 公开接口 */
    if (url === "/api/health" && req.method === "GET") {
      return sendJSON(res, 200, { ok: true, price: data.settings.price, product: data.settings.product, serverTime: Date.now() });
    }
    // 生成二维码 PNG（微信支付二维码、购买海报分享码）。text 必填。
    if (url === "/api/qr" && req.method === "GET") {
      const text = query.text;
      if (!text) return sendJSON(res, 400, { ok: false, reason: "缺少 text 参数" });
      const lib = qrLib();
      if (!lib) return sendJSON(res, 500, { ok: false, reason: "服务端未安装 qrcode，请先 npm install" });
      const size = Math.min(Math.max(Number(query.size) || 240, 80), 1000);
      try {
        const buf = await lib.toBuffer(text, { margin: 1, width: size, errorCorrectionLevel: "M" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
        return res.end(buf);
      } catch (e) { return sendJSON(res, 500, { ok: false, reason: "生成失败：" + e.message }); }
    }
    if (url === "/api/verify" && req.method === "POST") {
      const ip = clientIP(req);
      if (rateLimited(ip)) return sendJSON(res, 429, { ok: false, reason: "尝试过于频繁，请稍后再试" });
      const r = verifyCodeInternal(body.code, body.device, ip);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (url === "/api/check" && req.method === "POST") {
      const r = checkToken(body.token, body.device);
      if (!r.ok) return sendJSON(res, 200, { ok: false, revoked: true, reason: r.reason });
      // 再确认 serial 仍有效（未被批次停用/密钥撤销）
      const entry = data.activations[r.serial];
      if (entry && data.invalidBatches.includes(entry.batch)) return sendJSON(res, 200, { ok: false, revoked: true, reason: "批次已停用" });
      return sendJSON(res, 200, { ok: true, serial: r.serial });
    }

    /* 订单 / 收款 */
    if (url === "/api/order/create" && req.method === "POST") {
      const orderId = "LJ" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
      const amount = Number(data.settings.price) || 9.9;
      data.orders[orderId] = {
        amount, status: "pending", code: null, createdAt: new Date().toISOString(), paidAt: null, note: "",
        channel: body.channel === "wechatpay" ? "wechatpay" : "manual"
      };
      saveData();
      return sendJSON(res, 200, { ok: true, orderId, amount, status: "pending", channel: data.orders[orderId].channel });
    }
    // 微信支付配置探查（购买页据此决定显示扫码支付还是演示模式）
    if (url === "/api/wechatpay/config" && req.method === "GET") {
      return sendJSON(res, 200, { ok: true, configured: wx.isConfigured(), price: data.settings.price, product: data.settings.product });
    }
    // 创建微信 NATIVE 支付（返回 code_url 与二维码 dataURL）
    if (url === "/api/wechatpay/create-native" && req.method === "POST") {
      if (!wx.isConfigured()) return sendJSON(res, 400, { ok: false, reason: "微信支付未配置" });
      const o = data.orders[body.orderId];
      if (!o) return sendJSON(res, 404, { ok: false, reason: "订单不存在，请先创建" });
      try {
        const totalFen = Math.round((Number(o.amount) || 0) * 100);
        const codeUrl = await wx.createNativeOrder(body.orderId, totalFen, data.settings.product);
        const lib = qrLib();
        let qrData = null;
        if (lib) { try { qrData = await lib.toDataURL(codeUrl, { margin: 1, width: 280, errorCorrectionLevel: "M" }); } catch (e) {} }
        o.channel = "wechatpay"; saveData();
        return sendJSON(res, 200, { ok: true, codeUrl, qr: qrData });
      } catch (e) {
        return sendJSON(res, 502, { ok: false, reason: "微信下单失败：" + e.message });
      }
    }
    if (url === "/api/order/status" && req.method === "GET") {
      const o = data.orders[query.orderId];
      if (!o) return sendJSON(res, 404, { ok: false, reason: "订单不存在" });
      return sendJSON(res, 200, { ok: true, status: o.status, code: o.status === "paid" ? o.code : null, amount: o.amount });
    }
    // 管理后台手动确认收款（适用于你通过视频号/个人收款收到钱后手动发卡）
    if (url === "/api/order/manual-confirm" && req.method === "POST") {
      if (!requireAdmin(body, query)) return sendJSON(res, 401, { ok: false, reason: "管理密钥错误" });
      const o = data.orders[body.orderId];
      if (!o) return sendJSON(res, 404, { ok: false, reason: "订单不存在" });
      const code = issueCodeForOrder(o, body.orderId);
      return sendJSON(res, 200, { ok: true, code, already: o.status === "paid" });
    }
    // 微信支付回调（NATIVE）：验签 -> 解密 -> 成功则自动发卡
    if (url === "/api/payment/wechat/callback" && req.method === "POST") {
      const raw = await readRaw(req);
      if (!wx.isConfigured()) return sendJSON(res, 200, { code: "SUCCESS", message: "未启用微信支付" });
      try {
        await wx.ensureCerts();
        if (!wx.verifyCallback(req.headers, raw)) return sendJSON(res, 200, { code: "FAIL", message: "签名验证失败" });
        const j = JSON.parse(raw);
        const resource = wx.decryptResource(j.resource);
        if (resource.trade_state === "SUCCESS") {
          const o = data.orders[resource.out_trade_no];
          if (o) issueCodeForOrder(o, resource.out_trade_no);
        }
        return sendJSON(res, 200, { code: "SUCCESS", message: "成功" });
      } catch (e) {
        console.error("微信回调处理异常:", e.message);
        return sendJSON(res, 200, { code: "FAIL", message: e.message });
      }
    }
    // 支付宝回调
    if (url === "/api/payment/alipay/callback" && req.method === "POST") {
      // TODO: 验签 -> 解析 out_trade_no -> 标记订单 paid 并发码
      return sendJSON(res, 200, { ok: true });
    }

    /* 管理接口（需 adminKey） */
    if (url.startsWith("/api/admin/")) {
      if (!requireAdmin(body, query)) return sendJSON(res, 401, { ok: false, reason: "管理密钥错误" });
      if (url === "/api/admin/generate" && req.method === "POST") {
        const n = Math.min(Number(body.count) || 1, 500);
        const batch = (body.batch || "").toUpperCase();
        const max = Math.max(1, Number(body.maxActivations) || 1);
        const codes = [];
        for (let i = 0; i < n; i++) {
          const c = makeCode(batch, data.keys.active);
          const serial = c.split("-")[c.split("-").length - 2];
          data.activations[serial] = { maxActivations: max, used: 0, records: [], code: c, batch, createdAt: new Date().toISOString(), generated: true };
          codes.push(c);
        }
        saveData();
        return sendJSON(res, 200, { ok: true, count: codes.length, batch, codes });
      }
      if (url === "/api/admin/invalidate-batch" && req.method === "POST") {
        const b = (body.batch || "").toUpperCase();
        if (!b) return sendJSON(res, 400, { ok: false, reason: "批次不能为空" });
        if (!data.invalidBatches.includes(b)) data.invalidBatches.push(b);
        saveData();
        return sendJSON(res, 200, { ok: true, invalidBatches: data.invalidBatches });
      }
      if (url === "/api/admin/revoke-batch" && req.method === "POST") {
        const b = (body.batch || "").toUpperCase();
        data.invalidBatches = data.invalidBatches.filter(x => x !== b);
        saveData();
        return sendJSON(res, 200, { ok: true, invalidBatches: data.invalidBatches });
      }
      if (url === "/api/admin/rotate-key" && req.method === "POST") {
        const newSecret = crypto.randomBytes(24).toString("hex");
        data.keys.history.push({ secret: newSecret, status: "active", label: body.label || ("密钥-" + new Date().toISOString().slice(0, 10)), rotatedAt: new Date().toISOString() });
        data.keys.active = newSecret;
        saveData();
        return sendJSON(res, 200, { ok: true, newPreview: previewSecret(newSecret), note: "已生成新密钥并设为当前。旧密钥仍有效，可用 revoke-key 停用使旧码失效。" });
      }
      if (url === "/api/admin/revoke-key" && req.method === "POST") {
        const prev = body.preview;
        let found = false;
        data.keys.history.forEach(k => { if (previewSecret(k.secret) === prev && k.secret !== data.keys.active) { k.status = "revoked"; found = true; } });
        saveData();
        return sendJSON(res, 200, { ok: true, revoked: found, invalidBatches: data.invalidBatches });
      }
      if (url === "/api/admin/list-keys" && req.method === "GET") {
        const list = data.keys.history.map(k => ({ preview: previewSecret(k.secret), status: k.status, label: k.label, rotatedAt: k.rotatedAt, current: k.secret === data.keys.active }));
        return sendJSON(res, 200, { ok: true, keys: list });
      }
      if (url === "/api/admin/stats" && req.method === "GET") {
        const codes = Object.values(data.activations);
        const orders = Object.values(data.orders);
        return sendJSON(res, 200, {
          ok: true,
          generated: codes.length,
          activated: codes.filter(c => c.used > 0).length,
          usedTotal: codes.reduce((a, c) => a + c.used, 0),
          invalidBatches: data.invalidBatches,
          ordersPending: orders.filter(o => o.status === "pending").length,
          ordersPaid: orders.filter(o => o.status === "paid").length,
          revenue: orders.filter(o => o.status === "paid").reduce((a, o) => a + (o.amount || 0), 0)
        });
      }
      if (url === "/api/admin/orders" && req.method === "GET") {
        const list = Object.keys(data.orders).map(id => ({ id, ...data.orders[id] })).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return sendJSON(res, 200, { ok: true, orders: list });
      }
      if (url === "/api/admin/set-price" && req.method === "POST") {
        data.settings.price = Number(body.price) || data.settings.price;
        saveData();
        return sendJSON(res, 200, { ok: true, price: data.settings.price });
      }
      return sendJSON(res, 404, { ok: false, reason: "未知管理接口" });
    }

    return sendJSON(res, 404, { ok: false, reason: "接口不存在" });
  }

  // 其他静态文件
  if (req.method === "GET") { serveFile(res, url.slice(1)); return; }
  res.writeHead(404); res.end("404");
});

/* ----------------------------- 启动 ----------------------------- */
loadData();
ensureAdminKey();
server.listen(PORT, () => {
  console.log("==================================================");
  console.log(" 恋爱心路历程 · 授权后端已启动");
  console.log(" 前端页面 : http://localhost:" + PORT + "/");
  console.log(" 购买落地页 : http://localhost:" + PORT + "/buy");
  console.log(" 管理后台 : http://localhost:" + PORT + "/admin");
  console.log(" 微信支付 : " + (wx.isConfigured() ? "已启用（NATIVE 扫码，自动发卡）" : "未配置（演示/手动确认模式）"));
  console.log(" 管理密钥 : " + ADMIN_KEY + "  （已保存至 admin.key，请妥善保管）");
  console.log("==================================================");
});
