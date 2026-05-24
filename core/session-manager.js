// ============================================================
// Session Manager — 会话管理器
// ============================================================
// 管理多个独立会话，每个会话包含参与模型、消息历史和共享目录
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class SessionManager {
  constructor({ sharedRoot = './shared', outputsRoot = './outputs', persistPath = '' } = {}) {
    this.sessions = new Map();
    this.sharedRoot = path.resolve(sharedRoot);
    this.outputsRoot = path.resolve(outputsRoot);
    this.persistPath = persistPath || path.join(path.resolve(outputsRoot, '..'), 'sessions.json');
    // 确保共享目录存在
    if (!fs.existsSync(this.sharedRoot)) {
      fs.mkdirSync(this.sharedRoot, { recursive: true });
    }
    // 确保产出目录存在
    if (!fs.existsSync(this.outputsRoot)) {
      fs.mkdirSync(this.outputsRoot, { recursive: true });
    }
    // 从文件加载持久化会话
    this._loadPersisted();
  }

  // 保存到文件
  _savePersisted() {
    try {
      const data = [];
      for (const [, session] of this.sessions) {
        data.push({
          id: session.id,
          name: session.name,
          agents: session.agents,
          orchestrator: session.orchestrator,
          messages: session.messages,
          sharedDir: session.sharedDir,
          outputDir: session.outputDir,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          metadata: session.metadata || {},
        });
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[Session] ⚠️ 保存会话持久化失败: ${e.message}`);
    }
  }

  // 从文件加载
  _loadPersisted() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      for (const s of data) {
        // 确保目录存在
        if (!fs.existsSync(s.sharedDir)) {
          try { fs.mkdirSync(s.sharedDir, { recursive: true }); } catch {}
        }
        if (!fs.existsSync(s.outputDir)) {
          try { fs.mkdirSync(s.outputDir, { recursive: true }); } catch {}
        }
        this.sessions.set(s.id, s);
      }
      console.log(`[Session] ✅ 已恢复 ${data.length} 个持久化会话`);
    } catch (e) {
      console.error(`[Session] ⚠️ 加载持久化会话失败: ${e.message}`);
    }
  }

  // 创建会话
  create({ name, agents = [], orchestrator = 'broadcast', sharedDir = '' } = {}) {
    const id = this._genId();
    // 产出子目录名称: 会话ID_名称
    const safeName = (name || `session-${id.slice(0, 8)}`).replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
    const outputDir = path.join(this.outputsRoot, `${id}_${safeName}`);
    const session = {
      id,
      name: name || `session-${id.slice(0, 8)}`,
      agents: [...agents],           // Agent 名称列表
      orchestrator,                   // broadcast | direct | chain | master
      messages: [],                   // 消息历史
      sharedDir: sharedDir || path.join(this.sharedRoot, id),
      outputDir,                      // 产出目录
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    // 确保会话的共享目录存在
    if (!fs.existsSync(session.sharedDir)) {
      fs.mkdirSync(session.sharedDir, { recursive: true });
    }
    // 确保产出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.sessions.set(id, session);
    console.log(`[Session] ✅ 会话 "${session.name}" (${id}) 已创建`);
    console.log(`[Session]   📂 产出目录: ${outputDir}`);
    this._savePersisted();
    return session;
  }

  // 获取会话
  get(id) {
    if (!this.sessions.has(id)) {
      throw new Error(`会话 "${id}" 不存在`);
    }
    return this.sessions.get(id);
  }

  // 删除会话
  delete(id) {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    console.log(`[Session] 🗑️ 会话 "${id}" 已删除`);
    this._savePersisted();
    return true;
  }

  // 列出所有会话
  list() {
    const result = {};
    for (const [id, session] of this.sessions) {
      result[id] = {
        id,
        name: session.name,
        agents: session.agents,
        orchestrator: session.orchestrator,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
      };
    }
    return result;
  }

  // 添加模型到会话
  addAgent(sessionId, agentName) {
    const session = this.get(sessionId);
    if (session.agents.includes(agentName)) {
      console.log(`[Session] ⚠️ Agent "${agentName}" 已在会话中`);
      return session;
    }
    session.agents.push(agentName);
    session.updatedAt = new Date().toISOString();
    console.log(`[Session] ➕ Agent "${agentName}" 加入会话 "${session.name}"`);
    this._savePersisted();
    return session;
  }

  // 从会话移除模型
  removeAgent(sessionId, agentName) {
    const session = this.get(sessionId);
    session.agents = session.agents.filter(a => a !== agentName);
    session.updatedAt = new Date().toISOString();
    console.log(`[Session] ➖ Agent "${agentName}" 离开会话 "${session.name}"`);
    this._savePersisted();
    return session;
  }

  // 添加消息到会话
  addMessage(sessionId, message) {
    const session = this.get(sessionId);
    const msg = {
      id: session.messages.length + 1,
      role: message.role || 'user',
      agent: message.agent || null,   // 哪个 Agent 发的
      content: message.content || '',
      toolCalls: message.toolCalls || null,
      toolResults: message.toolResults || null,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(msg);
    session.updatedAt = new Date().toISOString();

    // 限制历史长度（防止文件过大）
    if (session.messages.length > 500) {
      session.messages.splice(0, session.messages.length - 500);
    }

    this._savePersisted();
    return msg;
  }

  // 获取会话最近 N 条消息
  getRecentMessages(sessionId, limit = 50) {
    const session = this.get(sessionId);
    return session.messages.slice(-limit);
  }

  // 获取某 Agent 在会话中看到的历史（排除其他 Agent 的工具调用细节）
  getMessagesForAgent(sessionId, agentName) {
    const session = this.get(sessionId);
    return session.messages.map(m => {
      // 给模型看的信息，过滤掉不必要的工具内部细节
      const msg = {
        role: m.role,
        agent: m.agent,
        content: m.content,
      };
      return msg;
    });
  }

  // 设置会话 orcherstrator 模式
  update(sessionId, data) {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 不存在`);
    }
    const session = this.sessions.get(sessionId);
    if (data.name) session.name = data.name;
    if (data.agents) session.agents = data.agents;
    if (data.orchestrator) session.orchestrator = data.orchestrator;
    session.updatedAt = new Date().toISOString();
    this._savePersisted();
    return { ...session, messageCount: session.messages.length };
  }

  setOrchestrator(sessionId, mode) {
    const session = this.get(sessionId);
    const validModes = ['broadcast', 'direct', 'chain', 'master'];
    if (!validModes.includes(mode)) {
      throw new Error(`无效的调度模式: ${mode}，可选: ${validModes.join(', ')}`);
    }
    session.orchestrator = mode;
    session.updatedAt = new Date().toISOString();
    this._savePersisted();
    return session;
  }

  // 获取会话共享目录路径
  getSharedDir(sessionId) {
    const session = this.get(sessionId);
    return session.sharedDir;
  }

  // 获取会话产出目录路径
  getOutputDir(sessionId) {
    const session = this.get(sessionId);
    return session.outputDir;
  }

  // 列出所有会话的产出目录
  listOutputs() {
    const result = {};
    for (const [id, session] of this.sessions) {
      const dir = session.outputDir;
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => {
          const fp = path.join(dir, f);
          return fs.statSync(fp).isFile();
        }).map(f => {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          return { name: f, size: stat.size, modified: stat.mtime, path: fp, sessionId: id, sessionName: session.name };
        });
        result[id] = { name: session.name, dir, files };
      }
    }
    return result;
  }

  // 获取指定会话的产出文件列表
  getSessionOutputs(sessionId) {
    const session = this.get(sessionId);
    const dir = session.outputDir;
    if (!fs.existsSync(dir)) return { name: session.name, dir, files: [] };
    const files = fs.readdirSync(dir).filter(f => {
      const fp = path.join(dir, f);
      return fs.statSync(fp).isFile();
    }).map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { name: f, size: stat.size, modified: stat.mtime, path: fp };
    });
    return { name: session.name, dir, files };
  }

  _genId() {
    return crypto.randomBytes(8).toString('hex');
  }
}

module.exports = SessionManager;
