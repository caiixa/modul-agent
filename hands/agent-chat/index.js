// ============================================================
// agent-chat Hand — Agent 间通信工具插件
// ============================================================
// 让 AI 模型可以互相交流：A 模型向 B 模型提问。
// 依赖 session._orchestrator 实现跨 Agent 调用。
// 1 个工具：agent_chat
// ============================================================

const agentChatHand = {
  name: 'agent-chat',
  description: 'Agent 间通信 — 让模型互相讨论和协作',
  tools: {
    agent_chat: {
      description: '向会话中的另一个 Agent 提问并获取回答。适用于协作讨论、代码审查、寻求意见等场景。使用示例：agent_chat("deepseek", "帮我审查一下这段代码有什么问题")',
      parameters: {
        target_agent: {
          type: 'string',
          description: '目标 Agent 名称（必须在这个会话中）',
        },
        question: {
          type: 'string',
          description: '你要问的问题或讨论的内容',
        },
      },
      execute: async ({ target_agent, question, session }) => {
        // session 由 tool-executor 通过 params.session 注入
        if (!session || !session._orchestrator) {
          return { result: `[agent_chat] 无法通信：运行时未注入 orchestrator` };
        }
        const orch = session._orchestrator;
        const fromAgent = session._callingAgent || 'unknown';
        const reply = await orch._agentChat(session, fromAgent, target_agent, question);
        return { result: `@${target_agent} 的回复：\n${reply}` };
      },
    },
  },
};

module.exports = agentChatHand;
