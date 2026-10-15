# 恋爱心路历程 · 授权后端（部署与收银说明）

本目录是一个**零额外依赖**（除可选 `qrcode`）的 Node.js 服务，同时承担三件事：

1. **授权校验**：联网验证激活码（防造码 + 一码一设备），支持批次停用、密钥轮换、远程撤销。
2. **收银流程**：创建订单、微信支付回调自动发卡、管理后台手动确认发卡。
3. **静态托管**：同时托管产品页 `/`、管理后台 `/admin`、购买落地页 `/buy`。

---

## 一、本地运行（先试后上云）

```bash
# 1. 安装依赖（仅 qrcode，用于生成二维码；不装也能跑核心授权）
npm install

# 2. 启动（PORT 默认 3000，ADMIN_KEY 不填会自动生成并写入 admin.key）
node server.js
```

启动后终端会打印：

- 前端页面：`http://localhost:3000/`
- 管理后台：`http://localhost:3000/admin`（进入需填终端打印的「管理密钥」）
- 购买落地页：`http://localhost:3000/buy`

> ⚠️ 首次启动会在目录生成 `data.json`（订单/激活记录）和 `admin.key`（管理密钥）。**部署到云服务器时，请用环境变量传入 ADMIN_KEY，并定期备份 data.json。**

---

## 二、一键部署到云平台

### 方式 A：Render.com（推荐，最省事）

1. 把本目录推到 GitHub 仓库。
2. 在 [Render](https://render.com) 新建 **Web Service**，连该仓库。
3. 构建命令 `npm install`，启动命令 `node server.js`（仓库已带 `render.yaml`，会自动识别）。
4. 在 **Environment** 里设置变量：
   - `ADMIN_KEY`：自定义一个强密码（务必记下）
   - `WX_APPID` / `WX_MCHID` / `WX_APIV3_KEY` / `WX_SERIAL` / `WX_PRIVKEY` / `WX_NOTIFY_URL`（**接微信支付才需要**，见第三节）
5. 部署完成后，Render 会给你一个 `https://xxx.onrender.com` 域名。
6. **无需改代码**：前端已改为零配置——同源托管时自动用当前域名走云端授权，你直接把 `https://xxx.onrender.com/` 发给用户即可。如需把前端单独放到别的域名，才用 `?backend=https://xxx.onrender.com` 指定。

### 方式 B：Railway

仓库已带 `railway.json`，在 [Railway](https://railway.app) 导入仓库即自动识别。同样在变量里设置 `ADMIN_KEY` 与 `WX_*`。

### 方式 C：Docker / 任意云服务器

```bash
docker build -t love-journey-server .
docker run -d -p 3000:3000 \
  -e ADMIN_KEY=你的管理密钥 \
  -e WX_APPID=... -e WX_MCHID=... -e WX_APIV3_KEY=... \
  -e WX_SERIAL=... -e WX_PRIVKEY="-----BEGIN PRIVATE KEY-----..." \
  -e WX_NOTIFY_URL=https://你的域名/api/payment/wechat/callback \
  -v $(pwd)/data.json:/app/data.json \
  love-journey-server
```

> 务必把 `data.json` 挂卷持久化，否则容器重启会丢订单与激活记录。

---

## 三、接入微信支付（自动发卡）

> 前置条件：你要有**微信支付商户号**（需企业/个体户资质）。个人无资质不可用，请走「手动确认」模式（下单后到后台点确认收款发卡）。

### 1. 准备资料

在 [微信支付商户平台](https://pay.weixin.qq.com) 拿到：

| 变量 | 说明 |
|---|---|
| `WX_APPID` | 与商户绑定的 AppID（公众号/小程序/APP） |
| `WX_MCHID` | 商户号 |
| `WX_APIV3_KEY` | APIv3 密钥（32 位，商户平台「APIv3 密钥」设置） |
| `WX_SERIAL` | 商户 API 证书序列号（证书管理里查看） |
| `WX_PRIVKEY` | 商户 API 私钥 PEM（下载证书后解压的 `apiclient_key.pem` 内容，或填该文件路径） |
| `WX_NOTIFY_URL` | 回调地址，形如 `https://你的域名/api/payment/wechat/callback`（必须是公网 https） |

### 2. 工作流程

1. 买家在购买页点「微信支付」→ 前端建订单并调用 `/api/wechatpay/create-native`。
2. 后端用商户私钥签名，向微信申请 NATIVE 支付，返回 `code_url`。
3. 购买页把 `code_url` 渲染成二维码，买家微信扫码付款。
4. 微信异步回调 `/api/payment/wechat/callback`：后端用**平台证书**验签 → 用 APIv3 密钥解密 → 确认 `trade_state=SUCCESS` → **自动标记订单已付并发卡**。
5. 购买页轮询到「已支付」，自动弹出激活码 + 生成可保存海报。

### 3. 降级说明

只要 `WX_*` 任一变量缺失，`/api/wechatpay/config` 返回 `configured:false`，购买页自动切回「演示/手动确认」模式——买家下单后，你到 `/admin` 后台「订单管理」点「确认收款发卡」即可，无需任何支付资质。

---

## 四、管理后台速查

进入 `/admin`（密钥为启动时打印的 ADMIN_KEY）：

- **数据概览**：已生成码数、已激活数、订单与营收。
- **生成激活码**：批量产出可售卖激活码（建议用 `--server` 模式，密钥不落地）。
- **批次 / 密钥**：停用某批次（含已激活立即失效）、轮换新密钥、停用旧密钥。
- **订单管理**：手动确认收款发卡（无支付资质时的收款方式）。
- **价格设置**：改售卖价，购买页实时同步。

---

## 五、合规提醒

1. **收款资质**：对外收钱需要微信/支付宝商户资质，不要用个人二维码私下收「授权费」。
2. **个人信息**：用户上传的头像、照片、昵称属个人信息，产品页与隐私说明需写清用途。
3. **数据安全**：`data.json` 含订单与激活记录，定期备份；`admin.key` 等同最高权限，切勿泄露。
