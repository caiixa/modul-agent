// ============================================================
// API Adapter — 适配 API 类型模型（DeepSeek/GPT/Claude 等）
// ============================================================
// 处理 OpenAI 兼容格式的 API 调用
// 支持原生 Function Calling
// ============================================================

const https = require('https');
const http = require('http');

class ApiAdapter {
  constructor(handLoader) {
    this.handLoader = handLoader;
    this.providers = {
      deepseek: { baseUrl: 'https://api.deepseek.com', chatPath: '/v1/chat/completions' },
      openai:   { baseUrl: 'https://api.openai.com',    chatPath: '/v1/chat/completions' },
      anthropic: { baseUrl: 'https://api.anthropic.com', chatPath: '/v1/messages' },
    };
  }

  // 调用 API 模型
  async call(agentConfig, { message, toolsPrompt, history, sharedDir, outputDir }) {
    const provider = this._resolveProvider(agentConfig);
    const messages = this._buildMessages(agentConfig, message, toolsPrompt, history, outputDir);

    // 构建工具定义（给模型看的 function calling schema）
    const tools = this._buildToolsFromPrompt(agentConfig.hands);

    const body = {
      model: agentConfig.model,
      messages,
      stream: false,
      max_tokens: 4096,
    };

    // 有工具定义且模型支持 function calling 时传 tools
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    try {
      console.log(`[ApiAdapter] ▶️ 调用 ${agentConfig.name} tools=${tools.length} msg=${(message||'').slice(0,50)}`);
      const startTime = Date.now();
      const response = await this._request(provider, agentConfig.apiKey, body);
      console.log(`[ApiAdapter] ✅ ${agentConfig.name} 回复 (${Date.now()-startTime}ms) tool_calls=${response.choices?.[0]?.message?.tool_calls?.length || 0}`);
      const choice = response.choices?.[0] || response.content?.[0] || {};
      
      const result = { text: '', toolCalls: [] };

      // 处理 tool_calls（function calling）
      if (choice.message?.tool_calls?.length > 0) {
        result.toolCalls = choice.message.tool_calls.map(tc => ({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        }));
        result.text = choice.message.content || '';
      } else {
        result.text = choice.message?.content || choice.text || '';
      }

      return result;
    } catch (err) {
      console.error(`[ApiAdapter] ❌ 调用 ${agentConfig.name} 失败:`, err.message);
      return { text: `[调用失败: ${err.message}]`, toolCalls: [] };
    }
  }

  _resolveProvider(agentConfig) {
    if (agentConfig.baseUrl) {
      return {
        baseUrl: agentConfig.baseUrl,
        chatPath: '/v1/chat/completions',
      };
    }
    return this.providers[agentConfig.provider] || this.providers.openai;
  }

  _buildMessages(agentConfig, message, toolsPrompt, history, outputDir) {
    const hasTools = agentConfig.hands && agentConfig.hands.length > 0;
    const systemMsg = {
      role: 'system',
      content: `你是 ${agentConfig.name}，一个 AI 助手，可以调用工具来完成用户的需求。` +
        (hasTools ? `\n\n你有以下工具可用：\n${toolsPrompt}\n\n` +
          `当用户要求操作文件时，请使用工具来完成，不要只是口头答应。\n` +
          `例如用户说"读文件"，你应该调用 read_file 工具。\n` +
          `用户说"写文件"，你应该调用 write_file 工具。\n` +
          `用户说"列出目录"，你应该调用 list_files 工具。\n\n` : '\n') +
        `共享文件库目录: ${agentConfig._sharedDir || '/shared'}\n` +
        (outputDir ? `产出目录（用户想要的文件请写到这里）: ${outputDir}\n` +
          `重要：写文件到产出目录时，请在 write_file 的 path 参数中使用完整绝对路径，例如 "${outputDir}/文件名.txt"\n` : ''),
    };

    const historyMsgs = history.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    }));

    return [systemMsg, ...historyMsgs];
  }

  _buildToolsFromPrompt(agentHands) {
    const tools = [];
    if (!this.handLoader || !agentHands) return tools;
    for (const handName of agentHands) {
      const hand = this.handLoader.get(handName);
      if (!hand) continue;
      for (const [toolName, tool] of Object.entries(hand.tools)) {
        const properties = {};
        const required = [];
        if (tool.parameters) {
          for (const [key, param] of Object.entries(tool.parameters)) {
            properties[key] = {
              type: param.type || 'string',
              description: param.description || '',
            };
            // 有 default 的不是必填
            if (!('default' in param)) required.push(key);
          }
        }
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: tool.description || '',
            parameters: {
              type: 'object',
              properties,
              required,
            },
          },
        });
      }
    }
    return tools;
  }

  _request(provider, apiKey, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(provider.chatPath, provider.baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const postData = JSON.stringify(body);

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`API 返回非 JSON: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = ApiAdapter;
