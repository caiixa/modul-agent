// ============================================================
// Tool Executor — 工具执行引擎
// ============================================================
// 解析模型的工具调用请求，找到对应的 Hand 并执行
// 支持两种模式：
//   1. 原生 Function Calling（DeepSeek/GPT/Claude）
//   2. 文本指令解析（不支持 function calling 的模型）
// ============================================================

class ToolExecutor {
  constructor(handLoader) {
    this.handLoader = handLoader;
  }

  // 执行一次工具调用
  // toolCall: { name: "read_file", arguments: { path: "/tmp/x" } }
  async execute(toolCall, agentHands, sharedDir, outputDir) {
    const toolName = toolCall.name || toolCall.action;
    const params = toolCall.arguments || toolCall.parameters || {};
    if (sharedDir) params.sharedDir = sharedDir;
    if (outputDir) params.outputDir = outputDir;

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
  async executeBatch(toolCalls, agentHands, sharedDir, outputDir) {
    const results = [];
    for (const call of toolCalls) {
      const result = await this.execute(call, agentHands, sharedDir, outputDir);
      results.push(result);
    }
    return results;
  }

  // 解析不支持 function calling 的模型输出的文本指令
  // 格式：[TOOL] 工具名(参数JSON) [/TOOL]
  // 例如：[TOOL] read_file({"path":"data.txt"}) [/TOOL]
  parseTextToolCalls(text) {
    const pattern = /\[TOOL\]\s*(\w+)\s*\(\s*({.*?})\s*\)\s*\[\/TOOL\]/gs;
    const calls = [];
    let match;

    while ((match = pattern.exec(text)) !== null) {
      try {
        calls.push({
          name: match[1],
          arguments: JSON.parse(match[2]),
        });
      } catch {
        // 解析失败，跳过
        console.warn(`[ToolExec] ⚠️ 解析工具调用失败: ${match[0]}`);
      }
    }

    return calls;
  }

  // 清洗文本中的工具调用标记（返回纯文本）
  stripToolMarkers(text) {
    return text.replace(/\[TOOL\].*?\[\/TOOL\]/gs, '').trim();
  }
}

module.exports = ToolExecutor;
