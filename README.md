# 🧠 Modul Agent

> 多模型协作运行时 — 让多个大模型在一个会话里协同工作

---

## 快速开始

```bash
# 安装依赖
npm install

# 启动 Web UI
node interfaces/ws-server.js config/default.json

# 打开浏览器
# → http://localhost:18888
```

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **Agent** | 可以是 API 模型（DeepSeek / GPT / Claude）或本机 CLI 代理（Hermes / OpenClaw） |
| **Hand** | 能力插件（文件操作 / Shell 命令 / 网页搜索 / MCP 等），挂载到 Agent 上 |
| **会话** | 一个对话上下文，可拉多个 Agent 进同一个会话 |
| **调度模式** | 决定 Agent 们如何协作（广播 / 串联 / 路由 / 辩论 / 工作流…） |

---

## 7 种调度模式

| 模式 | 说明 |
|------|------|
| `broadcast` 🎙️ | 消息发给所有 Agent，各自回复 |
| `direct` 🎯 | `@模型名 消息` 指定谁回复 |
| `chain` 🔗 | 按 Agent 列表顺序执行，上一步的输出 = 下一步的输入 |
| `master` 👑 | 第一个 Agent 当组长，分配任务给其他人 |
| `router` 📡 | 第一个 Agent 分析消息 → 智能分派给最合适的 Agent |
| `debate` 🗳️ | 所有 Agent 各自回答 → 第一个 Agent 当裁判投票选最佳 |
| `workflow` 🏭 | 按顺序流水线传递，每步有编号，最后输出最终产物 |

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                 Web UI (管理面板)                     │
│  💬 聊天  🤖 API模型  🛠️ 工具管理  📋 会话  📁 产出   │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼──────────────────────────────┐
│               interfaces/ws-server.js                │
│              HTTP 服务 + WebSocket 推送               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                     ModulAgent                       │
│              (core/index.js — 组装器)                  │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ AgentRegistry│  │SessionManager│  │ HandLoader │  │
│  │ 模型注册表    │  │ 会话管理      │  │ 插件加载器  │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                │                 │         │
│  ┌──────▼────────────────▼─────────────────▼──────┐  │
│  │           Orchestrator (调度器)                  │  │
│  │  broadcast / direct / chain / master           │  │
│  │  router / debate / workflow                    │  │
│  └──────┬──────────────────┬─────────────────────┘  │
│         │                  │                        │
│  ┌──────▼──────┐   ┌──────▼──────────┐              │
│  │ ApiAdapter  │   │  CliAdapter     │              │
│  │ API 模型通信  │   │  CLI 代理通信    │              │
│  └──────┬──────┘   └──────┬──────────┘              │
└───────────────────────────┼──────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
    ┌────────────┐   ┌──────────────┐   ┌────────────┐
    │ API 模型    │   │ CLI 代理      │   │ Agent 通信  │
    │ DeepSeek   │   │ Hermes       │   │ A→B互问    │
    │ GPT/Claude │   │ OpenClaw     │   │            │
    └────────────┘   └──────┬───────┘   └────────────┘
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
          ┌────────┐  ┌──────────┐  ┌──────────┐
          │ files  │  │  shell   │  │web-search│
          │ 文件操作 │  │ 命令执行  │  │ 网页搜索  │
          └────────┘  └──────────┘  └──────────┘

               ┌──────────────────┐
               │   MCP Hand       │  ← 社区 MCP 协议插件
               │ (GitHub / Notion │
               │  / DB / Slack…)  │
               └──────────────────┘
```

---

## 目录结构

```
modul-agent/
├── core/                     # 核心引擎
│   ├── index.js              # 入口 — 组装所有组件
│   ├── agent-registry.js     # 模型注册表 — 增删改查 API/CLI Agent
│   ├── session-manager.js    # 会话管理 — 创建/恢复/持久化
│   ├── hand-loader.js        # Hand 插件加载器 — 扫描 + 加载 + 工具分发
│   ├── tool-executor.js      # 工具执行器 — 模型 tool_calls → Hand 执行
│   ├── orchestrator.js       # 调度器 — 7 种调度模式 + Agent 间通信
│   └── mcp-client.js         # MCP 协议客户端 — stdio 连接 MCP Server
│
├── adapters/                 # 模型通信适配器
│   ├── api-adapter.js        # API 模型适配器（OpenAI 兼容接口 + 流式）
│   └── cli-adapter.js        # CLI 代理适配器（子进程执行）
│
├── hands/                    # Hand 插件目录（每个目录一个 Hand）
│   ├── files/                # 文件操作（读写/搜索/列表/补丁）
│   ├── shell/                # Shell 命令执行（带安全沙箱）
│   ├── web-search/           # 网页搜索 + 网页抓取
│   ├── agent-chat/           # Agent 间通信（A 向 B 提问）
│   └── mcp/                  # MCP 协议接入（社区工具生态）
│
├── interfaces/               # 接入层
│   ├── ws-server.js          # HTTP + WebSocket 服务器
│   └── public/
│       └── index.html        # 深色管理面板 Web UI
│
├── config/                   # 配置文件
│   ├── default.json          # 默认 Agent 配置
│   ├── agents.json           # 持久化的 Agent 注册（自动生成，不提交 Git）
│   └── mcp-servers.json      # MCP 服务器配置
│
├── outputs/                  # 会话产出目录（自动生成，不提交 Git）
├── sessions.json             # 会话持久化文件（自动生成，不提交 Git）
├── package.json
└── README.md
```

---

## Hand 插件规范

每个 Hand 插件是一个放在 `hands/<name>/index.js` 的 Node.js 模块。

### 基本结构

```js
const myHand = {
  // 必需：Hand 名称，用于绑定到 Agent
  name: 'my-hand',

  // 可选：描述（仅日志展示用）
  description: '我的能力插件',

  // 必需：工具定义字典
  tools: {
    my_tool: {
      // 工具描述（模型会看到这个）
      description: '描述这个工具做什么',

      // 参数定义
      parameters: {
        param1: { type: 'string', description: '参数说明' },
        param2: { type: 'number', description: '数字参数', default: 5 },
      },

      // 执行函数（async 或普通）
      execute: async (params) => {
        // params 会自动注入:
        //   params.sharedDir  — 会话产出目录路径
        //   params.outputDir  — 同上（旧兼容）
        //   params.session    — 会话对象（含 _orchestrator 供 agent_chat 用）

        return { result: '执行成功' };   // ✅ 成功
        // return { error: '出错了' };   // ❌ 失败
      },
    },
  },

  // 可选：异步初始化（启动时后台执行，不阻塞）
  async init() {
    // 连接服务、拉取配置等
  },
};

