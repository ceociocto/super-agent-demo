# Superagent · 本机控制台 + Colima 执行主机

第二版把代码执行移到 Colima 的 Linux VM：每次运行创建受限容器，实际跑代码、测试或资料处理，日志与产物回到 Mac 控制台。任务和每次运行分别持久化。

页面只保留 **任务、知识资料、运行环境**，可直接新建、追问、暂停、取消、重试、看日志/差异及验收。默认不调用付费模型，也不连接公司系统。

## 内部技术分享

14 页、25 分钟，包含 3 分钟代码演示和 2 分钟资料演示。

- [网页幻灯片](public/share/index.html)：启动项目后打开 http://127.0.0.1:4317/share/index.html，或点击控制台“技术分享”。
- [可编辑 PPTX](public/share/superagent-internal-talk.pptx)：逐页备注内含对应解说和来源。GitHub 文件页点击下载后用 PowerPoint / Keynote 打开。
- [完整解说稿](docs/internal-talk-script.md)：逐页时长、口播、演示操作卡、故障备用话术和 Q&A。
- [内容源](public/share/slides.json)：网页与 PPTX 共用的 14 页内容。
- [分享使用与维护说明](docs/internal-sharing.md)：投影、备注、重建 PPTX 和本次检查。

网页支持方向键 / 空格翻页、Home / End、目录跳转、全屏和打印全部页面。按 N 或点击“讲稿”显示当前页备注；镜像投屏时请关闭备注。页面需通过本地服务加载，无外部 CDN 依赖。

原始音视频、转写缓存、本机数据库及工作日志未上传仓库。保留的测试报告见 [docs/evidence](docs/evidence)。

## 启动

本机已具备 Node、Colima 和 Docker CLI。环境要求 Node.js 22.13+；启动脚本使用 Apple Silicon Mac 的 VZ 虚拟化。无需 npm install，没有第三方 npm 依赖。

```bash
cd super-agent-demo
npm run executor:start
npm run executor:build
npm start
```

打开 **http://127.0.0.1:4317**。

首次启动 Colima 需下载公开 Linux 镜像、初始化系统包；首次构建需下载公开 Node 基础镜像。后续复用本地镜像。执行任务使用 `--pull never`，容器无网络。

- 专用 Colima profile：`superagent-demo`；Docker context：`colima-superagent-demo`。
- 不切换既有 OrbStack/default context，不把用户 home 挂载到 VM，不转发 SSH agent。
- Mac 控制服务只监听回环地址；未设置开机启动、计划任务、Webhooks 或公网/局域网命令入口。
- 停止控制台：运行 npm start 的终端按 Ctrl+C。
- 停止执行主机：`colima stop superagent-demo`。此操作只停止本项目 profile。

## 直接演示

1. 新建“代码修复”任务，执行位置选 Colima。容器真实运行订单代码测试：修复前 2 通过 / 1 失败，修改源码后 3 通过。查看日志和差异，再验收。
2. 在“知识资料”导入或粘贴 Markdown/纯文本；新建知识任务并选取资料。容器实际检索正文和引用，无证据时明确说明。
3. 运行“资料报告”，按实际选取资料生成来源清晰的摘录报告。
4. 给任务补充要求：保留 task ID，新 run ID，旧产物不能被旧版本审批确认；历史运行下拉框可查看上一轮。
5. 查看运行环境；主机不可用时任务失败，不会回退为模板成功，恢复连接后可重试。

代码修复器是**真实运行的固定演练工作流**，不是能处理任意仓库的通用 AI coding agent。知识与报告是实际关键词检索/规则摘录，不是未经验证的模型推理。正文和资料中的命令不会作为 Shell 执行。

## 验证

```bash
npm test                 # 状态机、HTTP、provider、执行器协议与竞态测试；无需 VM
npm run test:executor   # 真实 Colima 集成验收；需已准备镜像
```

真实集成脚本检查 Docker 实际隔离参数，执行三场景、知识追问、无证据响应和创建阶段取消。结果见 [验收记录](docs/verification-v2.md)。

## 状态与数据

数据默认在 `data/demo.sqlite`，含任务原文、资料、资料快照、消息、run、日志和产物。资料最多 8,000 字符/篇，任务资料合计最多 128,000 字符；仅导入你愿意用于此本地演示的资料。

