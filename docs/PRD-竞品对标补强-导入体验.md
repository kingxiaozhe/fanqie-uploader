# PRD：对标竞品补强「导入体验」（GBK 编码 + ZIP 一键导入）

- 日期：2026-07-19　状态：待评审 / 未开发
- 类型：功能补强（brownfield 增量，非重构）
- 竞品依据：番茄小说注入神器（Chrome 商店 `nbggfalnkmdefibjbmhfmmfgapokgbcl`，v2.2，
  145 装机，0 评价，22.74 MiB，开发者 xiangdongli/智通）。其公开卖点为
  **ZIP 压缩包一键解压导入** + **章节智能识别** + **UTF-8/GBK 双编码**；
  但止步于「把内容注入编辑器」，无发布/定时/排期能力。
- 一句话定位：**竞品的长板全在「导入入口体验」，短板在「发布自动化」。**
  本 PRD 只做一件事——把竞品在入口侧唯二实打实领先的点（GBK、ZIP）补平，
  让本工具在「导入门槛」上不落下风，继续用发布自动化拉开差距。

---

## 1. 背景与问题

现状核查（源码为证）：

- 入口：`popup/popup.html:153` `<input webkitdirectory>` 选**文件夹**，
  `popup/popup.js:258` 过滤 `.txt/.md/.markdown`。
- 读取：`popup/popup.js:272` `const raw = (await f.text())` ——
  `File.text()` **固定按 UTF-8 解码**。

由此两个真实缺口：

1. **GBK/GB2312 编码的 txt 会整章乱码**。国内老作者、从旧编辑器/记事本导出的稿子
   大量是 GBK。竞品明确支持双编码，本工具当前不支持 → 直接劝退这批用户。
2. **只能选文件夹，不支持 ZIP**。竞品「拖一个 zip 进来一键解压」入口更轻；
   本工具要求用户先解压到文件夹再选，多一步。

## 2. 目标 / 非目标

**目标**
- G1（P0）：正确读入 GBK/GB2312 编码的章节文件，中文不乱码。
- G2（P1）：支持选择 / 拖入 `.zip`，自动解压其中的 `.txt/.md`，与选文件夹等价接入现有解析流水线。

**非目标**
- 不做 rar/7z（格式复杂、需重型依赖，违背零依赖红线）。
- 不改发布/排期/调度逻辑（本 PRD 只碰 `popup` 导入层）。
- 不做 docx/pdf 正文抽取（另开需求）。
- 不引入任何第三方运行时库（zip/编码全部走浏览器原生 API + 手写解析）。

## 3. 关键约束（继承项目红线）

- **零依赖**：不得引入 jszip/iconv 等库。GBK 用原生 `TextDecoder('gbk')`；
  ZIP 的 DEFLATE 用原生 `DecompressionStream('deflate-raw')`，ZIP 目录结构手写解析。
- **权限零变更**：两项功能都只处理用户本地主动选择的文件，**不新增任何
  `permission` / `host_permission` / content_script 注入范围**。→ 无需改 `manifest.json`
  权限段，无需改 `PRIVACY.md` 权限声明（数据仍全程本地、不上传，与现有承诺一致）。
- **分层不越界**：改动集中在 `popup/`（选文件夹、解析章节是 popup 职责）；
  `content/*`、`background.js` 不动。
- **可测**：编码探测、ZIP 解析拆成**顶层具名纯函数**，进 `tests/logic.test.cjs`
  （TextDecoder / DecompressionStream 在 Node 亦可用，可喂已知字节序列断言）。

## 4. 功能需求

### FR-1（P0）编码自适应：UTF-8 优先，GBK 兜底

**方案**
- 把 `await f.text()` 改为读 `ArrayBuffer`，走「探测 + 解码」纯函数 `decodeChapterBytes(buf)`：
  1. **BOM 优先**：`EF BB BF`→UTF-8；`FF FE`/`FE FF`→UTF-16LE/BE，按对应 TextDecoder 解。
  2. 无 BOM：先 `new TextDecoder('utf-8', { fatal: true })` 严格解码；
     抛错（存在非法 UTF-8 字节序列）→ 判为非 UTF-8，回退 `new TextDecoder('gbk')`（Chrome 的 gbk 标签映射 GB18030 解码器，覆盖 GB2312/GBK）。
  3. 两者都可疑时以「乱码率」（U+FFFD 占比）择优：UTF-8 严格解码不抛错即采信；抛错才用 GBK。
- 解出的文本继续走现有 `splitTitleBody` / `numFromName` / `numFromText`，下游零改动。

**验收标准**
- AC-1.1：一份 GBK 编码、含中文标题与正文的 txt，导入后标题/正文/字数正确，无 `�`。
- AC-1.2：UTF-8（含/不含 BOM）文件行为与现在完全一致，无回归。
- AC-1.3：UTF-16LE（Windows 记事本"Unicode"另存）文件正确读入。
- AC-1.4：解码失败/空文件走现有空正文兜底（不崩溃，该章可被 `minWords` 过滤）。

**测试（logic.test.cjs 新增）**
- `decodeChapterBytes`：喂「你好世界」的 UTF-8 字节 / GBK 字节 / UTF-8+BOM / UTF-16LE，
  断言均解回「你好世界」；喂一段合法 UTF-8 断言不误判成 GBK（边界：纯 ASCII、
  中英混排、GBK 里恰好合法的 UTF-8 子串）。

