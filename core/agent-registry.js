// ============================================================
// Agent Registry — 模型注册表
// ============================================================
// 管理所有注册的 Agent，支持 API 模型和 CLI 模型
// ============================================================

const fs = require('fs');
const path = require('path');

class AgentRegistry {
  constructor(options = {}) {
    this.agents = new Map(); // name -> AgentConfig
    this.persistPath = options.persistPath || path.join(__dirname, '..', 'config', 'agents.json');
    this._loaded = false;
  }

  // === 持久化 ===
  _loadPersisted() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const data = JSON.parse(raw);
        for (const [name, cfg] of Object.entries(data)) {
          this.agents.set(name, cfg);
        }
        if (Object.keys(data).length > 0) {
          console.log(`[Registry] 💾 已加载 ${Object.keys(data).length} 个持久化 Agent`);
        }
      }
    } catch (err) {
      console.warn(`[Registry] ⚠️ 加载持久化数据失败: ${err.message}`);
    }
  }

  _savePersisted() {
    try {
      const data = {};
      for (const [name, agent] of this.agents) {
        data[name] = agent;
      }
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[Registry] ⚠️ 持久化保存失败: ${err.message}`);
    }
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
    this._loadPersisted();

    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" 已存在`);
    }

    const agent = {
      name,
      type: config.type || 'api',         // api | cli
      provider: config.provider || '',
      model: config.model || '',
      apiKey: config.api_key || config.apiKey || '',
      baseUrl: config.base_url || config.baseUrl || '',
      command: config.command || '',        // CLI 模型用
      workingDir: config.working_dir || config.workingDir || '',
      hands: config.hands || [],            // 挂载的能力插件名列表
      metadata: config.metadata || {},
      createdAt: new Date().toISOString(),
    };

    this.agents.set(name, agent);
    this._savePersisted();
    console.log(`[Registry] ✅ Agent "${name}" 已注册 (${agent.type}, ${agent.model || agent.command})`);
    return agent;
  }

  // 获取 Agent
  get(name) {
    this._loadPersisted();
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 未注册`);
    }
    return this.agents.get(name);
  }

  // 列出所有 Agent（完整信息）
  list() {
    this._loadPersisted();
    const result = {};
    for (const [name, agent] of this.agents) {
      result[name] = {
        name: agent.name,
        type: agent.type,
        provider: agent.provider,
        model: agent.model || agent.command,
        apiKey: agent.apiKey ? agent.apiKey.substring(0, 8) + '...' : '',
        baseUrl: agent.baseUrl || '',
        hands: agent.hands || [],
        createdAt: agent.createdAt,
      };
    }
    return result;
  }

  // 获取 Agent 详细信息（含完整 apiKey）
  getDetail(name) {
    this._loadPersisted();
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 未注册`);
    }
    const agent = this.agents.get(name);
    return { ...agent };
  }

  // 更新 Agent
  update(name, config) {
    this._loadPersisted();
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 不存在`);
    }
    const existing = this.agents.get(name);
    const updated = {
      ...existing,
      name,
      type: config.type || existing.type,
      provider: config.provider || existing.provider,
      model: config.model || existing.model,
      apiKey: config.api_key || config.apiKey || existing.apiKey,
      baseUrl: config.base_url || config.baseUrl || existing.baseUrl,
      command: config.command || existing.command,
      workingDir: config.working_dir || config.workingDir || existing.workingDir,
      hands: config.hands || existing.hands,
      metadata: config.metadata || existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(name, updated);
    this._savePersisted();
    console.log(`[Registry] 🔄 Agent "${name}" 已更新`);
    return updated;
  }

  // 删除 Agent
  remove(name) {
    this._loadPersisted();
    if (!this.agents.has(name)) {
      throw new Error(`Agent "${name}" 不存在`);
    }
    this.agents.delete(name);
    this._savePersisted();
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
