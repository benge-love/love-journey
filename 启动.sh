#!/usr/bin/env bash
# 恋爱心路历程 · 授权服务器 一键启动（Linux / macOS）
# 用法：  chmod +x 启动.sh && ./启动.sh
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  恋爱心路历程 · 授权服务器 一键启动"
echo "============================================"

# 首次安装依赖
if [ ! -d node_modules ]; then
  echo "首次启动，正在安装依赖（约 1-2 分钟）..."
  npm install
fi

# 后台启动，日志写入 server.log
echo "正在启动服务器..."
nohup node server.js > server.log 2>&1 &
SVPID=$!
sleep 2

echo ""
echo "服务器已启动（PID=$SVPID）。"
echo "  前端购买页 : http://localhost:3000/"
echo "  管理后台   : http://localhost:3000/admin"
echo "  运行日志   : server.log"
echo ""
echo "停止服务器： kill $SVPID   （或 pkill -f 'node server.js'）"
echo "查看日志  ： tail -f server.log"
