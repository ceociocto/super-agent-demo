# 内部技术分享材料

## 使用

启动 `npm start` 后，打开 http://127.0.0.1:4317/share/index.html 。也可从任务控制台点击“技术分享”。

- 共 14 页，建议 25 分钟，含研发演示 3 分钟、资料演示 2 分钟及末页讨论。
- 方向键 / 空格翻页，Home / End 到首尾，目录按钮快速跳页。
- 按 N 或点击“讲稿”显示逐页备注。备注与幻灯片在同一个窗口，镜像投影时请关闭。
- “打开演示控制台”切到实际操作页，幻灯片用 hash 保留页码。
- 下载 PPTX 可离线编辑与演讲。网页自身通过本地 HTTP 服务读取内容，没有外部 CDN。
- “打印 / PDF”按全部 14 页打印，讲者备注和操作栏不进入打印内容。

[解说稿](internal-talk-script.md) 包含逐页口播、时间安排、演示前准备、合成资料、故障备用话术和 Q&A。

## 内容维护

`public/share/slides.json` 是网页与 PPTX 的共同内容源。改动后网页刷新即可生效；PPTX 需要重新生成。Markdown 解说稿的逐页正文应同步 JSON，演示操作卡和 Q&A 独立保留。`docs/internal-talk-script.md` 与下载版 `public/share/speaker-script.md` 内容应一致。

构建器 `scripts/build-talk.mjs` 使用 Codex 配套的 `@oai/artifact-tool` 与验证器，不属于运行控制台所需的依赖。设置以下环境变量后，使用配套 Node 执行该脚本：

- `RUNTIME_NODE_MODULES`：配套 node_modules 目录。
- `PRESENTATION_SKILL_DIR`：Presentations 技能目录，含 container_tools 验证器。
- `RUNTIME_PYTHON`：配套 Python 可执行文件。
- `TALK_FONT`：可选，默认 PingFang SC，需已安装。

脚本会生成可编辑的 16:9 PPTX、每页 PNG 和结构/布局验证报告。构建临时文件放在被 Git 忽略的 work 目录，最终 PPTX 放在 public/share。

## 本次验证（2026-11-07）

- 内容为 14 页，时长合计 1500 秒，14 页均含解说与来源。
- PPTX 文件结构、字体策略、布局几何、重新导入验证通过，0 findings / warnings。
- 14 页均已渲染检查；主 agent 另核对代表页与实际备注 XML，确认与 JSON 解说一致。
- 网页 14 页边界检查无溢出；翻页、Home、目录、备注、全屏、打印样式、390px 宽度检查通过。
- Markdown 下载与原稿逐字节一致，PPTX 浏览器下载 SHA-256 与原文件一致。项目回归测试 47/47 通过。

PPTX 使用 PingFang SC，未在原生 PowerPoint 应用实测。其他操作系统可能替换字体，正式投影前应在演讲电脑打开检查。网页可作为已检查布局的备用播放方式。

这套材料讲解的是实际固定工作流的机制验证。未声称完成任意仓库自主编码、企业身份/知识 ACL、真实模型业务评测或生产高可用部署。
