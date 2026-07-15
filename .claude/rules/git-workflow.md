---
description: 中文动词前缀 commit 风格、master 主分支、版本号随 manifest 走
---

# Git 工作流

## 分支

- 主分支：`master`，不直接在其上开发
- 开发分支：当前会话使用指定的 `claude/*` 分支；人工开发用 `feature/xxx`、`fix/xxx`
- 合并方式：直接 merge 到 master（历史为线性提交，无强制 squash）

## Commit

- 风格：**中文动词前缀**为主，`类型：描述`；兼容英文 conventional 前缀。历史真实示例：
  - `新增：敏感词本地预检`
  - `修复 3 个 bug：书名贯通会话、章节号解析、文档同步`
  - `fix: 版本冲突反复出现时快速失败触发重试,不再空等5分钟看门狗`
- 一次 commit 一个逻辑变更；测试补充单独提交（如 `测试：覆盖四个新功能的回归`）；禁止 "wip"、裸 "fix"
- 版本发布：改 `manifest.json` version 后单独提交 `版本号 X.Y.Z → X.Y.Z+1`
- 功能变更同步更新 `README.md` / `FEATURES.md`（doc-syncer 兜底，但提交时顺手改最好）

## PR / 合入

- 合入前置：`bash tests/run.sh` 逻辑测试必须绿（零依赖，无借口跳过）
- PR 描述最低要求：改了什么、为什么、是否动了 `SEL` 选择器或 manifest 权限（这两项必须显式声明）
