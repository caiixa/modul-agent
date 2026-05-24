# 🧠 Modul Agent

> 多模型协作运行时 — 让多个大模型在共享文件库上协同工作

## 核心概念

| 概念 | 说明 |
|------|------|
| **API 模型** | 云端大模型（DeepSeek / GPT / Claude），参与聊天思考 |
| **本机 Agent** | 本机 CLI 程序（Hermes / OpenClaw），持有工具负责执行 |
| **Hand** | 能力插件（文件操作 / Shell 命令 / 网络搜索等），绑定到本机 Agent |
| **Session** | 一个对话上下文，可搭配任意 API 模型 + 本机 Agent |
| **Orchestrator** | 调度器，决定谁来干活（广播/定向/串联/主模型） |

## 快速开始

```bash
# 安装依赖
npm install

# 启动 Web UI
node interfaces/ws-server.js config/default.json

# 打开浏览器
# http://localhost:18888
```

### Web UI 功能

| 页面 | 功能 |
|------|------|
| **💬 聊天** | 选会话、发消息、会话设置（⚙️ 选 API 模型 + Agent） |
| **🤖 API 模型** | 添加/删除云端大模型（DeepSeek、GPT、Claude…） |
| **🛠️ 工具管理** | 添加/删除本机 Agent，勾选绑定 Hand 插件 |
| **📋 会话** | 管理所有会话 |

## 架构

```
  用户输入（Web UI）
        │
┌───────┴────────┐
│   API 模型      │   ← 思考、聊天的（DeepSeek / GPT）
│   (聊天参与)     │
└───────┬────────┘
        │ 间接调度
┌───────┴────────┐
│   本机 Agent    │   ← 执行操作的（Hermes / OpenClaw）
│   (工具执行)     │
└───────┬────────┘
        │
┌───────┴────────┐
│   Hand 插件     │   ← files / shell / internet …
└────────────────┘
```

## 调度模式

| 模式 | 说明 |
|------|------|
| `broadcast` | 消息发给所有模型，都回复 |
| `direct` | `@模型名 消息` 指定发给谁 |
| `chain` | 按顺序执行，上一步输出=下一步输入 |
| `master` | 第一个模型当组长，分配任务 |

## 目录结构

```
hands/               # Hand 插件目录
  files/             # 文件读写操作
core/                # 核心引擎
  index.js           # 入口
  agent-registry.js  # 模型注册表
  session-manager.js # 会话管理
  hand-loader.js     # 插件加载器
  tool-executor.js   # 工具执行
  orchestrator.js    # 调度器
adapters/            # 模型通信适配器
  api-adapter.js     # API 模型
  cli-adapter.js     # CLI 模型
interfaces/          # 接入层
  ws-server.js       # Web 服务（HTTP + WebSocket）
  public/            # 前端页面
    index.html       # 管理面板
config/              # 配置文件
  default.json       # 默认配置
  agents.json        # 持久化的模型注册
```

## 开发

```bash
# 添加新 Hand：在 hands/ 下创建目录 + index.js
# 参考 hands/files/index.js

# 重启服务（Ctrl+C 后）
node interfaces/ws-server.js config/default.json
```
