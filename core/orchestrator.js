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
    // 注入 orchestrator 引用供 agent_chat 工具使用
    session._orchestrator = this;

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

  // 流式单次 Agent 调用 — 通过 onEvent 推送实时文本
  async _callAgentStream(session, agentName, message, onEvent) {
    const agentConfig = this.agentRegistry.get(agentName);
    // 注入 orchestrator 引用供 agent_chat 工具使用
    session._orchestrator = this;

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
    adapter = this.adapters.api;
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
        session.sharedDir, session.outputDir, session
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

  // ==================== 路由模式 ====================
  async _routerMode(session, userMessage) {
    if (session.agents.length === 0) return [];
    const routerName = session.agents[0];
    const workers = session.agents.slice(1);
    if (workers.length === 0) return this._broadcast(session, userMessage);

    // 用第一个模型做路由器，分析用户输入
    const routePlan = await this._callAgent(session, routerName,
      `你是智能路由分配器。分析用户消息，从以下助手中选择最合适的一个执行任务。\n\n` +
      `可用助手：\n${workers.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\n` +
      `用户消息：${userMessage}\n\n` +
      `请根据每个助手的专长选择最匹配的助手。只回复助手名称，不要多余文字。\n` +
      `格式：@助手名`
    );

    const targetMatch = routePlan.text.match(/@(\w[\w-]*)/);
    const targetName = targetMatch ? targetMatch[1] : workers[0];

    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: routerName,
      content: `📡 智能路由：将任务分配给了 @${targetName}`,
    });

    if (!session.agents.includes(targetName)) {
      return [{ error: `路由器选择的 "${targetName}" 不在会话中` }];
    }

    const result = await this._callAgent(session, targetName, userMessage);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: targetName, content: result.text,
    });
    return [{ router: routerName, target: targetName, result }];
  }

  // ==================== 辩论模式 ====================
  async _debateMode(session, userMessage) {
    if (session.agents.length < 2) return this._broadcast(session, userMessage);

    // 各自回答
    const allResults = [];
    for (const agentName of session.agents) {
      const result = await this._callAgent(session, agentName, userMessage);
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: agentName, content: result.text,
      });
      allResults.push({ agent: agentName, text: result.text });
    }

    // 用第一个模型投票
    const judgeName = session.agents[0];
    const judgePrompt = `你是裁判。以下是多个 AI 助手对同一个问题的回答。请投票选出最佳答案并说明理由。\n\n` +
      `问题：${userMessage}\n\n` +
      allResults.map(r => `--- ${r.agent} 的回答 ---\n${r.text}`).join('\n\n') +
      `\n\n请选出最佳回答，格式：\n🏆 最佳：@助手名\n理由：...`;

    const judgeResult = await this._callAgent(session, judgeName, judgePrompt);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: judgeName,
      content: `🏆 辩论裁决：\n${judgeResult.text}`,
    });

    return { answers: allResults, verdict: { judge: judgeName, text: judgeResult.text } };
  }

  // ==================== 工作流模式 ====================
  async _workflowMode(session, userMessage) {
    if (session.agents.length === 0) return [];

    const results = [];
    let currentInput = userMessage;

    for (let i = 0; i < session.agents.length; i++) {
      const agentName = session.agents[i];
      const stepMessage = (i === 0)
        ? userMessage
        : `上一步结果：\n${currentInput}\n\n请继续处理。` +
          (i < session.agents.length - 1 ? ' 处理完后将结果传递给下一步。' : ' 这是最后一步，请给出完整的最终输出。');

      const result = await this._callAgent(session, agentName, stepMessage);
      currentInput = result.text;
      this.sessionManager.addMessage(session.id, {
        role: 'assistant', agent: agentName,
        content: `[步骤 ${i + 1}/${session.agents.length}] ${result.text}`,
      });
      results.push({ agent: agentName, step: i + 1, text: result.text });
    }

    return { workflow: results, finalOutput: currentInput };
  }

  // ==================== Agent 间通信 ====================
  // 让模型 A 向模型 B 提问，并返回 B 的回答
  async _agentChat(session, fromAgent, toAgent, question) {
    if (!session.agents.includes(toAgent)) {
      return `[错误: Agent "${toAgent}" 不在当前会话中]`;
    }
    const result = await this._callAgent(session, toAgent,
      `[来自 ${fromAgent} 的消息]\n${question}\n\n请直接回答。`
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant', agent: toAgent,
      content: `💬 @${fromAgent} → @${toAgent}: ${result.text}`,
    });
    return result.text;
  }

  // Agent 间通信的 Hand 工具
  getAgentChatTool() {
    return {
      name: 'agent_chat',
      description: '向会话中的另一个 Agent 提问，并获取它的回答。适用于协作讨论、代码审查等场景。',
      parameters: {
        target_agent: { type: 'string', description: '目标 Agent 名称（必须在这个会话中）' },
        question: { type: 'string', description: '你要问的问题或讨论的内容' },
      },
      execute: async ({ target_agent, question }, { sharedDir }) => {
        // 运行时从 orchestrator 获取
        // execute 由 tool-executor 调用，通过闭包注入 session
      },
    };
  }
}

module.exports = Orchestrator;
