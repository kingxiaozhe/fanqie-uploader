# fanqie-uploader（番茄小说批量上传器）

纯手写 Chrome Manifest V3 扩展：选择本地章节文件夹（.txt/.md），自动批量发布到番茄小说作者后台（fanqienovel.com）。零构建、零依赖，加载即用。

## 技术栈

- 语言: JavaScript（原生 ES2020+，无 TypeScript）
- 框架: 无（纯手写 MV3 扩展，不依赖任何打包/前端框架）
- 包管理: 无（无 package.json；playwright 仅测试时按需 npx）
- 版本控制: remote（origin → kingxiaozhe/fanqie-uploader，主分支 master）
- 交付形态: Chrome 浏览器扩展（桌面）
- 业务地图: 跳过(小项目,源码仅11个)   <!-- codebase-context 判定结果，/cm:prd 据此行动不再重复询问 -->

## 常用命令

- 安装依赖: 无需安装（零依赖）
- 开发运行: `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选本目录
- 构建: 无构建步骤（源码即产物；打包上架用 zip，产物已被 .gitignore）
- 测试: `bash tests/run.sh`（逻辑测试零依赖必跑；UI 测试缺 playwright 自动跳过）
- 单跑逻辑测试: `node tests/logic.test.cjs`

## 目录结构

```
manifest.json        # MV3 清单：权限、content_scripts 注入规则（改注入范围先看这里）
background.js        # Service Worker：消息总线、开/关发布标签页、桌面通知
popup/               # 弹窗 UI：选文件夹、解析章节、设置项、启动上传
content/
├── uploader.js      # 「章节管理页」调度器：同步去重、串行调度、看门狗、重试（大脑）
├── publisher.js     # 「发布页」执行器：填表、处理弹窗、点发布（选择器集中在顶部 SEL）
└── net-hook.js      # MAIN world 网络钩子（document_start 注入）
sidepanel/           # 实时进度面板：每章状态、停止、重发失败、CSV 报告
_locales/            # i18n（zh_CN 默认 / en）
tests/               # *.test.cjs：logic 零依赖，其余基于 playwright
design/              # 设计稿与宣传图生成器（非扩展运行代码）
```

## 关键约束（改代码前必读）

- 本工具靠**模拟网页操作**驱动番茄真实 DOM（React + Arco Design + ProseMirror）；
  选择器集中在 `publisher.js` 顶部 `SEL`，番茄改版后对照实际页面调整，popup 有「选择器自检」定位坏点
- 受控组件必须派发 `input` 事件；富文本按段落塞 `<p>`；Arco 日期/时间组件只能模拟点击面板，直接写值无效
- 章节发布必须**串行**（一章完成再下一章），所有延迟走设置的操作节奏；遇平台安全验证必须暂停并交还用户
- 版本号三处同步：`manifest.json` 的 version 是唯一事实源

## 规则

@rules/coding-style.md
@rules/testing.md
@rules/security.md
@rules/git-workflow.md
@rules/frontend.md
