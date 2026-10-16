/*
 * 微信支付 v3（NATIVE 扫码支付）集成模块
 * 仅依赖 Node 内置 crypto + 全局 fetch（Node 18+ 自带），无需额外依赖。
 *
 * 配置（环境变量）：
 *   WX_APPID      微信公众平台/开放平台 AppID（与商户绑定的）
 *   WX_MCHID      微信支付商户号
 *   WX_APIV3_KEY  商户 APIv3 密钥（32 位，用于回调报文解密）
 *   WX_SERIAL     商户 API 证书序列号（调用下单签名用）
 *   WX_PRIVKEY    商户 API 私钥（PEM 文本，或指向 .pem 文件的路径）
 *   WX_NOTIFY_URL 支付结果回调地址（必须是公网 https，且带 /api/payment/wechat/callback）
 *
 * 未配置任一变量时 isConfigured() 返回 false，上层自动降级为「手动确认」模式。
 */
const crypto = require("crypto");
const fs = require("fs");

function loadPrivKey(v) {
  if (!v) return null;
  if (v.indexOf("-----BEGIN") >= 0) return v;      // 直接传 PEM 文本
  try { return fs.readFileSync(v, "utf8"); }        // 传文件路径
  catch (e) { return v; }                            // 兜底当文本
}

const cfg = {
  appid: process.env.WX_APPID,
  mchid: process.env.WX_MCHID,
  apiv3: process.env.WX_APIV3_KEY,
  serial: process.env.WX_SERIAL,
  privkey: loadPrivKey(process.env.WX_PRIVKEY),
  notifyUrl: process.env.WX_NOTIFY_URL
};

function isConfigured() {
  return !!(cfg.appid && cfg.mchid && cfg.apiv3 && cfg.serial && cfg.privkey && cfg.notifyUrl);
}

const API_BASE = "https://api.mch.weixin.qq.com";

function sha256RsaSign(str) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(str, "utf8");
  return sign.sign(cfg.privkey, "base64");
}

// 构造 Authorization 头（商户签名）
function buildAuthHeader(method, urlPath, bodyStr) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Math.floor(Date.now() / 1000);
  const message = method + "\n" + urlPath + "\n" + ts + "\n" + nonce + "\n" + bodyStr + "\n";
  const sig = sha256RsaSign(message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonce}",signature="${sig}",timestamp="${ts}",serial_no="${cfg.serial}"`;
}

async function wechatRequest(method, urlPath, bodyObj) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const resp = await fetch(API_BASE + urlPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": buildAuthHeader(method, urlPath, bodyStr)
    },
    body: bodyStr || undefined
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 可能为空或非 JSON */ }
  if (!resp.ok) {
    const msg = (json && (json.message || json.code)) || text;
    throw new Error("微信接口错误(" + resp.status + "): " + msg);
  }
  return json;
}

// 创建 NATIVE 订单，返回微信下发的 code_url（买家用微信扫码）
async function createNativeOrder(outTradeNo, totalFeeFen, description) {
  const urlPath = "/v3/pay/transactions/native";
  const body = {
    appid: cfg.appid,
    mchid: cfg.mchid,
    description: description || "恋爱心路历程",
    out_trade_no: outTradeNo,
    notify_url: cfg.notifyUrl,
    amount: { total: totalFeeFen, currency: "CNY" }
  };
  const json = await wechatRequest("POST", urlPath, body);
  if (!json || !json.code_url) throw new Error("微信未返回 code_url");
  return json.code_url;
}

/* ---------------- 回调验签 + 解密 ---------------- */
let certCache = {}; // serial_no -> 平台证书公钥 PEM

async function ensureCerts() {
  if (Object.keys(certCache).length) return;
  const urlPath = "/v3/certificates";
  const json = await wechatRequest("GET", urlPath, null);
  for (const item of (json && json.data) || []) {
    try {
      const pem = decryptCert(item.encrypt_certificate);
      certCache[item.serial_no] = pem;
    } catch (e) { /* 跳过坏证书 */ }
  }
}

function decryptAesGcm(e) {
  const key = Buffer.from(cfg.apiv3, "utf8");
  const nonce = Buffer.from(e.nonce || "", "utf8");
  const ad = Buffer.from(e.associated_data || "", "utf8");
  const buf = Buffer.from(e.ciphertext, "base64");
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  if (ad.length) decipher.setAAD(ad);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}

function decryptResource(resource) {
  return JSON.parse(decryptAesGcm(resource));
}

// 校验微信回调签名：签名串 = timestamp\nnonce\nbody\n（注意结尾换行）
function verifyCallback(headers, bodyStr) {
  const sig = headers["wechatpay-signature"];
  const ts = headers["wechatpay-timestamp"];
  const nonce = headers["wechatpay-nonce"];
  const serial = headers["wechatpay-serial"];
  const cert = certCache[serial];
  if (!cert) return false;
  const message = ts + "\n" + nonce + "\n" + bodyStr + "\n";
  const v = crypto.createVerify("RSA-SHA256");
  v.update(message, "utf8");
  return v.verify(cert, sig, "base64");
}

module.exports = {
  isConfigured,
  createNativeOrder,
  ensureCerts,
  verifyCallback,
  decryptResource,
  cfg,
  // 仅测试用：向平台证书缓存注入一张证书，便于离线模拟微信回调验签
  _setCert: function (serial, pem) { certCache[serial] = pem; }
};
