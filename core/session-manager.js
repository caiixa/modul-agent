// ============================================================
// Session Manager — 会话管理器
// ============================================================
// 管理多个独立会话，每个会话包含参与角色（人设）、消息历史和产出目录。
// 角色（人设）与模型（Agent）已解耦：
//   - 角色 = 人设（产品经理、前端开发）
//   - 角色.modelAgent = 驱动该角色的大模型名称（deepseek、hermes 等）
//   同一个大模型可驱动多个不同角色。
// 自动持久化到 sessions.json，启动时恢复。
// 每个会话的产出目录：outputs/<会话ID_名称>/
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class SessionManager {
  constructor({ outputsRoot = './outputs', persistPath = '' } = {}) {
    this.sessions = new Map();
    this.outputsRoot = path.resolve(outputsRoot);
    this.persistPath = persistPath || path.join(this.outputsRoot, '..', 'sessions.json');
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
          roles: session.roles,
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
        if (s.sharedDir && !fs.existsSync(s.sharedDir)) {
          try { fs.mkdirSync(s.sharedDir, { recursive: true }); } catch {}
        }
        if (s.outputDir && !fs.existsSync(s.outputDir)) {
          try { fs.mkdirSync(s.outputDir, { recursive: true }); } catch {}
        }

        // === 向后兼容：旧版 roles 结构（带 agentName）→ 新版（带 id/name/modelAgent）===
        if (s.roles) {
          s.roles = s.roles.map(r => this._migrateRole(r));
        } else if (s.agents) {
          // 连 roles 都没有：从 agents 数组生成默认角色
          s.roles = s.agents.map(a => this._defaultRoleV2(a));
        }

        // 保证 agents 字段同步
        if (s.roles) {
          s.agents = s.roles.map(r => r.id);
        }

        this.sessions.set(s.id, s);
      }
      console.log(`[Session] ✅ 已恢复 ${data.length} 个持久化会话`);
    } catch (e) {
      console.error(`[Session] ⚠️ 加载持久化会话失败: ${e.message}`);
    }
  }

  // 旧角色 → 新角色迁移
  _migrateRole(role) {
    // 如果已经是新格式（有 modelAgent 字段），直接返回
    if (role.modelAgent) return role;
    // 旧格式：{ agentName, title, icon, ... }
    // → 新格式：{ id, name, modelAgent: agentName, icon, ... }
    return {
      id: role.agentName || role.id || 'unknown',
      name: role.title || role.name || role.agentName || 'unknown',
      modelAgent: role.modelAgent || role.agentName || 'unknown',
      icon: role.icon || '🤖',
      description: role.description || '',
      tags: role.tags || [],
      isLeader: role.isLeader || false,
    };
  }

  // 创建会话
  create({ name, agents = [], roles, orchestrator = 'broadcast' } = {}) {
    const id = this._genId();
    // 产出子目录名称: 会话ID_名称
    const safeName = (name || `session-${id.slice(0, 8)}`).replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
    const outputDir = path.join(this.outputsRoot, `${id}_${safeName}`);

    // 新版 roles（传了直接用，没传则从旧版 agents 生成）
    const computedRoles = roles
      ? roles.map(r => typeof r.modelAgent !== 'undefined' ? r : this._migrateRole(r))
      : agents.map(a => this._defaultRoleV2(a));

    // 为没有 id 的新角色自动生成
    for (const r of computedRoles) {
      if (!r.id) r.id = this._genShortId();
    }

    const session = {
      id,
      name: name || `session-${id.slice(0, 8)}`,
      agents: computedRoles.map(r => r.id),  // 存 role.id
      roles: computedRoles,
      orchestrator,
      messages: [],
      sharedDir: outputDir,
      outputDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

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
        roles: session.roles,
        orchestrator: session.orchestrator,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
      };
    }
    return result;
  }

  // 添加模型到会话（兼容旧接口）
  addAgent(sessionId, agentName) {
    const session = this.get(sessionId);
    if (session.agents.includes(agentName)) {
      console.log(`[Session] ⚠️ Agent "${agentName}" 已在会话中`);
      return session;
    }
    session.agents.push(agentName);
    // 同时添加一个默认角色
    if (!session.roles) session.roles = [];
    session.roles.push(this._defaultRoleV2(agentName));
    session.updatedAt = new Date().toISOString();
    console.log(`[Session] ➕ Agent "${agentName}" 加入会话 "${session.name}"`);
    this._savePersisted();
    return session;
  }

  // 从会话移除模型（兼容旧接口）
  removeAgent(sessionId, agentName) {
    const session = this.get(sessionId);
    session.agents = session.agents.filter(a => a !== agentName);
    session.roles = (session.roles || []).filter(r => r.id !== agentName);
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
      agent: message.agent || null,   // 哪个角色发的（存 role.id）
      modelAgent: message.modelAgent || null, // 实际驱动模型（可选）
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

  // 获取某 Agent 在会话中看到的历史
  getMessagesForAgent(sessionId, agentOrRoleId) {
    const session = this.get(sessionId);
    return session.messages.map(m => {
      const msg = {
        role: m.role,
        agent: m.agent,
        content: m.content,
      };
      return msg;
    });
  }

  // 根据 role.id 查找对应的模型 Agent 名称
  getModelAgentForRole(sessionId, roleId) {
    const session = this.get(sessionId);
    const role = (session.roles || []).find(r => r.id === roleId);
    return role ? role.modelAgent : roleId; // fallback 到 roleId 本身（兼容旧版）
  }

  // 更新会话
  update(sessionId, data) {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 不存在`);
    }
    const session = this.sessions.get(sessionId);
    if (data.name) session.name = data.name;
    if (data.agents) session.agents = data.agents;
    if (data.roles) {
      // 迁移旧版 roles
      session.roles = data.roles.map(r => {
        const migrated = typeof r.modelAgent !== 'undefined' ? r : this._migrateRole(r);
        if (!migrated.id) migrated.id = this._genShortId();
        return migrated;
      });
      session.agents = session.roles.map(r => r.id);
    }
    if (data.orchestrator) session.orchestrator = data.orchestrator;
    session.updatedAt = new Date().toISOString();
    this._savePersisted();
    return { ...session, messageCount: session.messages.length };
  }

  setOrchestrator(sessionId, mode) {
    const session = this.get(sessionId);
    const validModes = ['broadcast', 'direct', 'chain', 'master', 'router', 'debate', 'workflow'];
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

  _genShortId() {
    return crypto.randomBytes(3).toString('hex');
  }

  // 新版默认角色（角色与模型解耦）
  _defaultRoleV2(agentName) {
    const iconMap = {
      'deepseek': '🧠',
      'gpt': '🟢',
      'claude': '🟣',
      'hermes': '⚡',
      'lobster': '🦞',
      'openclaw': '🦞',
    };
    const matchedKey = Object.keys(iconMap).find(k => agentName.toLowerCase().includes(k));
    return {
      id: agentName,
      name: agentName,
      modelAgent: agentName,
      icon: matchedKey ? iconMap[matchedKey] : '🤖',
      description: '',
      tags: [],
      isLeader: false,
    };
  }
}

module.exports = SessionManager;
