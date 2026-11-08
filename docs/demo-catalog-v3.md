# 可直接复制的演示任务清单

核对日期：2026-11-08。下面是演示输入，不是固定执行分支；Router/Worker 根据实际仓库与工具结果决定步骤。已读取 issue 正文、评论和当前状态；本清单编写时未逐个复现或修复。公开项目可能随时更新，执行时先核查，不保证仍有缺陷。

## 自有仓库：面向普通观众的首选

已准备两个可直接修改并交付PR的目标项目：[咖啡店购物车与出行清单](demo-target-projects.md)。推荐以它们为演示主线；下方第三方项目用于进阶选题。

## GitHub 可选问题

### G1 · 首选：德语城市名被错误拆词

项目：sindresorhus/slugify，Node.js 字符串短名库。
来源：https://github.com/sindresorhus/slugify/issues/85

完整问题转述：默认开启 decamelize 时，字符转写先把 Ü/Ö/Ä/Æ 替换为多字母组合，随后大小写边界识别把正常单词误当成驼峰词拆开。issue 报告 4.0.0 与当时 main 均有问题。需要同时覆盖普通大小写、真正的驼峰词和关闭 decamelize 的情况，避免修复破坏原功能。

| 输入 | issue 报告的实际输出 | 期望 |
| --- | --- | --- |
| MÜNCHEN | m-ue-nchen | muenchen |
| ÜBER UNS | ue-ber-uns | ueber-uns |
| GRÜNE ÄPFEL | gr-ue-ne-ae-pfel | gruene-aepfel |
| DIE GRÖSSTE | die-gr-oe-sste | die-groesste |
| Ægir | a-egir | aegir |

复制到总聊天：

```text
处理真实公开问题 https://github.com/sindresorhus/slugify/issues/85 。先读取正文、评论和关联 PR，记录检出的 commit，实际复现 MÜNCHEN、ÜBER UNS、GRÜNE ÄPFEL、DIE GRÖSSTE、Ægir 的拆词错误。期望分别为 muenchen、ueber-uns、gruene-aepfel、die-groesste、aegir。若当前版本仍有问题，调查字符转写与 decamelize 的顺序及边界，做最小修复，增加上述用例以及普通大小写、真正驼峰词、decamelize:false 的回归测试，运行相关测试。交付中文说明、实际 diff、测试日志与复现前后结果。若已修复，指出修复证据并验证，不制造重复修改。本次先在任务工作副本完成，不向上游发 PR。
```

验收：实际测试失败→修复后通过；diff 和日志可查看。预计难度较低只是选题判断，未测量完成时长。

### G2 · 备选：泰语/老挝语终端表格列宽不齐

项目：sindresorhus/string-width，Node.js 终端字符串宽度库。
来源：https://github.com/sindresorhus/string-width/issues/82

完整问题转述：issue 报告 8.3.0 中 `คำ` 与老挝语 `ຄຳ` 返回宽度 1，期望 2；泰语等价分解形式 `ค\u0E4D\u0E32` 已返回 2，导致显示相似的文本算出不同列宽。报告者认为 U+0E33/U+0EB3 的 Unicode 字素分组属性与通常使用的字符类别不同，现有逻辑漏计宽度。该原因与建议修复都需由 Worker 核对，不能直接照抄。

```text
处理 https://github.com/sindresorhus/string-width/issues/82 。读取正文、评论和关联 PR，记录实际 commit 与运行环境，复现 stringWidth('คำ')、stringWidth('ค\u0E4D\u0E32')、stringWidth('ຄຳ')，期望都为2。核对 Unicode 分类与当前实现，若缺陷仍存在则做最小修复，增加泰语、老挝语及 ASCII、中文、emoji、组合字符的回归检查。生成 before-after.md，包含真实结果和一张按计算列宽对齐的文本表格；运行项目测试并保留日志。若已修复则验证并说明。本次在任务工作副本交付 diff，不向上游发 PR。
```

验收：三项结果、边界测试及表格来自真实命令执行。当前机器对 G1/G2 上游均只有读取权限；需要外部交付时，下一步可明确要求推到自己的 fork，或指定有写权限的演示仓库。

### G3 · 复核型：问题显示开放，但已有版本修复声明

项目：tj/commander.js，Node.js 命令行参数解析库。
来源：https://github.com/tj/commander.js/issues/2651

完整问题转述：父命令通过 setOptionValue 设置 common=parent、子命令从 CLI 接收 common=child 时，optsWithGlobals 的最终值来自父命令，但 getOptionValueSourceWithGlobals 仍报告被覆盖的子值来源 cli。期望来源与最终有效值一致，此处为 undefined。issue 仍开放，但维护者评论称已在 15.1.0 发布修复，因此它适合版本验证，不能当成确认未修复的 bug。

