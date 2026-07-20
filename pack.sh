#!/usr/bin/env bash
# 打商店提审包：白名单，只收 manifest 引用到的运行文件（排除测试/规格/文档/源图/.git 等）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
VER=$(grep '"version"' "$DIR/manifest.json" | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')
OUT="$DIR/fanqie-uploader-v$VER.zip"
rm -f "$OUT"
cd "$DIR"
zip -r -X -q "$OUT" \
  manifest.json background.js \
  popup content sidepanel _locales \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
  -x '*/.DS_Store'
echo "已打包：$OUT"
