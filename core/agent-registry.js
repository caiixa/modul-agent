// ============================================================
// Agent Registry — 模型注册表
// ============================================================
// 管理所有注册的 Agent，支持 API 模型和 CLI 模型
// ============================================================

const fs = require('fs');
const path = require('path');

class AgentRegistry {
  constructor() {
    this.agents = new Map(); // name -> AgentConfig
  }

  // 从 YAML/JSON 配置文件加载
  loadFromConfig(configPath) {
    const absPath = path.resolve(configPath);
    const raw = fs.readFileSync(absPath, 'utf-8');
    // 先用 JSON 解析，后续可加 YAML
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      // 简单 YAML 解析（只支持基本结构）
      config = this._parseSimpleYaml(raw);
    }

    if (config.agents) {
      for (const [name, cfg] of Object.entries(config.agents)) {
        this.register(name, cfg);
      }
    }
    return this;
  }

  // 注册一个 Agent
  register(name, config) {
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" 已存在`);
    }

    const agent = {
      name,
      type: config.type || 'api',         // api | cli
      provider: config.provider || '',
      model: config.model || '',
      apiKey: config.api_key || '',
      baseUrl: config.base_url || '',
      command: config.command || '',        // CLI 模型用
      workingDir: config.working_dir || '',
      hands: config.hands || [],            // 挂载的能力插件名列表
      metadata: config.metadata || {},
      createdAt: new Date().toISOString(),
    };

    this.agents.set(name, agent);
    console.log(`[Registry] ✅ Agent "${name}" 已注册 (${agent.type}, ${agent.model || agent.command})`);
    return agent;
  }

  // 获取 Agent
  get(name) {
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 未注册`);
    }
    return this.agents.get(name);
  }

  // 列出所有 Agent
  list() {
    const result = {};
    for (const [name, agent] of this.agents) {
      result[name] = {
        name: agent.name,
        type: agent.type,
        model: agent.model || agent.command,
        hands: agent.hands,
      };
    }
    return result;
  }

  // 删除 Agent
  remove(name) {
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 不存在`);
    }
    this.agents.delete(name);
    console.log(`[Registry] 🗑️ Agent "${name}" 已删除`);
  }

  // 简单 YAML 解析（够用就行）
  _parseSimpleYaml(raw) {
    const config = { agents: {} };
    let currentAgent = null;
    let currentKey = null;

    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;

      // agents: 标题
      if (trimmed === 'agents:') continue;

      // 二级 key:  agent_name:
      const agentMatch = trimmed.match(/^\s{2}(\w[\w-]*):\s*$/);
      if (agentMatch) {
        currentAgent = agentMatch[1];
        config.agents[currentAgent] = {};
        currentKey = null;
        continue;
      }

      // 三级 key: value
      if (currentAgent) {
        const kvMatch = trimmed.match(/^\s{4}(\w[\w_]*):\s*(.*)$/);
        if (kvMatch) {
          currentKey = kvMatch[1];
          let val = kvMatch[2].trim();
          // 处理列表: [a, b, c]
          if (val.startsWith('[') && val.endsWith(']')) {
            val = val.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
          }
          // 处理环境变量 ${VAR}
          val = val.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] || '');
          config.agents[currentAgent][currentKey] = val;
          continue;
        }

        // 列表项: - item
        const listMatch = trimmed.match(/^\s{4}-\s+(.*)$/);
        if (listMatch && currentKey) {
          if (!Array.isArray(config.agents[currentAgent][currentKey])) {
            config.agents[currentAgent][currentKey] = [];
          }
          config.agents[currentAgent][currentKey].push(listMatch[1].trim().replace(/['"]/g, ''));
        }
      }
    }

    return config;
  }
}

module.exports = AgentRegistry;
