---
description: 零依赖源码抽取测试 + playwright UI 测试的约定与运行方式
---

# 测试规范

## 框架与命令

- 逻辑测试（零依赖，必跑）：`node tests/logic.test.cjs` —— 从 `content/*.js`、`popup/popup.js` 源码原文按花括号匹配抽取具名函数，在沙箱执行。**测的是发布代码原文，不是重写版**
- UI/集成测试（playwright，缺失自动跳过）：`popup-ui.test.cjs`、`perbook.test.cjs`、`selftest.test.cjs`
- 一键回归：`bash tests/run.sh`（先逻辑测试，再逐个 UI 测试）
- 无覆盖率工具（无 package.json）；覆盖要求按"函数清单"人工核对，不按行百分比

## 覆盖要求

- 纯逻辑函数（章节解析、排期计算 `computePublishTime`、敏感词扫描 `scanSensitive`、去重匹配）：新增/修改必须有对应用例，含边界值（章节号缺失、空正文、词库为空）
- 新功能合入前在 tests/ 补回归用例（参照现有惯例：每批新功能配一条回归提交）
- DOM 操作与番茄页面交互逻辑（publisher.js 的填表/弹窗处理）不强测——依赖番茄真实页面，靠 popup「选择器自检」+ 试填模式人工验证

## 文件与命名约定

- 测试文件位置：独立 `tests/` 目录
- 命名：`*.test.cjs`（CommonJS，直接 node 运行，不引入测试框架）
- 被抽取的源码函数必须是**顶层具名 function 声明**（`function name(...)`），改成箭头函数/方法简写会让抽取器找不到函数——重构前先跑 `node tests/logic.test.cjs` 确认

## 分类要求

- 工具函数：输入输出全覆盖含边界值
- 消息协议：新增消息类型时，测发送方构造与接收方分支
- 禁止：测试内固定长延时等待；测试依赖真实 fanqienovel.com 网络

## 可视化回归

- browser_driver: playwright
- 无基准截图机制；UI 变更靠 playwright 用例断言 DOM 状态
