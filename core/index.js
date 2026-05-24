// ============================================================
// Modul Agent — 多模型协作运行时
// ============================================================
// 入口文件，组装所有核心组件
// ============================================================

const AgentRegistry = require('./agent-registry.js');
const SessionManager = require('./session-manager.js');
const HandLoader = require('./hand-loader.js');
const ToolExecutor = require('./tool-executor.js');
const Orchestrator = require('./orchestrator.js');
const ApiAdapter = require('../adapters/api-adapter.js');
const CliAdapter = require('../adapters/cli-adapter.js');

class ModulAgent {
  constructor(options = {}) {
    this.options = {
      sharedRoot: options.sharedRoot || './shared',
      handsDir: options.handsDir || '',
      ...options,
    };

    // 初始化组件
    this.registry = new AgentRegistry();
    this.sessions = new SessionManager({ sharedRoot: this.options.sharedRoot });
    this.hands = new HandLoader(this.options.handsDir);
    this.tools = new ToolExecutor(this.hands);
    
    const apiAdapter = new ApiAdapter();
    const cliAdapter = new CliAdapter();
    
    this.orchestrator = new Orchestrator({
      agentRegistry: this.registry,
      sessionManager: this.sessions,
      toolExecutor: this.tools,
      handLoader: this.hands,
      adapters: { api: apiAdapter, cli: cliAdapter },
    });

    // 加载 Hand
    this.hands.loadAll();
  }

  // 从配置文件加载 Agent
  loadConfig(configPath) {
    this.registry.loadFromConfig(configPath);
    return this;
  }

  // 注册 Agent
  registerAgent(name, config) {
    this.registry.register(name, config);
    return this;
  }

  // 创建会话
  createSession(options) {
    return this.sessions.create(options);
  }

  // 获取会话
  getSession(id) {
    return this.sessions.get(id);
  }

  // 发消息
  async sendMessage(sessionId, text) {
    return await this.orchestrator.processMessage(sessionId, text);
  }

  // 查看系统状态
  status() {
    return {
      agents: this.registry.list(),
      sessions: this.sessions.list(),
      hands: Array.from(this.hands.hands.keys()),
    };
  }
}

module.exports = ModulAgent;

// 命令行直接运行时启动 CLI
if (process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('modul-agent'))) {
  const app = new ModulAgent();
  const configPath = process.argv[2] || './config/default.json';

  // 加载配置
  try {
    app.loadConfig(configPath);
  } catch (err) {
    console.error(`❌ 加载配置失败: ${err.message}`);
    process.exit(1);
  }

  console.log('\n  🧠 Modul Agent 已启动!');
  console.log('  ──────────────────────');
  const status = app.status();
  console.log(`  Agent: ${Object.keys(status.agents).length} 个`);
  console.log(`  Hand: ${status.hands.length} 个`);
  console.log(`  输入 "help" 查看命令\n`);

  // 简单 REPL
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === 'exit' || input === 'quit') {
      console.log('👋 再见!');
      rl.close();
      process.exit(0);
    }

    if (input === 'help') {
      console.log(`
可用命令:
  create <name>     — 创建新会话
  list              — 列出会话
  join <id>         — 进入会话
  send <text>       — 在会话中发消息
  agents            — 查看模型
  status            — 系统状态
  exit              — 退出
      `);
      rl.prompt();
      return;
    }

    if (input === 'status') {
      console.log(JSON.stringify(app.status(), null, 2));
      rl.prompt();
      return;
    }

    if (input === 'agents') {
      console.log(JSON.stringify(app.registry.list(), null, 2));
      rl.prompt();
      return;
    }

    if (input.startsWith('create ')) {
      const name = input.slice(7).trim();
      const session = app.createSession({
        name,
        agents: Object.keys(app.registry.list()),
      });
      console.log(`✅ 会话创建: ${session.id}\n可通过 join ${session.id} 进入`);
      rl.prompt();
      return;
    }

    if (input === 'list') {
      const sessions = app.sessions.list();
      if (Object.keys(sessions).length === 0) {
        console.log('暂无会话，输入 create <name> 创建');
      } else {
        console.log(JSON.stringify(sessions, null, 2));
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('join ')) {
      const id = input.slice(5).trim();
      try {
        const session = app.getSession(id);
        console.log(`\n📌 进入会话: ${session.name}`);
        console.log(`Agent: ${session.agents.join(', ')}`);
        console.log(`调度模式: ${session.orchestrator}`);
        console.log(`共享目录: ${session.sharedDir}\n`);
        global._currentSession = id;
      } catch (err) {
        console.log(`❌ ${err.message}`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('send ')) {
      const sid = global._currentSession;
      if (!sid) {
        console.log('❌ 请先 join 一个会话');
        rl.prompt();
        return;
      }
      const text = input.slice(5).trim();
      console.log(`\n🤔 发送: ${text}\n`);
      try {
        const results = await app.sendMessage(sid, text);
        for (const r of results) {
          if (r.error) {
            console.log(`  ❌ ${r.agent || '?'}: ${r.error}`);
          } else if (r.agent) {
            console.log(`  💬 ${r.agent}: ${r.text?.slice(0, 200)}`);
          } else {
            // master mode 返回值特殊
            if (r.master) console.log(`  👑 组长: ${r.master.text?.slice(0, 200)}`);
            if (r.workers) {
              for (const w of r.workers) {
                console.log(`  👷 ${w.agent}: ${w.text?.slice(0, 200)}`);
              }
            }
          }
        }
        console.log('');
      } catch (err) {
        console.log(`❌ 错误: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    console.log(`未知命令: ${input}，输入 help 查看帮助`);
    rl.prompt();
  });
}
