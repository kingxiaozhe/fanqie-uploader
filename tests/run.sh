#!/usr/bin/env bash
# 一键回归：内容脚本逻辑（零依赖）+ popup UI（需 playwright，缺失自动跳过）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ 内容脚本逻辑测试"
node "$DIR/logic.test.cjs"

echo ""
echo "▶ popup UI 测试"
# 尝试定位 playwright（项目未装则用 npx 缓存）
if node -e "require('playwright')" 2>/dev/null; then
  node "$DIR/popup-ui.test.cjs"
else
  PW=$(find "$HOME/.npm/_npx" -maxdepth 4 -type d -name node_modules 2>/dev/null | while read d; do [ -d "$d/playwright" ] && echo "$d" && break; done)
  if [ -n "$PW" ]; then
    NODE_PATH="$PW" node "$DIR/popup-ui.test.cjs"
  else
    echo "⏭️  跳过 popup UI（未找到 playwright，运行 npx playwright install chromium 后可跑）"
  fi
fi
