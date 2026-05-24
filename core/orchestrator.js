// ============================================================
// Orchestrator — 调度器
// ============================================================
// 决定"谁来干活"，支持多种调度模式
// ============================================================

class Orchestrator {
  constructor({ agentRegistry, sessionManager, toolExecutor, handLoader, adapters }) {
    this.agentRegistry = agentRegistry;
    this.sessionManager = sessionManager;
    this.toolExecutor = toolExecutor;
    this.handLoader = handLoader;
    this.adapters = adapters; // { api, cli }
  }

  // 处理用户消息
  async processMessage(sessionId, userMessage) {
    const session = this.sessionManager.get(sessionId);
    const mode = session.orchestrator;

    // 添加用户消息到历史
    this.sessionManager.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
    });

    switch (mode) {
      case 'broadcast':
        return this._broadcast(session, userMessage);
      case 'direct':
        return this._direct(session, userMessage);
      case 'chain':
        return this._chain(session, userMessage);
      case 'master':
        return this._masterMode(session, userMessage);
      default:
        return this._broadcast(session, userMessage);
    }
  }

  // 广播模式：消息发给所有 Agent
  async _broadcast(session, userMessage) {
    const results = [];

    // 并发调用所有 Agent
    const promises = session.agents.map(async (agentName) => {
      try {
        const result = await this._callAgent(session, agentName, userMessage);
        // 记录回复到会话
        this.sessionManager.addMessage(session.id, {
          role: 'assistant',
          agent: agentName,
          content: result.text,
        });
        results.push({ agent: agentName, ...result });
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
      }
    });

    await Promise.all(promises);
    return results;
  }

  // 定向模式：指定某个 Agent
  async _direct(session, userMessage) {
    // 解析消息开头的 @agentName
    const match = userMessage.match(/^@(\w[\w-]*)\s+(.*)/s);
    if (!match) {
      // 没有指定，默认发给所有
      return this._broadcast(session, userMessage);
    }

    const targetAgent = match[1];
    const actualMessage = match[2];

    if (!session.agents.includes(targetAgent)) {
      return [{ error: `Agent "${targetAgent}" 不在当前会话中` }];
    }

    const result = await this._callAgent(session, targetAgent, actualMessage);
    this.sessionManager.addMessage(session.id, {
      role: 'assistant',
      agent: targetAgent,
      content: result.text,
    });
    return [{ agent: targetAgent, ...result }];
  }

  // 串联模式：按顺序执行，上一步的输出作为下一步的输入
  async _chain(session, userMessage) {
    const results = [];
    let currentInput = userMessage;

    for (const agentName of session.agents) {
      try {
        const result = await this._callAgent(session, agentName, currentInput);
        currentInput = result.text; // 下个 Agent 收到上个的输出
        this.sessionManager.addMessage(session.id, {
          role: 'assistant',
          agent: agentName,
          content: result.text,
        });
        results.push({ agent: agentName, ...result });
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
        break; // 一个失败就停下
      }
    }

    return results;
  }

  // 主模型模式：第一个 Agent 当组长，分配任务
  async _masterMode(session, userMessage) {
    if (session.agents.length === 0) return [];
    
    const masterName = session.agents[0];
    const workers = session.agents.slice(1);

    if (workers.length === 0) {
      // 只有一个 Agent，退化为广播
      return this._broadcast(session, userMessage);
    }

    // 1. 让主模型决定怎么分配任务
    const taskPlan = await this._callAgent(session, masterName, 
      `你是组长，需要分配任务给以下助手：${workers.join(', ')}\n` +
      `用户需求：${userMessage}\n` +
      `请输出任务分配计划，格式：\n` +
      `@助手A: 任务描述\n` +
      `@助手B: 任务描述`
    );
    this.sessionManager.addMessage(session.id, {
      role: 'assistant',
      agent: masterName,
      content: taskPlan.text,
    });

    // 2. 解析任务分配
    const assignments = this._parseAssignments(taskPlan.text);

    // 3. 执行分配到各 Agent
    const workerResults = await Promise.all(
      assignments.map(async ({ agent, task }) => {
        if (!workers.includes(agent)) return { agent, error: '不是你的任务' };
        try {
          const result = await this._callAgent(session, agent, task);
          this.sessionManager.addMessage(session.id, {
            role: 'assistant',
            agent: agent,
            content: result.text,
          });
          return { agent, ...result };
        } catch (err) {
          return { agent, error: err.message };
        }
      })
    );

    return { master: taskPlan, workers: workerResults };
  }

  // 解析 @agent: task 格式
  _parseAssignments(text) {
    const pattern = /@(\w[\w-]*):\s*(.+?)(?=\n@|\n*$)/gs;
    const assignments = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      assignments.push({ agent: match[1], task: match[2].trim() });
    }
    return assignments;
  }

  // 调用单个 Agent
  async _callAgent(session, agentName, message) {
    const agentConfig = this.agentRegistry.get(agentName);

    // 获取该 Agent 挂载的 Hand 的工具定义
    const toolsPrompt = this.handLoader.generateToolsPrompt(agentConfig.hands);
    
    // 获取会话历史
    const history = this.sessionManager.getMessagesForAgent(session.id, agentName);

    // 选择合适的适配器
    let adapter;
    if (agentConfig.type === 'cli') {
      adapter = this.adapters.cli;
    } else {
      adapter = this.adapters.api;
    }

    // 调用
    const response = await adapter.call(agentConfig, {
      message,
      toolsPrompt,
      history,
      sharedDir: session.sharedDir,
    });

    // 处理工具调用（如果有）
    let finalText = response.text;
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults = await this.toolExecutor.executeBatch(
        response.toolCalls,
        agentConfig.hands
      );

      // 把工具执行结果塞回给模型，继续推理
      const continued = await adapter.call(agentConfig, {
        message: null,
        toolsPrompt,
        history: [
          ...history,
          { role: 'assistant', content: response.text },
          { role: 'tool', content: JSON.stringify(toolResults) },
        ],
        sharedDir: session.sharedDir,
      });

      finalText = continued.text || response.text;
    }

    // 检查是否有文本格式的工具调用（不支持 function calling 的模型）
    if (!response.toolCalls) {
      const parsedCalls = this.toolExecutor.parseTextToolCalls(response.text);
      if (parsedCalls.length > 0) {
        const toolResults = await this.toolExecutor.executeBatch(
          parsedCalls,
          agentConfig.hands
        );

        const cleanText = this.toolExecutor.stripToolMarkers(response.text);
        finalText = cleanText + '\n\n[工具执行结果：' + JSON.stringify(toolResults) + ']';
      }
    }

    return { text: finalText || '[无回复]' };
  }
}

module.exports = Orchestrator;
