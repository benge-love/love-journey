# 恋爱心路历程 · 授权后端 镜像
# 用法：
#   docker build -t love-journey-server .
#   docker run -d -p 3000:3000 -e ADMIN_KEY=你的管理密钥 -e WX_APPID=...  love-journey-server
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用镜像层缓存）
COPY package.json ./
RUN npm install --omit=dev

# 再拷源码
COPY . .

ENV PORT=3000
EXPOSE 3000

# 数据持久化：把容器内的 data.json 挂到卷，避免重启丢订单/激活记录
VOLUME ["/app/data.json", "/app/admin.key"]

CMD ["node", "server.js"]