module.exports = myHand;
```

### 参数自动注入

工具执行时，框架会自动注入以下参数到 `params` 对象中：

| 参数 | 来源 | 说明 |
|------|------|------|
| `sharedDir` | 会话配置 | 当前会话的产出目录路径 |
| `outputDir` | 会话配置 | 同 `sharedDir`（兼容旧版） |
| `session` | 工具执行器 | 会话对象，含 `_orchestrator` 和 `_callingAgent` |

你的 execute 函数**不需要**在 `parameters` 中定义这些，框架自动注入。

### 返回值格式

| 情况 | 格式 |
|------|------|
| ✅ 成功 | `{ result: '文本或对象' }` |
| ❌ 失败 | `{ error: '错误消息' }` |
| ⚠️ 部分成功 | `{ result: '部分结果', error: '警告信息' }` |

`result` 可以是任意类型（string/object/array），会被序列化后返回给模型。

### 现有 5 个 Hand 一览

| Hand | 工具数 | 特点 |
|------|--------|------|
| **files** | 6 个 | 读写/搜索/列表/补丁文件，无外部依赖 |
| **shell** | 1 个 | Shell 执行，带安全黑名单 + 超时控制 |
| **web-search** | 2 个 | 连接 SearXNG 搜索 + 网页抓取 |
| **agent-chat** | 1 个 | 跨 Agent 通信，利用 `session._orchestrator` |
| **mcp** | 动态 | `init()` 异步连接 MCP Server，动态构建工具列表 |

---

## MCP 协议集成

Modul Agent 支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 标准，可以接入社区成千上万的 MCP 插件。

### 配置方法

编辑 `config/mcp-servers.json`：

```json
[
  {
    "name": "github",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "你的 GitHub Token"
    }
  }
]
```

启动后，MCP Hand 会自动连接服务器，将所有 MCP 工具注册为带 `mcp_` 前缀的 Hand 工具，绑定到 Agent 即可使用。

### 传输方式

| 方式 | 说明 | 状态 |
|------|------|------|
| `stdio` | 通过子进程连接 | ✅ 已实现 |
| `sse` | HTTP Server-Sent Events | 🔜 计划中 |

---

## Agent 间通信

绑定了 `agent-chat` Hand 的 Agent 可以使用 `agent_chat` 工具，向会话中的其他 Agent 提问：

```
工具: agent_chat(target_agent="deepseek", question="帮我审查一下这段代码")
```

这允许模型之间进行协作讨论、交叉验证和代码审查。

---

## 配置

### config/default.json

```json
{
  "agents": {
    "deepseek": {
      "type": "api",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com",
      "hands": ["files", "shell", "web-search"]
    },
    "hermes": {
      "type": "cli",
      "command": "hermes run '{input}'",
      "hands": ["files", "shell"]
    }
  }
}
```

### 模型类型说明

| 类型 | 说明 | 典型例子 |
|------|------|----------|
| `api` | 云端大模型 API | DeepSeek, GPT, Claude, 阿里云百炼 |
| `cli` | 本机 CLI 代理 | Hermes, OpenClaw, Codex CLI |

### Hand 绑定

Agent 的 `hands` 数组控制它拥有哪些能力。多个 Agent 可以绑定不同的 Hand 组合，实现能力隔离。

---

## 开发

```bash
# 添加新 Hand：在 hands/ 下创建目录 + index.js
# 参考 hands/files/index.js 的规范格式

# 重启服务
node interfaces/ws-server.js config/default.json
```

---

## 技术栈

- **运行时**: Node.js (纯 JS，无 TypeScript)
- **唯一依赖**: `ws` (WebSocket)
- **前端**: 纯 HTML/CSS/JS，深色管理面板风格
- **API 通信**: fetch + SSE 流式读取
- **CLI 通信**: 子进程 execSync
- **持久化**: JSON 文件（`agents.json` + `sessions.json`）
