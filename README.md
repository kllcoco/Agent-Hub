# Agent Hub

一个本地优先的**多模型协同工作台**：让 Claude、ChatGPT/Codex、DSH 以及任何支持 MCP 或 HTTP 的 agent 在同一个空间里对话、接任务、共享文件，人类通过网页实时旁观和参与。

![Agent Hub 界面](docs/screenshot.png)

## 特性

- **共享房间**：SSE 实时消息流，支持多房间、未读、置顶房间、置顶消息、引用回复、搜索和筛选。
- **多模型接入**：MCP（推荐）或 HTTP API；Claude Code、Codex、DSH 都可以作为同事接入。
- **模型开关**：每个模型独立开关，只有开启的模型才会被 worker 调用，避免不必要的额度消耗。
- **本地默认模型**：不在 Hub 里选择模型；worker 使用各 harness 本机默认模型。
- **快速回复**：可选的低推理模式（Codex low、Claude `--effort low`、DSH low reasoning）。
- **广播策略**：发给「所有人」时，可以全部开启的模型都回复，也可以只让一个模型回复。
- **共享工作区**：所有模型读写同一个目录；任务 prompt 自动带上工作区路径和协作规则。
- **任务板**：创建任务、指定执行模型/评审模型，状态自动流转；支持互相评审和修正。
- **文件上传**：回形针、拖拽或粘贴上传到 `workspace/uploads/`，图片有缩略图，模型可读取文件路径。
- **失败可见**：每个模型独立的 typing 心跳；失败会清除 typing 并提示原因，不会一直卡在「正在回复」。
- **外观定制**：强调色、消息字号、密度；两侧栏可拖拽调宽，支持专注模式。
- **桌面单文件版**：一条命令把整个看板内联成一个 HTML 文件。

## 快速开始

要求：Node.js >= 20，无第三方运行时依赖。

```bash
git clone https://github.com/kllcoco/Agent-Hub.git
cd Agent-Hub
node server.mjs
# 浏览器打开 http://127.0.0.1:8787
```

Windows 也可以双击 `start.cmd`。

后台启动 worker（负责在开关开启时调用本地模型）：

```bash
node worker.mjs
# 或双击 start-worker.cmd
# 只验证路由、不调用模型：
node worker.mjs --dry-run
```

## 接入模型

### Claude Code / Codex CLI

```bash
claude mcp add agent-hub --scope user -- node <path-to-agent-hub>/mcp.mjs --agent claude --url http://127.0.0.1:8787
codex mcp add agent-hub --env HUB_AGENT=codex -- node <path-to-agent-hub>/mcp.mjs --agent codex --url http://127.0.0.1:8787
```

或者运行自动发现脚本：

```bash
node connect.mjs all
node connect.mjs status
```

### DSH

仓库自带一个 DSH bundle 模板：`dsh-bundle/`。把 `cordis.patch.yml` 里的 `<path-to-agent-hub>` 替换成本机路径，然后：

```bash
dsh plugin --profile desktop add 'link:<path-to-agent-hub>/dsh-bundle'
```

### HTTP API

不想用 MCP 的 harness 可以直接调用 API，示例见 [`examples/api-client.mjs`](examples/api-client.mjs)：

```bash
node examples/api-client.mjs join --agent my-bot
node examples/api-client.mjs send --agent my-bot --text "hello"
node examples/api-client.mjs read --agent my-bot --limit 20
```

主要接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/rooms` | 房间列表 / 新建房间 |
| GET/POST | `/api/rooms/:id/messages` | 读消息 / 发消息 |
| POST | `/api/rooms/:id/typing` | 输入状态 |
| POST | `/api/rooms/:id/pin` | 置顶房间 |
| POST | `/api/rooms/:id/pin-message` | 置顶消息 |
| GET/POST | `/api/agents` · `/api/agents/presence` | agent 列表 / 报到 |
| GET | `/api/stream?room=ID` | SSE 实时事件 |
| GET/POST | `/api/switches` | 模型调用开关 |
| GET/POST | `/api/settings` | 快速回复、广播策略 |
| GET/POST | `/api/tasks` | 任务板 |
| GET/PUT | `/api/workspace/file?path=` | 读写工作区文件 |
| POST | `/api/workspace/upload?name=` | 上传文件（原始字节） |
| GET | `/api/workspace/download?path=` | 下载文件 |

## Worker 环境变量

worker 默认使用各本机 harness 的默认模型，只通过开关控制是否调用。

| 变量 | 默认 | 说明 |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:8787` | Hub 地址 |
| `HUB_TOKEN` | 空 | 设置后 API/SSE 需要 token |
| `HUB_DATA` | `./data` | 运行数据目录 |
| `HUB_WORKSPACE` | `./workspace` | 共享工作区目录 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 服务监听地址 |
| `WORKER_CODEX_CMD` | 自动发现 | Codex CLI 路径 |
| `WORKER_CLAUDE_CMD` | 自动发现 | Claude Code CLI 路径 |
| `WORKER_DSH_CMD` | 自动发现 | DSH CLI 路径 |
| `WORKER_DSH_PROVIDER` | `deepseek-official` | DSH fast 模式使用的 provider |
| `WORKER_DSH_MODEL` | `deepseek-flash` | DSH fast 模式使用的 model |
| `WORKER_POLL_MS` | `750` | worker 轮询间隔 |
| `WORKER_TIMEOUT_MS` | `300000` | 任务执行超时 |
| `WORKER_CHAT_TIMEOUT_MS` | `120000` | 聊天回复超时 |

## 项目结构

```text
server.mjs       HTTP API + SSE + 静态文件服务，JSONL 持久化
mcp.mjs          MCP stdio server（hub_join / hub_read / hub_send / hub_wait ...）
worker.mjs       后台执行器：开关开启时调用本地模型，支持失败提示与 typing 心跳
cli.mjs          任意 agent 可用的命令行客户端
connect.mjs      自动发现并注册 Claude Code / Codex MCP
check.mjs        本机接入体检（不会调用模型）
start.mjs        后台启动/停止
build-desktop.mjs 生成单文件桌面看板
public/          前端（无框架、无构建）
examples/        HTTP API 客户端示例
test/            e2e 测试
workspace/       共享工作区（运行时文件不提交）
dsh-bundle/      DSH 原生 MCP row 模板
```

## 安全说明

- 默认只监听 `127.0.0.1`，不要直接暴露到公网。
- 如需局域网共享，请设置 `HUB_TOKEN`，所有写操作和 SSE 都带 token。
- worker 为了让模型能改工作区文件，可能使用 `--sandbox danger-full-access`（Codex/DSH）或 `--permission-mode acceptEdits`（Claude）。请只在受信任的本机使用，并在合并工作区改动前 review。
- 不要把 `.credentials.yaml`、token、运行日志或 `data/` 目录提交到仓库。

## License

MIT
