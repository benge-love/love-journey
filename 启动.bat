@echo off
chcp 65001 >nul 2>nul
title 恋爱心路历程 · 授权服务器
cd /d "%~dp0"

echo ============================================
echo   恋爱心路历程 · 授权服务器 一键启动
echo ============================================

:: 定位 node / npm（优先系统，否则用 WorkBuddy 自带）
set "NODE_EXE=node"
set "NPM_EXE=npm"
where node >nul 2>nul || set "NODE_EXE=C:\Users\李勇本\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
where npm >nul 2>nul || set "NPM_EXE=C:\Users\李勇本\.workbuddy\binaries\node\versions\22.22.2-6\npm.cmd"

:: 首次安装依赖（qrcode 等）
if not exist node_modules (
  echo 首次启动，正在安装依赖（约 1-2 分钟，请稍候）...
  "%NPM_EXE%" install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络后重试，或手动运行： npm install
    pause
    exit /b 1
  )
)

:: 后台启动服务器
echo 正在启动服务器...
start "恋爱心路历程-授权服务" /min "%NODE_EXE%" server.js

:: 等待服务就绪后打开浏览器
timeout /t 3 >nul
start "" http://localhost:3000/

:: 计算局域网 IP，方便手机同 WiFi 访问
set "LANIP=本机IP"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress"') do set "LANIP=%%i"

echo.
echo 服务器已在后台启动。
echo   本机浏览器 : http://localhost:3000/
echo   管理后台   : http://localhost:3000/admin   （管理密钥请看弹出的服务器窗口）
echo.
echo   手机同 WiFi 访问（把下面地址发到手机，或手机扫码同网打开）:
echo     产品页  : http://%LANIP%:3000/
echo     购买页  : http://%LANIP%:3000/buy
echo.
echo 说明：关闭“恋爱心路历程-授权服务”那个黑色窗口即可停止服务器。
echo       若手机打不开，多半是防火墙拦截——首次启动若弹出“允许访问”请点【允许】；
echo       或手动放行：以管理员运行 netsh advfirewall firewall add rule name="LJ3000" dir=in action=allow protocol=TCP localport=3000
echo       本窗口可随意关闭，不影响服务器运行。
pause
