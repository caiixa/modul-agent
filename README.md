# 🧠 Modul Agent

> 多模型协作运行时 — 让多个大模型在共享文件库上协同工作

## 核心概念

| 概念 | 说明 |
|------|------|
| **Agent** | 一个模型实例（DeepSeek / Claude / Hermes / OpenClaw …） |
| **Hand** | 能力插件（文件操作 / 网络搜索 / 命令行 / 看图 …） |
| **Session** | 一个对话上下文，可往里拉任意 Agent |
| **Orchestrator** | 调度器，决定谁来干活 |

## 快速开始

```bash
# 安装依赖
npm install

# 配置模型
cp config/example.yaml config/my-team.yaml
# 编辑 config/my-team.yaml，填入 API key

# 启动 CLI
node core/index.js config/my-team.yaml
```

### CLI 会话示例

```
> create 我的研究小组
✅ 会话创建: a1b2c3d4

> join a1b2c3d4
📌 进入会话: 我的研究小组

> send 分析 shared/data.csv 中的数据趋势
🤔 发送: 分析 shared/data.csv 中的数据趋势

  💬 deepseek: 数据趋势分析如下...
  💬 claude: 从另一个角度看...
```

## 架构

```
入口（CLI / WebSocket / API）
        │
  Session Manager ── Agent Registry
        │                │
  Orchestrator ────  Hand Loader
        │                │
  Tool Executor ────  files / internet / shell ...
        │
  共享文件库（/shared）
```

## 调度模式

| 模式 | 说明 |
|------|------|
| `broadcast` | 消息发给所有 Agent，都回复 |
| `direct` | `@agentName 消息` 指定发给谁 |
| `chain` | 按顺序执行，上一步输出=下一步输入 |
| `master` | 第一个 Agent 当组长，分配任务 |

## 开发

```bash
# 目录结构
hands/              # 能力插件
  files/            # 文件读写
  internet/         # 网络搜索
  shell/            # 命令行执行
core/               # 核心引擎
  index.js          # 入口
  agent-registry.js # 模型注册表
  session-manager.js# 会话管理
  hand-loader.js    # 插件加载器
  tool-executor.js  # 工具执行
  orchestrator.js   # 调度器
adapters/           # 模型通信适配器
  api-adapter.js    # API 模型
  cli-adapter.js    # CLI 模型
interfaces/         # 接入层
  cli.js            # 命令行
  ws-server.js      # WebSocket
```
