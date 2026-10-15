// 激活码生成工具（Node.js）
// 用法：
//   1) 离线生成（默认，密钥在本机）：node 激活码生成工具.js <数量> [批次前缀]
//      示例： node 激活码生成工具.js 20 A1
//   2) 直连后端生成（推荐生产用，密钥不落地）：
//      node 激活码生成工具.js --server http://你的服务器:3000 --admin 管理密钥 [数量] [批次前缀]
//
// 注意：离线模式的 SECRET 必须与 恋爱心路历程.html / server.js 保持一致，否则激活码无效。
//       生产环境强烈建议用方式 2，密钥只在服务器上，杜绝本地泄露造码。
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const DEFAULT_SECRET = "LJ-LOVE-JOURNEY-2026-PROD-7f3a";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function bytesToBase32(bytes) {
  let out = "", buffer = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(buffer >>> bits) & 31]; }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}
function randomSerial() {
  const b = crypto.randomBytes(8); let s = "";
  for (let i = 0; i < 8; i++) s += B32[b[i] & 31];
  return s;
}
function makeCode(batch, secret) {
  const serial = randomSerial();
  const sig = bytesToBase32(crypto.createHmac("sha256", secret).update(serial).digest()).slice(0, 8);
  return (batch ? batch + "-" : "") + serial + "-" + sig;
}

function parseArgs(argv) {
  const o = { server: null, admin: null, count: 10, batch: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--server") o.server = argv[++i];
    else if (argv[i] === "--admin") o.admin = argv[++i];
    else rest.push(argv[i]);
  }
  o.count = parseInt(rest[0] || "10", 10);
  o.batch = rest[1] || "";
  return o;
}

function httpPost(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let buf = ""; res.on("data", c => buf += c); res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("返回解析失败")); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (isNaN(o.count) || o.count < 1) { console.error("数量必须是正整数"); process.exit(1); }

  if (o.server) {
    if (!o.admin) { console.error("直连后端生成需要 --admin 管理密钥"); process.exit(1); }
    console.log("==== 正在请求后端生成 " + o.count + " 个激活码（批次 " + (o.batch || "无") + "）====");
    try {
      const r = await httpPost(o.server.replace(/\/$/, "") + "/api/admin/generate", { count: o.count, batch: o.batch, maxActivations: 1, adminKey: o.admin });
      if (!r.ok) { console.error("生成失败：" + (r.reason || "未知")); process.exit(1); }
      r.codes.forEach(c => console.log(c));
      console.log("==== 已生成 " + r.codes.length + " 个，密钥仅存于服务器 ====");
    } catch (e) { console.error("请求失败：" + e.message); process.exit(1); }
    return;
  }

  // 离线生成
  console.log("==== 恋爱心路历程 激活码（离线·" + o.count + " 个" + (o.batch ? "，批次 " + o.batch : "") + "）====");
  for (let i = 0; i < o.count; i++) console.log(makeCode(o.batch, DEFAULT_SECRET));
  console.log("==== 生成完毕，请妥善保存，每个码默认可激活一台设备（离线模式密钥在本机） ====");
}
main();
