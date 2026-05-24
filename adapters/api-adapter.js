// ============================================================
// API Adapter — API 模型适配器
// ============================================================
// 调用云端大模型 API（OpenAI 兼容接口）。
// 支持流式 SSE 读取（callStream）和普通调用（call）。
// 兼容不同供应商的 baseUrl 格式（含 /v1 或裸 domain）。
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

  // 调用 API 模型（非流式）
  async call(agentConfig, { message, toolsPrompt, history, sharedDir, outputDir }) {
    const provider = this._resolveProvider(agentConfig);
    const messages = this._buildMessages(agentConfig, message, toolsPrompt, history, outputDir);
    const tools = this._buildToolsFromPrompt(agentConfig.hands);

    const body = {
      model: agentConfig.model,
      messages,
      stream: false,
      max_tokens: 4096,
    };

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

  // 流式调用 API 模型 — 通过 onEvent 回调推送阶段性事件
  // onEvent: ({ type: 'thinking'|'text'|'tool_calls'|'tool_result'|'error'|'done', data })
  async callStream(agentConfig, { message, toolsPrompt, history, sharedDir, outputDir }, onEvent) {
    const provider = this._resolveProvider(agentConfig);
    const messages = this._buildMessages(agentConfig, message, toolsPrompt, history, outputDir);
    const tools = this._buildToolsFromPrompt(agentConfig.hands);

    const body = {
      model: agentConfig.model,
      messages,
      stream: true,
      max_tokens: 4096,
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    try {
      onEvent({ type: 'thinking', data: { agent: agentConfig.name } });

      const startTime = Date.now();
      const response = await this._requestStream(provider, agentConfig.apiKey, body, (chunk) => {
        onEvent({ type: 'text', data: { agent: agentConfig.name, text: chunk } });
      });

      // 如果返回了 tool_calls，发事件
      if (response.toolCalls?.length > 0) {
        onEvent({ type: 'tool_calls', data: { agent: agentConfig.name, toolCalls: response.toolCalls } });
      }

      const elapsed = Date.now() - startTime;
      onEvent({ type: 'done', data: { agent: agentConfig.name, elapsed } });

      return response;
    } catch (err) {
      console.error(`[ApiAdapter] ❌ 流式调用 ${agentConfig.name} 失败:`, err.message);
      onEvent({ type: 'error', data: { agent: agentConfig.name, error: err.message } });
      return { text: '', toolCalls: [] };
    }
  }

  _resolveProvider(agentConfig) {
    if (agentConfig.baseUrl) {
      let baseUrl = agentConfig.baseUrl.replace(/\/+$/, '');
      if (!baseUrl.endsWith('/chat/completions')) {
        baseUrl += '/chat/completions';
      }
      return {
        baseUrl,
        chatPath: '',
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
          `用户说"列出目录"，你应该调用 list_files 工具。\n` +
          `用户说"执行命令"或"运行终端"，你应该调用 execute_command 工具。\n` +
          `用户说"搜索"或"查资料"，你应该调用 web_search 工具。\n\n` : '\n') +
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

  // 非流式请求
  _request(provider, apiKey, body) {
    return new Promise((resolve, reject) => {
      let requestUrl;
      if (provider.chatPath) {
        requestUrl = new URL(provider.chatPath, provider.baseUrl);
      } else {
        requestUrl = new URL(provider.baseUrl);
      }
      const isHttps = requestUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const postData = JSON.stringify(body);

      const options = {
        hostname: requestUrl.hostname,
        port: requestUrl.port || (isHttps ? 443 : 80),
        path: requestUrl.pathname + requestUrl.search,
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

  // 流式请求 — 解析 SSE 流
  _requestStream(provider, apiKey, body, onChunk) {
    return new Promise((resolve, reject) => {
      let requestUrl;
      if (provider.chatPath) {
        requestUrl = new URL(provider.chatPath, provider.baseUrl);
      } else {
        requestUrl = new URL(provider.baseUrl);
      }
      const isHttps = requestUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const postData = JSON.stringify(body);

      const options = {
        hostname: requestUrl.hostname,
        port: requestUrl.port || (isHttps ? 443 : 80),
        path: requestUrl.pathname + requestUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData),
          'Accept': 'text/event-stream',
        },
      };

      const result = { text: '', toolCalls: [] };
      let buffer = '';

      const req = lib.request(options, (res) => {
        res.setEncoding('utf-8');

        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留不完整的行

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6).trim();

            // 结束标记
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;

              // 文本内容
              if (delta.content) {
                result.text += delta.content;
                onChunk(delta.content);
              }

              // tool_calls
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    // 新工具调用开始
                    result.toolCalls.push({
                      index: tc.index || 0,
                      name: tc.function.name,
                      arguments: '',
                    });
                  } else if (tc.function?.arguments) {
                    // 追加参数
                    const existing = result.toolCalls.find(t => t.index === (tc.index || 0));
                    if (existing) {
                      existing.arguments += tc.function.arguments;
                    }
                  }
                }
              }
            } catch {
              // 解析失败，跳过
            }
          }
        });

        res.on('end', () => {
          // 解析 tool_calls 参数为 JSON
          for (const tc of result.toolCalls) {
            try {
              tc.arguments = JSON.parse(tc.arguments || '{}');
            } catch {
              tc.arguments = {};
            }
            delete tc.index;
          }
          resolve(result);
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = ApiAdapter;