**风险**
- 极端：某些 GBK 文本恰好是合法 UTF-8 字节序列 → 误判为 UTF-8。概率极低（中文 GBK
  双字节高位多不构成合法 UTF-8 连续字节），且 `fatal:true` 严格模式能拦住绝大多数。
  文档标注为已知边界；后续可加「导入预览首章」让用户肉眼确认（见开放问题 Q1）。

### FR-2（P1）ZIP 一键导入

**方案（零依赖手写）**
- `popup.html` 的 `accept`/入口扩展为同时接受 `.zip`；`onFolderPicked` 分流：
  是 zip → `parseZip(arrayBuffer)`，否则走现有文件夹逻辑。
- `parseZip` 纯函数（手写，约 120~150 行，超 40 行/函数上限须内部再拆
  `readEOCD` / `readCentralDir` / `inflateEntry`）：
  1. 从尾部找 EOCD（End of Central Directory，签名 `50 4B 05 06`）定位中央目录。
  2. 遍历中央目录条目，取文件名（按 FR-1 的编码探测解文件名，兼容 GBK 文件名 zip）、
     压缩方法、偏移。
  3. 定位 local header，取压缩数据：method 0（STORED）直接取；method 8（DEFLATE）
     走 `new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))`
     解压。
  4. 仅保留 `.txt/.md/.markdown`，跳过目录项与 `__MACOSX/`、隐藏文件。
  5. 输出 `[{ name, bytes }]`，每项再过 `decodeChapterBytes`（复用 FR-1），
     汇入现有 `files` 流水线（排序、splitTitleBody 等一律复用）。
- `folderName`（= 书名）取 zip 文件名去扩展名。

**验收标准**
- AC-2.1：一个含 9 个 `.txt` 的 zip（STORED 与 DEFLATE 各覆盖），导入后 9 章齐、
  顺序按章号、标题/正文正确。
- AC-2.2：zip 内混有非章节文件（封面.jpg、readme）与子目录，正确忽略、只收章节。
- AC-2.3：zip 内为 GBK 编码 txt（且文件名为 GBK）→ 正文与文件名均不乱码。
- AC-2.4：非法/损坏 zip → 友好报错提示，不崩溃、不影响已加载内容。

**测试（logic.test.cjs 新增）**
- `parseZip`：内置一个最小 STORED zip 的字节数组常量（几十字节），断言解出条目名与内容；
  DEFLATE 分支因依赖 DecompressionStream（异步流），在 Node 18+ 可用，作异步断言；
  不可用环境按现有惯例跳过并记原因（参照 run.sh 对 playwright 的处理）。

**风险 / 权衡**
- 手写 ZIP 解析有复杂度（EOCD64、加密、分卷不支持——本 PRD 明确只支持
  单卷、未加密、method 0/8，其余给明确报错）。这是为守「零依赖」卖点付的成本，
  但换来的是与竞品同级的入口体验且无第三方供应链风险，符合安全定位。

## 5. 非功能 / 体验

- 拖拽导入（把文件夹或 zip 拖到 popup）：**可选增强**，与 FR-2 同批做性价比高，
  但不阻塞主需求，列为 P2。
- 导入进度：解压/解码大 zip 时 popup 显示「读取中…」（现有 `btn.textContent="读取中…"`
  已有雏形，复用）。

## 6. 版本与文档同步（合入前置）

- 版本号：功能合入后 `manifest.json` `1.8.1 → 1.9.0`（新增功能，minor），单独提交。
- 文档：`README.md` / `FEATURES.md` 导入章节补「支持 ZIP 一键导入」「自动识别
  UTF-8/GBK/UTF-16 编码」；`docs/fixes/` 不适用（这是新功能非修复），
  本 PRD 落 `docs/`，开发完成后可加一条 `docs/` 开发记录。
- `PRIVACY.md`：**无需改**（权限与数据流未变，仍全程本地）。仅可选地补一句
  「ZIP 仅在浏览器内存解压，不落盘、不上传」对齐竞品话术、强化信任。

## 7. 优先级与里程碑

| 阶段 | 内容 | 优先级 | 依赖 |
|---|---|---|---|
| M1 | FR-1 编码自适应（GBK/UTF-16 兜底）+ 回归测试 | **P0** | 无 |
| M2 | FR-2 ZIP 一键导入（复用 M1 解码）+ 回归测试 | P1 | M1 |
| M3 | 拖拽导入 + 文档/版本同步 | P2 | M2 |

建议先单独交付 M1：改动小、风险低、直击「GBK 乱码」这个会**当场劝退用户**的硬伤，
ROI 最高；M2 作为紧随其后的入口体验补强。

## 8. 开放问题（需你拍板）

- Q1：是否要「导入后首章预览」让用户肉眼确认编码/章节切分对不对？
  （能兜住 FR-1 的极端误判风险，但增加一屏 UI。建议 M1 先不做，观察反馈。）
- Q2：ZIP 内**单文件整本、按分隔符切章**是否要支持？（有的作者一个 zip 里就一个大 txt，
  靠"第N章"分隔。竞品是否支持未知。若要，需在 FR-2 后接一个"单文件切章"子需求。）
- Q3：M1 与 M2 是否分两次上架发版，还是攒到 1.9.0 一起发？

## 9. 明确不做（防镀金）

- 不抄竞品的 22.74 MiB 打包形态——继续零依赖，体积是我们的信任优势。
- 不因为"竞品声称开源"就改开源策略；真实源码 + 测试本就是我们的差异化，属营销而非本 PRD。