- 同 source + eventId 幂等；source + thread 对应同一任务。
- 默认新任务派发到 Colima，旧版任务保留原模式，不自动迁移、重跑或外发。
- 每次运行独立容器，日志、测试和当次产物保存后容器被清理。
- 暂停中止当前执行，恢复创建新 run；不是任意进程快照恢复。
- 控制端重启后，未知结果标为 interrupted/failed，先清理旧容器，再由人重试。
- 清理失败记录 cleanupPending；未确认清理不会启动新容器。创建请求结果不明时，单次“容器不存在”也不会解除阻塞，需人工诊断。
- 新跟进使旧运行结果失效；验收必须带当前已查看的 revision。
- 创建任务时资料做快照；后续修改资料列表不改变已存在任务的依据。

想用空白数据演示而不删除旧数据：

```bash
DEMO_DB_PATH=./data/new-demo.sqlite PORT=4318 npm start
```

不要同时启动多个控制进程共用同一数据库。当前是单进程实现，没有多控制器租约和分布式 exactly-once 保证。

## 可选真实模型

默认 Colima 工作流不调用模型。上一版本的“本地草案”模式仍保留 DeepSeek 适配器：自行安全设置环境变量 `DEEPSEEK_API_KEY`，然后：

```bash
MODEL_PROVIDER=deepseek DEEPSEEK_MODEL=deepseek-flash npm start
```

创建任务时需显式选择“旧版 · 本地草案”才使用当前配置的模型生成；Colima 固定工作流仍不调用模型。模型模式将该任务输入与合成资料发给 DeepSeek，只生成文本，无 Shell、检索或发布工具。UI 导入的知识资料用于 Colima 工作流；旧版本模型草案仍使用内置合成来源，未接入新知识库。未使用密钥实测模型质量与账单。调用超时、失败和截断明确失败，不降级伪造结果。取消只能控制本地接收与状态，不能保证供应商不计费。

## 主要代码

```text
public/                       精简操作台
server/index.js               回环 API、同源写入控制
server/engine.js              Task/Run/知识快照/SQLite/调度/审批
server/executor.js            Docker create/start、流式日志、超时/取消/清理
server/provider.js            可选 DeepSeek 文本适配器
runtime/worker.mjs            Linux 内固定代码修复、知识/报告工作流
runtime/query.mjs             保留历史主题的关键词检索
runtime/fixtures/             订单服务与真实 Node 测试
runtime/Dockerfile            Node Linux 镜像
scripts/start-executor.sh     专用 Colima profile 启动
scripts/setup-executor.sh     Worker 镜像构建
scripts/verify-executor.mjs   真实执行集成验收
tests/                       自动化回归
```

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/state` | 任务、run、日志、事件、通知和统计 |
| GET | `/api/tasks/:id` | 任务完整详情，含 runs 历史 |
| POST | `/api/events` | 创建或续办任务 |
| POST | `/api/tasks/:id/message` | 添加跟进上下文 |
| POST | `/api/tasks/:id/action` | pause/resume/cancel/retry/approve/reject |
| GET | `/api/executor` | 实际 Docker Linux 与镜像状态 |
| POST | `/api/executor/check` | 用户发起检查，不启动主机 |
| GET / POST | `/api/knowledge` | 列出/新增 Markdown 文本资料 |
| POST | `/api/knowledge/:id/delete` | 删除资料列表条目，既有任务快照保留 |

事件示例：

```json
{"eventId":"evt-001","source":"github","sourceThreadId":"issue-42","actor":"alice","scenario":"bugfix","executionTarget":"colima","text":"修复订单空结果并运行测试"}
```

知识任务可以传 `knowledgeIds:["KB-001"]`，不选表示全部。审批传 `{"action":"approve","expectedRevision":1}`，缺失版本400、过期409。模拟身份字段不是 SSO 或签名身份认证。

## 资料与边界

- [原片完整复核与时间点](docs/video-analysis-v2.md)
- [本版架构、实现范围与企业后续路径](docs/architecture-v2.md)
- [操作演示脚本](docs/demo-guide.md)
- [第一版研究快照](docs/research-and-feasibility.md)

Colima 提供独立 Linux 环境，但仍共享 Mac 的物理故障域。公司落地需再接真实仓库、企业模型与知识 ACL、身份连接器、受控写回及远程执行协议。当前无外部 Watchdog、跨平台多对多订阅、生产权限体系或高可用承诺。
