// ============================================================
// Orchestrator — 调度器
// ============================================================
// 决定"谁来干活"，支持多种调度模式 + 流式事件推送
// ============================================================

class Orchestrator {
  constructor({ agentRegistry, sessionManager, toolExecutor, handLoader, adapters }) {
    this.agentRegistry = agentRegistry;
    this.sessionManager = sessionManager;
    this.toolExecutor = toolExecutor;
    this.handLoader = handLoader;
    this.adapters = adapters; // { api, cli }
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
      default:          return this._broadcast(session, userMessage);
    }
  }

  // 流式处理用户消息 — 通过 onEvent 推送实时事件
  async processMessageStream(sessionId, userMessage, onEvent) {
    const session = this.sessionManager.get(sessionId);
    const mode = session.orchestrator;

    // 使用 session 最准确的 name 属性
    onEvent({ type: 'session', data: { sessionId, sessionName: session.name } });

    // 添加用户消息到历史
    this.sessionManager.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
    });
    onEvent({ type: 'user_message', data: { text: userMessage } });

    // 对会话中每个 Agent 执行流式调用
    const results = [];
    for (const agentName of session.agents) {
      try {
        onEvent({ type: 'agent_start', data: { agent: agentName } });

        const agentConfig = this.agentRegistry.get(agentName);
        const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
        const history = this.sessionManager.getMessagesForAgent(session.id, agentName);

        let adapter;
        if (agentConfig.type === 'cli') {
          adapter = this.adapters.cli;
        } else {
          adapter = this.adapters.api;
        }

        // 使用流式调用
        const response = await this._callAgentStream(
          session, agentName, userMessage, onEvent
        );

        // 记录回复到会话
        this.sessionManager.addMessage(session.id, {
          role: 'assistant',
          agent: agentName,
          content: response.text,
        });

        results.push({ agent: agentName, ...response });
        onEvent({ type: 'agent_done', data: { agent: agentName, text: response.text } });
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
        onEvent({ type: 'agent_error', data: { agent: agentName, error: err.message } });
      }
    }

    onEvent({ type: 'done', data: { results } });
    return results;
  }

  // 广播模式
  async _broadcast(session, userMessage) {
    const results = [];
    const promises = session.agents.map(async (agentName) => {
      try {
        const result = await this._callAgent(session, agentName, userMessage);
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: agentName, content: result.text,
        });
        results.push({ agent: agentName, ...result });
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
      }
    });
    await Promise.all(promises);
    return results;
  }

  // 定向模式
  async _direct(session, userMessage) {
    const match = userMessage.match(/^@(\w[\w-]*)\s+(.*)/s);
    if (!match) return this._broadcast(session, userMessage);

    const targetAgent = match[1];
    const actualMessage = match[2];
    if (!session.agents.includes(targetAgent)) {
      return [{ error: `Agent "${targetAgent}" 不在当前会话中` }];
    }

    const result = await this._callAgent(session, targetAgent, actualMessage);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetAgent, content: result.text,
    });
    return [{ agent: targetAgent, ...result }];
  }

  // 串联模式
  async _chain(session, userMessage) {
    const results = [];
    let currentInput = userMessage;

    for (const agentName of session.agents) {
      try {
        const result = await this._callAgent(session, agentName, currentInput);
        currentInput = result.text;
        this.sessionManager.addMessage(session.id, {
          role: 'assistant', agent: agentName, content: result.text,
        });
        results.push({ agent: agentName, ...result });
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
        break;
      }
    }
    return results;
  }

  // 主模型模式
  async _masterMode(session, userMessage) {
    if (session.agents.length === 0) return [];
    const masterName = session.agents[0];
    const workers = session.agents.slice(1);

    if (workers.length === 0) return this._broadcast(session, userMessage);

    const taskPlan = await this._callAgent(session, masterName,
      `你是组长，需要分配任务给以下助手：${workers.join(', ')}\n` +
      `用户需求：${userMessage}\n请输出任务分配计划，格式：\n` +
      `@助手A: 任务描述\n@助手B: 任务描述`
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: masterName, content: taskPlan.text,
    });

    const assignments = this._parseAssignments(taskPlan.text);
    const workerResults = await Promise.all(
      assignments.map(async ({ agent, task }) => {
        if (!workers.includes(agent)) return { agent, error: '不是你的任务' };
        try {
          const result = await this._callAgent(session, agent, task);
          this.sessionManager.addMessage(session.id, {
            role: 'assistant', agent, content: result.text,
          });
          return { agent, ...result };
        } catch (err) {
          return { agent, error: err.message };
        }
      })
    );
    return { master: taskPlan, workers: workerResults };
  }

  _parseAssignments(text) {
    const pattern = /@(\w[\w-]*):\s*(.+?)(?=\n@|\n*$)/gs;
    const assignments = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      assignments.push({ agent: match[1], task: match[2].trim() });
    }
    return assignments;
  }

  // 非流式单次 Agent 调用
  async _callAgent(session, agentName, message) {
    const agentConfig = this.agentRegistry.get(agentName);
    const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
    const history = this.sessionManager.getMessagesForAgent(session.id, agentName);

    let adapter;
    if (agentConfig.type === 'cli') {
      adapter = this.adapters.cli;
    } else {
      adapter = this.adapters.api;
    }

    const response = await adapter.call(agentConfig, {
      message, toolsPrompt, history,
      sharedDir: session.sharedDir, outputDir: session.outputDir,
    });

    let finalText = response.text;
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults = await this.toolExecutor.executeBatch(
        response.toolCalls, agentConfig.hands,
        session.sharedDir, session.outputDir
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
          session.sharedDir, session.outputDir
        );
        const cleanText = this.toolExecutor.stripToolMarkers(response.text);
        finalText = cleanText + '\n\n[工具执行结果：' + JSON.stringify(toolResults) + ']';
      }
    }

    return { text: finalText || '[无回复]' };
  }

  // 流式单次 Agent 调用 — 通过 onEvent 推送实时文本
  async _callAgentStream(session, agentName, message, onEvent) {
    const agentConfig = this.agentRegistry.get(agentName);
    const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
    const history = this.sessionManager.getMessagesForAgent(session.id, agentName);

    let adapter;
    if (agentConfig.type === 'cli') {
      adapter = this.adapters.cli;
      // CLI 不支持流式，用非流式
      const response = await adapter.call(agentConfig, {
        message, toolsPrompt, history,
        sharedDir: session.sharedDir, outputDir: session.outputDir,
      });
      if (response.text) {
        onEvent({ type: 'text', data: { agent: agentName, text: response.text } });
      }
      return response;
    }

    // API 流式调用
    const response = await adapter.callStream(agentConfig, {
      message, toolsPrompt, history,
      sharedDir: session.sharedDir, outputDir: session.outputDir,
    }, (event) => {
      // 转发流式事件（带 agent 字段）
      if (event.type === 'text') {
        onEvent({ type: 'text', data: { agent: agentName, text: event.data.text } });
      } else if (event.type === 'thinking') {
        onEvent({ type: 'thinking', data: { agent: agentName } });
      } else if (event.type === 'tool_calls') {
        onEvent({ type: 'tool_calls', data: { agent: agentName, toolCalls: event.data.toolCalls } });
      } else if (event.type === 'error') {
        onEvent({ type: 'agent_error', data: { agent: agentName, error: event.data.error } });
      }
    });

    // 处理 tool_calls（如果有）
    let finalText = response.text;
    if (response.toolCalls && response.toolCalls.length > 0) {
      onEvent({ type: 'tool_executing', data: { agent: agentName, toolCalls: response.toolCalls } });

      const toolResults = await this.toolExecutor.executeBatch(
        response.toolCalls, agentConfig.hands,
        session.sharedDir, session.outputDir
      );

      onEvent({ type: 'tool_result', data: { agent: agentName, results: toolResults } });

      // 把工具结果塞回模型
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
      // 推送续写文本
      if (continued.text) {
        onEvent({ type: 'text', data: { agent: agentName, text: continued.text } });
      }
    }

    return { text: finalText || '[无回复]' };
  }
}

module.exports = Orchestrator;