```text
核验 https://github.com/tj/commander.js/issues/2651 。先读取正文和全部评论，注意维护者提到15.1.0已修复。用issue的父子命令与setOptionValue复现方式比较15.0.0、15.1.0和当前默认分支，逐项记录optsWithGlobals().common与getOptionValueSourceWithGlobals('common')。查找对应修复commit/PR，生成中文版本对比报告和可重跑脚本，说明问题是否仍存在。不修改上游、不创建重复PR；依赖或版本无法获取时如实报告。
```

验收：报告应识别“开放状态不等于尚未修复”，并有真实版本运行证据。

## 六段具体演示

### 1. GitHub 调查、修复与交付

从 G1/G2 任选其一，整段复制。展示 Router 创建任务、Worker 阅读源码/测试、命令与文件产物。需要真实 GitHub 写入时，再明确输入：

```text
把刚才已经验证的修复推送到我自己的fork并创建草稿PR。先检查已有fork、同分支和已有PR避免重复；当前用户对上游没有写权限时使用自己的fork。PR写清复现、修复和实际测试结果，关联原issue，返回真实链接；不要合并。
```

这一步会真实公开提交贡献，只在你确实要交付修复时使用。

### 2. 修复同时，安排个人资料任务

G1 运行中提交：

```text
另外开一个独立任务：阅读 https://github.com/sindresorhus/slugify 的README和 https://github.com/sindresorhus/string-width 的README，给我整理中文选型卡selection.md：两者分别解决什么问题、安装和最小使用例子、运行环境、常见使用场景、与本次两个issue的关系，附来源链接。资料里没写的不要猜。不要修改仓库。完成后交付可下载文件，不需要等修复任务。
```

观察两个 Task 的执行区间；是否真正重叠以 Run 时间与工具事件为准。

### 3. 给原修复任务追加要求

```text
给刚才处理slugify #85的原任务补充：把 MüNCHEN、München、fooBar 三项也加入回归检查，解释修复为什么不会破坏真正的驼峰词拆分。继续原Task，不要重复开任务或创建PR，更新原来的交付说明。
```

若选 G2，改为：“给 string-width #82 原任务追加中文、家庭 ZWJ emoji 与 e+组合重音的回归，更新原报告”。观察 Task ID 保持一致。

### 4. 长日志与精确回查（可独立运行）

```text
帮我整理一份本机字符处理诊断报告：生成2000条ASCII、中文、泰语、emoji混合样本，编号从1开始；把第1739条明确标记为 CHECK-1739。实际运行脚本计算并打印每条的样本编号、原文与Unicode码点，完整输出保存到diagnostics.log，脚本也保留。不要把2000行直接塞进聊天。完成后给我文件和简短统计。
```

完成后补充：

```text
继续刚才的诊断任务，从保存的完整日志按需读取CHECK-1739前后各两条记录，原样引用这5条，核对编号与Unicode码点，把证据写入evidence.md。请真正读取文件，不从摘要猜测。
```

这是可控的诊断数据任务，用于展示日志外置和分页；不冒充真实生产故障。

### 5. 停止后核查已有产物再继续（可独立运行）

```text
新建一个可中断的本机批处理任务：编写脚本分30批生成batch-01.json至batch-30.json，每份含批次号和50条Unicode样本。每批完成后打印进度并等待2秒。已经存在且内容有效的批次必须跳过。保留脚本和完整日志，全部结束后生成manifest.json列出每批SHA-256。直接执行长命令，由工具管理后台作业，不要用shell的&自行脱离运行。
```

看到文件产生且命令仍在运行后点“停止”，再补充：

```text
继续这个原任务，先检查已有批次并记录其校验值，跳过有效文件，从缺失或无效批次续做。最终生成manifest.json和recovery.md，说明停止前已有几批、此次补了几批、哪些原文件校验值未变。不要把重新全量生成说成恢复。
```

可在停止后重启服务，再执行同一补充。验收 Task 保留、新 Run 建立、文件校验值真实一致；这是任务级续办。

### 6. 网页与终端共同修改交付文件

网页提交：

```text
阅读本项目README.md，生成中文demo-checklist.md：包含Node环境、模型配置、启动、GitHub登录、网页与MCP入口、现场验收步骤。只读取文档，保存到自己的任务目录；不读取.env或密钥。每项给出实际文档依据，完成后提供下载。
```

从页面复制真实 Task ID，在已启动服务的本机终端执行：

```sh
node scripts/client.mjs followup task_ID '在原demo-checklist.md末尾追加“现场换模型”：列出MODEL_BASE_URL、MODEL_NAME、密钥变量引用、重启和test:model检查。保留原文，交付更新后的同一文件。'
```

也可由 MCP 客户端调用 followup_task，参数 taskId 为同一 ID、text 为上述补充。观察网页同 Task 新 Run，再下载文件核对新增段落。

## 现场顺序

推荐先用 G1，运行中插入场景2，再补充场景3；随后用4、5、6展示长日志、恢复和多入口。G2是备选修复题，G3是核验题，不需要一场演示全部执行。选题清单不是通过质量评测的保证，现场结果以真实执行证据为准。
