// ============================================================
// API Adapter — 适配 API 类型模型（DeepSeek/GPT/Claude 等）
// ============================================================
// 处理 OpenAI 兼容格式的 API 调用
// 支持原生 Function Calling
// ============================================================

const https = require('https');
const http = require('http');

class ApiAdapter {
  constructor() {
    this.providers = {
      deepseek: { baseUrl: 'https://api.deepseek.com', chatPath: '/v1/chat/completions' },
      openai:   { baseUrl: 'https://api.openai.com',    chatPath: '/v1/chat/completions' },
      anthropic: { baseUrl: 'https://api.anthropic.com', chatPath: '/v1/messages' },
    };
  }

  // 调用 API 模型
  async call(agentConfig, { message, toolsPrompt, history, sharedDir }) {
    const provider = this._resolveProvider(agentConfig);
    const messages = this._buildMessages(agentConfig, message, toolsPrompt, history);

    // 构建工具定义（给模型看的 function calling schema）
    const tools = this._buildToolsFromPrompt(toolsPrompt);

    const body = {
      model: agentConfig.model,
      messages,
      stream: false,
      max_tokens: 4096,
    };

    // 有工具定义且模型支持 function calling 时传 tools
    if (tools.length > 0) {
      body.tools = tools;
    }

    try {
      const response = await this._request(provider, agentConfig.apiKey, body);
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

  _buildMessages(agentConfig, message, toolsPrompt, history) {
    const systemMsg = {
      role: 'system',
      content: `你是 ${agentConfig.name}，一个 AI 助手。\n${toolsPrompt}\n\n` +
        `共享文件库目录: ${agentConfig._sharedDir || '/shared'}\n` +
        `你可以使用上述工具读写文件、搜索网络等。` +
        (message ? `\n\n用户说：${message}` : ''),
    };

    const historyMsgs = history.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    }));

    return [systemMsg, ...historyMsgs];
  }

  _buildToolsFromPrompt(toolsPrompt) {
    // 从 toolsPrompt 文本解析出 tools 定义
    // 实际应该从 HandLoader 直接拿 schema，这里简化处理
    return []; // 不传 tools，让模型在文本里输出 [TOOL] 格式
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
