#!/bin/bash
# 双击即可启动管理端。关掉这个终端窗口 = 关掉管理端（所有环境也会一起关闭）。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node，请先安装 Node.js 20 以上版本：https://nodejs.org"
  read -r -p "按回车退出"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund || { read -r -p "安装失败，按回车退出"; exit 1; }
fi

# 等服务起来再开浏览器，避免打开一个白页
(for _ in $(seq 1 30); do
   if curl -s -m 1 http://127.0.0.1:3131/api/state >/dev/null 2>&1; then
     open "http://127.0.0.1:3131"
     break
   fi
   sleep 1
 done) &

node server/index.js
