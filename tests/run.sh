#!/usr/bin/env bash
# 一键回归：内容脚本逻辑（零依赖）+ 多个 UI 测试（需 playwright，缺失自动跳过）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ 内容脚本逻辑测试"
node "$DIR/logic.test.cjs"

# 基于 playwright 的 UI/集成测试（按需逐个跑）
UI_TESTS=(popup-ui.test.cjs import-ui.test.cjs perbook.test.cjs selftest.test.cjs)

# 定位 playwright：项目已装则直接用，否则尝试 npx 缓存
PW_NODE_PATH=""
if node -e "require('playwright')" 2>/dev/null; then
  PW_NODE_PATH=""   # 已在默认 require 路径
  HAVE_PW=1
else
  # `|| true`：find|while 在最后一个条目非 playwright 目录时以非 0 收尾，set -e 会误杀脚本（缺 playwright 时把跳过误判成失败）
  PW=$(find "$HOME/.npm/_npx" -maxdepth 4 -type d -name node_modules 2>/dev/null | while read d; do [ -d "$d/playwright" ] && echo "$d" && break; done) || true
  if [ -n "$PW" ]; then PW_NODE_PATH="$PW"; HAVE_PW=1; else HAVE_PW=0; fi
fi

if [ "$HAVE_PW" != "1" ]; then
  echo ""
  echo "⏭️  跳过 UI 测试（未找到 playwright，运行 npx playwright install chromium 后可跑）"
  exit 0
fi

for t in "${UI_TESTS[@]}"; do
  echo ""
  echo "▶ $t"
  if [ -n "$PW_NODE_PATH" ]; then
    NODE_PATH="$PW_NODE_PATH" node "$DIR/$t"
  else
    node "$DIR/$t"
  fi
done
