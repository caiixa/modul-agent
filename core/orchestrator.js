// ============================================================
// Orchestrator — 调度器
// ============================================================
// 决定"谁来干活"，7 种调度模式：
//   broadcast / direct / chain / master
//   router / debate / workflow
// 角色（人设）与模型（Agent）已解耦，每个角色由 modelAgent 字段指定驱动的大模型。
// ============================================================

class Orchestrator {
  constructor({ agentRegistry, sessionManager, toolExecutor, handLoader, adapters }) {
    this.agentRegistry = agentRegistry;
    this.sessionManager = sessionManager;
    this.toolExecutor = toolExecutor;
    this.handLoader = handLoader;
    this.adapters = adapters; // { api, cli }
  }

  // 获取会话中所有 role.id
  _roleIds(session) {
    return (session.roles || []).map(r => r.id);
  }

  // 根据 role.id 找到对应的 modelAgent
  _modelAgentFor(session, roleId) {
    const role = (session.roles || []).find(r => r.id === roleId);
    return role ? role.modelAgent : roleId;
  }

  // 处理用户消息（非流式，返回最终结果）
  async processMessage(sessionId, userMessage) {
    const session = this.sessionManager.get(sessionId);
    const mode = session.orchestrator;

    this.sessionManager.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
    });

    switch (mode) {
      case 'broadcast': return this._broadcast(session, userMessage);
      case 'direct':    return this._direct(session, userMessage);
      case 'chain':     return this._chain(session, userMessage);
      case 'master':    return this._masterMode(session, userMessage);
      case 'router':    return this._routerMode(session, userMessage);
      case 'debate':    return this._debateMode(session, userMessage);
      case 'workflow':  return this._workflowMode(session, userMessage);
      default:          return this._broadcast(session, userMessage);
    }
  }

  // 流式处理用户消息 — 通过 onEvent 推送实时事件
  async processMessageStream(sessionId, userMessage, onEvent) {
    const session = this.sessionManager.get(sessionId);
    const mode = session.orchestrator;

    onEvent({ type: 'session', data: { sessionId, sessionName: session.name } });

    this.sessionManager.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
    });
    onEvent({ type: 'user_message', data: { text: userMessage } });

    let results;
    switch (mode) {
      case 'direct':  results = await this._streamDirect(session, userMessage, onEvent); break;
      case 'chain':   results = await this._streamChain(session, userMessage, onEvent); break;
      case 'master':  results = await this._streamMaster(session, userMessage, onEvent); break;
      case 'router':  results = await this._streamRouter(session, userMessage, onEvent); break;
      case 'debate':  results = await this._streamDebate(session, userMessage, onEvent); break;
      case 'workflow':results = await this._streamWorkflow(session, userMessage, onEvent); break;
      default:        results = await this._streamBroadcast(session, userMessage, onEvent);
    }

    onEvent({ type: 'done', data: { results } });
    return results;
  }

  // ==================== 非流式调度模式 ====================

  // 广播模式 — 遍历 roles，所有角色都回复
  async _broadcast(session, userMessage) {
    const results = [];
    const promises = (session.roles || []).map(async (role) => {
      try {
        const result = await this._callAgent(session, role.id, userMessage);
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: result.text,
        });
        results.push({ agent: role.id, ...result });
      } catch (err) {
        results.push({ agent: role.id, error: err.message });
      }
    });
    await Promise.all(promises);
    return results;
  }

  // 定向模式 — @角色名 或 @角色ID
  async _direct(session, userMessage) {
    // 匹配 @角色名 或 @角色ID
    const match = userMessage.match(/^@([\w\u4e00-\u9fff-]+)\s+(.*)/s);
    if (!match) return this._broadcast(session, userMessage);

    const targetIdentifier = match[1].toLowerCase();
    const actualMessage = match[2];

    // 查找：先按 id 匹配，再按 name 匹配
    const targetRole = (session.roles || []).find(r =>
      r.id.toLowerCase() === targetIdentifier || r.name.toLowerCase() === targetIdentifier
    );
    if (!targetRole) {
      return [{ error: `角色 "${match[1]}" 不在当前群组中` }];
    }

    const result = await this._callAgent(session, targetRole.id, actualMessage);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetRole.id, modelAgent: targetRole.modelAgent, content: result.text,
    });
    return [{ agent: targetRole.id, ...result }];
  }

  // 串联模式 — 按 roles 顺序执行
  async _chain(session, userMessage) {
    const results = [];
    let currentInput = userMessage;

    for (const role of (session.roles || [])) {
      try {
        const result = await this._callAgent(session, role.id, currentInput);
        currentInput = result.text;
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: result.text,
        });
        results.push({ agent: role.id, ...result });
      } catch (err) {
        results.push({ agent: role.id, error: err.message });
        break;
      }
    }
    return results;
  }

  _parseAssignments(text) {
    const pattern = /@([\w\u4e00-\u9fff-]+):\s*(.+?)(?=\n@|\n*$)/gs;
    const assignments = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      assignments.push({ roleId: match[1], task: match[2].trim() });
    }
    return assignments;
  }

  // ==================== 流式调度模式实现 ====================

  // 流式广播
  async _streamBroadcast(session, userMessage, onEvent) {
    const results = [];
    for (const role of (session.roles || [])) {
      try {
        onEvent({ type: 'agent_start', data: { agent: role.id, role } });
        const response = await this._callAgentStream(session, role.id, userMessage, onEvent);
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: response.text,
        });
        results.push({ agent: role.id, ...response });
        onEvent({ type: 'agent_done', data: { agent: role.id, text: response.text, role } });
      } catch (err) {
        results.push({ agent: role.id, error: err.message });
        onEvent({ type: 'agent_error', data: { agent: role.id, error: err.message } });
      }
    }
    return results;
  }

  // 流式定向
  async _streamDirect(session, userMessage, onEvent) {
    const match = userMessage.match(/^@([\w\u4e00-\u9fff-]+)\s+(.*)/s);
    if (!match) return this._streamBroadcast(session, userMessage, onEvent);

    const targetIdentifier = match[1].toLowerCase();
    const actualMessage = match[2];
    const targetRole = (session.roles || []).find(r =>
      r.id.toLowerCase() === targetIdentifier || r.name.toLowerCase() === targetIdentifier
    );
    if (!targetRole) {
      return [{ error: `角色 "${match[1]}" 不在当前群组中` }];
    }

    onEvent({ type: 'agent_start', data: { agent: targetRole.id, role: targetRole } });
    const result = await this._callAgentStream(session, targetRole.id, actualMessage, onEvent);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetRole.id, modelAgent: targetRole.modelAgent, content: result.text,
    });
    onEvent({ type: 'agent_done', data: { agent: targetRole.id, text: result.text, role: targetRole } });
    return [{ agent: targetRole.id, ...result }];
  }

  // 流式串联
  async _streamChain(session, userMessage, onEvent) {
    const results = [];
    let currentInput = userMessage;
    for (const role of (session.roles || [])) {
      try {
        onEvent({ type: 'agent_start', data: { agent: role.id, role } });
        const result = await this._callAgentStream(session, role.id, currentInput, onEvent);
        currentInput = result.text;
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: result.text,
        });
        results.push({ agent: role.id, ...result });
        onEvent({ type: 'agent_done', data: { agent: role.id, text: result.text, role } });
      } catch (err) {
        results.push({ agent: role.id, error: err.message });
        onEvent({ type: 'agent_error', data: { agent: role.id, error: err.message } });
        break;
      }
    }
    return results;
  }

  // 流式主模型 — 组长分配任务
  async _streamMaster(session, userMessage, onEvent) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const leaderRole = roles.find(r => r.isLeader) || roles[0];
    const workers = roles.filter(r => r.id !== leaderRole.id);

    if (workers.length === 0) return this._streamBroadcast(session, userMessage, onEvent);

    onEvent({ type: 'agent_start', data: { agent: leaderRole.id, role: leaderRole } });
    const taskPlan = await this._callAgentStream(session, leaderRole.id,
      `你是组长，需要分配任务给以下助手：${workers.map(w => w.name || w.id).join(', ')}\n` +
      `用户需求：${userMessage}\n请输出任务分配计划，格式：\n` +
      `@助手名: 任务描述`,
      onEvent
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: leaderRole.id, modelAgent: leaderRole.modelAgent, content: taskPlan.text,
    });
    onEvent({ type: 'agent_done', data: { agent: leaderRole.id, text: taskPlan.text, role: leaderRole } });

    const assignments = this._parseAssignments(taskPlan.text);
    for (const { roleId, task } of assignments) {
      const worker = workers.find(w =>
        w.id.toLowerCase() === roleId.toLowerCase() || w.name.toLowerCase() === roleId.toLowerCase()
      );
      if (!worker) continue;
      try {
        onEvent({ type: 'agent_start', data: { agent: worker.id, role: worker } });
        const result = await this._callAgentStream(session, worker.id, task, onEvent);
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: worker.id, modelAgent: worker.modelAgent, content: result.text,
        });
        onEvent({ type: 'agent_done', data: { agent: worker.id, text: result.text, role: worker } });
      } catch (err) {
        onEvent({ type: 'agent_error', data: { agent: worker.id, error: err.message } });
      }
    }
    return { master: { agent: leaderRole.id, ...taskPlan }, workers: assignments.map(a => a.roleId) };
  }

  // 流式路由
  async _streamRouter(session, userMessage, onEvent) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const leaderRole = roles.find(r => r.isLeader) || roles[0];
    const workers = roles.filter(r => r.id !== leaderRole.id);
    if (workers.length === 0) return this._streamBroadcast(session, userMessage, onEvent);

    onEvent({ type: 'agent_start', data: { agent: leaderRole.id, role: leaderRole } });
    const routePlan = await this._callAgentStream(session, leaderRole.id,
      `你是智能路由分配器。分析用户消息，从以下角色中选择最合适的一个执行任务。

` +
      `可用角色：
${workers.map((w, i) => `${i + 1}. @${w.name || w.id}${w.description ? ' — ' + w.description : ''}`).join('\n')}

` +
      `用户消息：${userMessage}

` +
      `只回复角色名。格式：@角色名`, onEvent
    );
    const targetMatch = routePlan.text.match(/@([\w\u4e00-\u9fff-]+)/);
    const targetIdentifier = targetMatch ? targetMatch[1].toLowerCase() : '';
    const targetRole = workers.find(w =>
      w.id.toLowerCase() === targetIdentifier || w.name?.toLowerCase() === targetIdentifier
    ) || workers[0];

    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: leaderRole.id, modelAgent: leaderRole.modelAgent,
      content: `📡 智能路由：将任务分配给了 @${targetRole.name || targetRole.id}`,
    });
    onEvent({ type: 'agent_done', data: { agent: leaderRole.id, text: `📡 路由给 @${targetRole.name || targetRole.id}`, role: leaderRole } });

    if (!roles.find(r => r.id === targetRole.id)) {
      return [{ error: `路由器选择的 "${targetRole.name || targetRole.id}" 不在群组中` }];
    }
    onEvent({ type: 'agent_start', data: { agent: targetRole.id, role: targetRole } });
    const result = await this._callAgentStream(session, targetRole.id, userMessage, onEvent);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetRole.id, modelAgent: targetRole.modelAgent, content: result.text,
    });
    onEvent({ type: 'agent_done', data: { agent: targetRole.id, text: result.text, role: targetRole } });
    return [{ router: leaderRole.id, target: targetRole.id, result }];
  }

  // 流式辩论
  async _streamDebate(session, userMessage, onEvent) {
    const roles = session.roles || [];
    if (roles.length < 2) return this._streamBroadcast(session, userMessage, onEvent);

    const allResults = [];
    for (const role of roles) {
      onEvent({ type: 'agent_start', data: { agent: role.id, role } });
      const result = await this._callAgentStream(session, role.id, userMessage, onEvent);
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: result.text,
      });
      onEvent({ type: 'agent_done', data: { agent: role.id, text: result.text, role } });
      allResults.push({ agent: role.id, text: result.text });
    }

    // 第一个角色当裁判
    const judgeRole = roles[0];
    onEvent({ type: 'agent_start', data: { agent: judgeRole.id, role: judgeRole } });
    const judgePrompt = `你是裁判。以下是多个 AI 助手对同一个问题的回答。请选出最佳答案并说明理由。

` +
      `问题：${userMessage}

` +
      allResults.map(r => {
        const role = roles.find(ro => ro.id === r.agent);
        return `--- ${role ? role.name || role.id : r.agent} ---\n${r.text}`;
      }).join(`

`) +
      `

格式：
🏆 最佳：@助手名
理由：...`;
    const judgeResult = await this._callAgentStream(session, judgeRole.id, judgePrompt, onEvent);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: judgeRole.id, modelAgent: judgeRole.modelAgent,
      content: `🏆 辩论裁决：
${judgeResult.text}`,
    });
    onEvent({ type: 'agent_done', data: { agent: judgeRole.id, text: judgeResult.text, role: judgeRole } });
    return { answers: allResults, verdict: { judge: judgeRole.id, text: judgeResult.text } };
  }

  // 流式工作流
  async _streamWorkflow(session, userMessage, onEvent) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const results = [];
    let currentInput = userMessage;
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const stepMessage = (i === 0)
        ? userMessage
        : `上一步结果：
${currentInput}

请继续处理。` +
          (i < roles.length - 1 ? ' 处理完后将结果传递给下一步。' : ' 这是最后一步，请给出完整的最终输出。');
      onEvent({ type: 'agent_start', data: { agent: role.id, role } });
      const result = await this._callAgentStream(session, role.id, stepMessage, onEvent);
      currentInput = result.text;
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: role.id, modelAgent: role.modelAgent,
        content: `[步骤 ${i + 1}/${roles.length}] ${result.text}`,
      });
      onEvent({ type: 'agent_done', data: { agent: role.id, text: result.text, role } });
      results.push({ agent: role.id, step: i + 1, text: result.text });
    }
    return { workflow: results, finalOutput: currentInput };
  }

  // 非流式主模型
  async _masterMode(session, userMessage) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const leaderRole = roles.find(r => r.isLeader) || roles[0];
    const workers = roles.filter(r => r.id !== leaderRole.id);

    if (workers.length === 0) return this._broadcast(session, userMessage);

    const taskPlan = await this._callAgent(session, leaderRole.id,
      `你是组长，需要分配任务给以下助手：${workers.map(w => w.name || w.id).join(', ')}\n` +
      `用户需求：${userMessage}\n请输出任务分配计划，格式：\n` +
      `@助手名: 任务描述`
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: leaderRole.id, modelAgent: leaderRole.modelAgent, content: taskPlan.text,
    });

    const assignments = this._parseAssignments(taskPlan.text);
    const workerResults = await Promise.all(
      assignments.map(async ({ roleId, task }) => {
        const worker = workers.find(w =>
          w.id.toLowerCase() === roleId.toLowerCase() || w.name?.toLowerCase() === roleId.toLowerCase()
        );
        if (!worker) return { agent: roleId, error: '不是你的任务' };
        try {
          const result = await this._callAgent(session, worker.id, task);
          this.sessionManager.addMessage(session.id, {
            role: 'assistant', agent: worker.id, modelAgent: worker.modelAgent, content: result.text,
          });
          return { agent: worker.id, ...result };
        } catch (err) {
          return { agent: worker.id, error: err.message };
        }
      })
    );
    return { master: { agent: leaderRole.id, ...taskPlan }, workers: workerResults };
  }

  // ==================== Agent 调用核心 ====================

  async _callAgent(session, roleId, message) {
    const modelAgentName = this._modelAgentFor(session, roleId);
    const agentConfig = this.agentRegistry.get(modelAgentName);
    if (!agentConfig) {
      return { text: `[错误: 模型 "${modelAgentName}" 未注册]` };
    }

    session._orchestrator = this;
    session._callingAgent = roleId;

    const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
    const history = this.sessionManager.getMessagesForAgent(session.id, roleId);

    // 在 prompt 中注入角色信息（人设）
    const role = (session.roles || []).find(r => r.id === roleId);
    const roleContext = role
      ? `你是 ${role.name || role.id}。\n${role.description ? '角色描述：' + role.description + '\n' : ''}`
      : '';

    let adapter;
    if (agentConfig.type === 'cli') {
      adapter = this.adapters.cli;
    } else {
      adapter = this.adapters.api;
    }

    const response = await adapter.call(agentConfig, {
      message: roleContext + message, toolsPrompt, history,
      sharedDir: session.sharedDir, outputDir: session.outputDir,
    });

    let finalText = response.text;
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults = await this.toolExecutor.executeBatch(
        response.toolCalls, agentConfig.hands,
        session.sharedDir, session.outputDir, session
      );
      const continued = await adapter.call(agentConfig, {
        message: null, toolsPrompt,
        history: [
          ...history,
          { role: 'assistant', content: response.text },
          { role: 'tool', content: JSON.stringify(toolResults) },
        ],
        sharedDir: session.sharedDir, outputDir: session.outputDir,
      });
      finalText = continued.text || response.text;
    }

    if (!response.toolCalls) {
      const parsedCalls = this.toolExecutor.parseTextToolCalls(response.text);
      if (parsedCalls.length > 0) {
        const toolResults = await this.toolExecutor.executeBatch(
          parsedCalls, agentConfig.hands,
          session.sharedDir, session.outputDir, session
        );
        const cleanText = this.toolExecutor.stripToolMarkers(response.text);
        finalText = cleanText + '\n\n[工具执行结果：' + JSON.stringify(toolResults) + ']';
      }
    }

    return { text: finalText || '[无回复]' };
  }

  async _callAgentStream(session, roleId, message, onEvent) {
    const modelAgentName = this._modelAgentFor(session, roleId);
    const agentConfig = this.agentRegistry.get(modelAgentName);
    if (!agentConfig) {
      onEvent({ type: 'agent_error', data: { agent: roleId, error: `模型 "${modelAgentName}" 未注册` } });
      return { text: `[错误: 模型 "${modelAgentName}" 未注册]` };
    }

    session._orchestrator = this;
    session._callingAgent = roleId;

    const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
    const history = this.sessionManager.getMessagesForAgent(session.id, roleId);

    // 注入角色人设
    const role = (session.roles || []).find(r => r.id === roleId);
    const roleContext = role
      ? `你是 ${role.name || role.id}。\n${role.description ? '角色描述：' + role.description + '\n' : ''}`
      : '';

    let adapter;
    if (agentConfig.type === 'cli') {
      adapter = this.adapters.cli;
      const response = await adapter.call(agentConfig, {
        message: roleContext + message, toolsPrompt, history,
        sharedDir: session.sharedDir, outputDir: session.outputDir,
      });
      if (response.text) {
        onEvent({ type: 'text', data: { agent: roleId, text: response.text } });
      }
      return response;
    }

    adapter = this.adapters.api;
    const response = await adapter.callStream(agentConfig, {
      message: roleContext + message, toolsPrompt, history,
      sharedDir: session.sharedDir, outputDir: session.outputDir,
    }, (event) => {
      if (event.type === 'text') {
        onEvent({ type: 'text', data: { agent: roleId, text: event.data.text } });
      } else if (event.type === 'thinking') {
        onEvent({ type: 'thinking', data: { agent: roleId } });
      } else if (event.type === 'tool_calls') {
        onEvent({ type: 'tool_calls', data: { agent: roleId, toolCalls: event.data.toolCalls } });
      } else if (event.type === 'error') {
        onEvent({ type: 'agent_error', data: { agent: roleId, error: event.data.error } });
      }
    });

    let finalText = response.text;
    if (response.toolCalls && response.toolCalls.length > 0) {
      onEvent({ type: 'tool_executing', data: { agent: roleId, toolCalls: response.toolCalls } });

      const toolResults = await this.toolExecutor.executeBatch(
        response.toolCalls, agentConfig.hands,
        session.sharedDir, session.outputDir, session
      );

      onEvent({ type: 'tool_result', data: { agent: roleId, results: toolResults } });

      const continued = await adapter.call(agentConfig, {
        message: null, toolsPrompt,
        history: [
          ...history,
          { role: 'assistant', content: response.text },
          { role: 'tool', content: JSON.stringify(toolResults) },
        ],
        sharedDir: session.sharedDir, outputDir: session.outputDir,
      });

      finalText = continued.text || response.text;
      if (continued.text) {
        onEvent({ type: 'text', data: { agent: roleId, text: continued.text } });
      }
    }

    return { text: finalText || '[无回复]' };
  }

  // ==================== 非流式路由模式 ====================
  async _routerMode(session, userMessage) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const leaderRole = roles.find(r => r.isLeader) || roles[0];
    const workers = roles.filter(r => r.id !== leaderRole.id);
    if (workers.length === 0) return this._broadcast(session, userMessage);

    const routePlan = await this._callAgent(session, leaderRole.id,
      `你是智能路由分配器。分析用户消息，从以下角色中选择最合适的一个执行任务。

` +
      `可用角色：
${workers.map((w, i) => `${i + 1}. @${w.name || w.id}${w.description ? ' — ' + w.description : ''}`).join('\n')}

` +
      `用户消息：${userMessage}

` +
      `请根据每个角色的专长选择最匹配的角色。只回复角色名，不要多余文字。
` +
      `格式：@角色名`
    );

    const targetMatch = routePlan.text.match(/@([\w\u4e00-\u9fff-]+)/);
    const targetIdentifier = targetMatch ? targetMatch[1].toLowerCase() : '';
    const targetRole = workers.find(w =>
      w.id.toLowerCase() === targetIdentifier || w.name?.toLowerCase() === targetIdentifier
    ) || workers[0];

    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: leaderRole.id, modelAgent: leaderRole.modelAgent,
      content: `📡 智能路由：将任务分配给了 @${targetRole.name || targetRole.id}`,
    });

    if (!roles.find(r => r.id === targetRole.id)) {
      return [{ error: `路由器选择的 "${targetRole.name || targetRole.id}" 不在群组中` }];
    }

    const result = await this._callAgent(session, targetRole.id, userMessage);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetRole.id, modelAgent: targetRole.modelAgent, content: result.text,
    });
    return [{ router: leaderRole.id, target: targetRole.id, result }];
  }

  // ==================== 非流式辩论模式 ====================
  async _debateMode(session, userMessage) {
    const roles = session.roles || [];
    if (roles.length < 2) return this._broadcast(session, userMessage);

    const allResults = [];
    for (const role of roles) {
      const result = await this._callAgent(session, role.id, userMessage);
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: role.id, modelAgent: role.modelAgent, content: result.text,
      });
      allResults.push({ agent: role.id, text: result.text });
    }

    const judgeRole = roles[0];
    const judgePrompt = `你是裁判。以下是多个 AI 助手对同一个问题的回答。请投票选出最佳答案并说明理由。

` +
      `问题：${userMessage}

` +
      allResults.map(r => {
        const role = roles.find(ro => ro.id === r.agent);
        return `--- ${role ? role.name || role.id : r.agent} 的回答 ---\n${r.text}`;
      }).join(`

`) +
      `

请选出最佳回答，格式：
🏆 最佳：@助手名
理由：...`;

    const judgeResult = await this._callAgent(session, judgeRole.id, judgePrompt);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: judgeRole.id, modelAgent: judgeRole.modelAgent,
      content: `🏆 辩论裁决：
${judgeResult.text}`,
    });

    return { answers: allResults, verdict: { judge: judgeRole.id, text: judgeResult.text } };
  }

  // ==================== 非流式工作流模式 ====================
  async _workflowMode(session, userMessage) {
    const roles = session.roles || [];
    if (roles.length === 0) return [];

    const results = [];
    let currentInput = userMessage;

    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const stepMessage = (i === 0)
        ? userMessage
        : `上一步结果：
${currentInput}

请继续处理。` +
          (i < roles.length - 1 ? ' 处理完后将结果传递给下一步。' : ' 这是最后一步，请给出完整的最终输出。');

      const result = await this._callAgent(session, role.id, stepMessage);
      currentInput = result.text;
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: role.id, modelAgent: role.modelAgent,
        content: `[步骤 ${i + 1}/${roles.length}] ${result.text}`,
      });
      results.push({ agent: role.id, step: i + 1, text: result.text });
    }

    return { workflow: results, finalOutput: currentInput };
  }

  // ==================== Agent 间通信 ====================
  async _agentChat(session, fromRoleId, toRoleId, question) {
    const roles = session.roles || [];
    const fromRole = roles.find(r => r.id === fromRoleId);
    const toRole = roles.find(r => r.id === toRoleId);
    if (!toRole) {
      return `[错误: 角色 "${toRoleId}" 不在当前群组中]`;
    }

    const fromName = fromRole ? fromRole.name || fromRole.id : fromRoleId;
    const toName = toRole.name || toRole.id;

    const result = await this._callAgent(session, toRole.id,
      `[来自 ${fromName} 的消息]
${question}

请直接回答。`
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: toRole.id, modelAgent: toRole.modelAgent,
      content: `💬 @${fromName} → @${toName}: ${result.text}`,
    });
    return result.text;
  }

  // Agent 间通信的 Hand 工具
  getAgentChatTool() {
    return {
      name: 'agent_chat',
      description: '向群组中的另一个角色提问，并获取它的回答。适用于协作讨论、代码审查等场景。',
      parameters: {
        target_agent: { type: 'string', description: '目标角色名（必须在这个群组中）' },
        question: { type: 'string', description: '你要问的问题或讨论的内容' },
      },
      execute: async ({ target_agent, question }, { sharedDir }) => {
        // execute 由 tool-executor 调用，通过闭包注入 session
      },
    };
  }
}

module.exports = Orchestrator;
