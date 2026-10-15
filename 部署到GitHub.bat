@echo off
chcp 65001 >nul
title 恋爱心路历程 · 一键推送到 GitHub
echo ============================================================
echo   恋爱心路历程 · 代码推送到 GitHub（部署第一步）
echo ============================================================
echo.
echo  使用前提：
echo   1. 你已在 github.com 注册账号并建好一个空仓库
echo   2. 已生成 GitHub Personal Access Token（需有 repo 权限）
echo   3. 本机已安装 Git（安装包：https://git-scm.com）
echo.
echo  说明：token 仅在你本机内存中使用，推送完成后会自动从
echo        远程地址中清除，不会留在文件里。
echo.

set /p GH_USER=请输入 GitHub 用户名（如 benge-love）: 
set /p GH_REPO=请输入仓库名（如 love-journey）: 
set /p GH_TOKEN=请粘贴 Personal Access Token（回车即可，此窗口仅你可见）: 

echo.
echo ------------------------------------------------------------
echo  即将执行：把本地代码推送到 https://github.com/%GH_USER%/%GH_REPO%.git
echo ------------------------------------------------------------
echo.

git remote remove origin >nul 2>&1
git remote add origin https://%GH_USER%:%GH_TOKEN%@github.com/%GH_USER%/%GH_REPO%.git
git branch -M main
git push -u origin main

if "%errorlevel%"=="0" (
  echo.
  echo ✅ 推送成功！
  echo 正在从远程地址移除 token（安全处理）...
  git remote set-url origin https://github.com/%GH_USER%/%GH_REPO%.git
  echo.
  echo ===== 下一步（网页操作，无需命令）=====
  echo  1. 打开 railway.app ，用 GitHub 登录
  echo  2. New Project -^> Deploy from GitHub repo -^> 选 %GH_REPO%
  echo  3. 部署完会给你一个域名，如 https://%GH_REPO%.up.railway.app
  echo  4. 在 Railway 后台 Variables 加：ADMIN_KEY = 你自己设的复杂密码
  echo  5. 打开 你的域名/buy 即可看到购买页（前端已自动指向，无需改代码）
  echo.
  echo  详细步骤见同目录《部署指南.md》
) else (
  echo.
  echo ❌ 推送失败。常见原因：
  echo    - 仓库名写错，或仓库还没在 GitHub 上创建
  echo    - token 无效，或没有 repo 权限（生成时勾选 repo）
  echo    - 本机没装 Git
  echo   请核对后重新运行本脚本。
)
echo.
pause
