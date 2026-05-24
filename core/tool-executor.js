// ============================================================
// Tool Executor — 工具执行器
// ============================================================
// 根据模型返回的 tool_calls，找到对应 Hand 并执行
// ============================================================

class ToolExecutor {
  constructor(handLoader) {
    this.handLoader = handLoader;
  }

  // 执行一次工具调用
  // toolCall: { name: "read_file", arguments: { path: "/tmp/x" } }
  async execute(toolCall, agentHands, sharedDir, outputDir, session) {
    const toolName = toolCall.name || toolCall.action;
    const params = toolCall.arguments || toolCall.parameters || {};
    if (sharedDir) params.sharedDir = sharedDir;
    if (outputDir) params.outputDir = outputDir;
    if (session) {
      params.session = session;
    }

    // 查找这个工具属于哪个 Hand
    const handName = this.handLoader.findHandForTool(toolName);
    if (!handName) {
      return {
        tool: toolName,
        error: `未知工具 "${toolName}"`,
        success: false,
      };
    }

    // 检查该 Agent 是否挂载了这个 Hand
    if (!agentHands.includes(handName)) {
      return {
        tool: toolName,
        error: `权限不足：Agent 未挂载 "${handName}" Hand，无法使用工具 "${toolName}"`,
        success: false,
      };
    }

    // 执行
    const hand = this.handLoader.get(handName);
    try {
      const raw = await hand.tools[toolName].execute(params);
      console.log(`[ToolExec] 🔧 ${toolName}(${JSON.stringify(params)}) → 成功`);
      return {
        tool: toolName,
        result: raw.result !== undefined ? raw.result : raw,
        success: true,
      };
    } catch (err) {
      console.error(`[ToolExec] ❌ ${toolName} 执行失败:`, err.message);
      return {
        tool: toolName,
        error: err.message,
        success: false,
      };
    }
  }

  // 执行多个工具调用（一个模型回复可能包含多次工具调用）
  async executeBatch(toolCalls, agentHands, sharedDir, outputDir, session) {
    const results = [];
    for (const call of toolCalls) {
      const result = await this.execute(call, agentHands, sharedDir, outputDir, session);
      results.push(result);
    }
    return results;
  }

  // 从文本中解析工具调用标记（兼容非 tool_calls 的模型）
  parseTextToolCalls(text) {
    const calls = [];
    const regex = /```tool_call\s*\n({[\s\S]*?})\n```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        calls.push(JSON.parse(match[1]));
      } catch {}
    }
    return calls;
  }

  // 从文本中移除工具调用标记
  stripToolMarkers(text) {
    return text.replace(/```tool_call\s*\n{[\s\S]*?}\n```/g, '').trim();
  }

  // 查找工具所属的 Hand 名称
  findHandForTool(toolName) {
    for (const [handName, hand] of this.handLoader.hands) {
      if (hand.tools && hand.tools[toolName]) {
        return handName;
      }
    }
    return null;
  }
}

module.exports = ToolExecutor;
