// ============================================================
// WebSocket 服务器 — Modul Agent Web UI 后端
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const ModulAgent = require('../core/index.js');

const PORT = process.env.PORT || 18888;
const PUBLIC_DIR = path.join(__dirname, 'public');

class ModulWebServer {
  constructor(app) {
    this.app = app;
    this.server = null;
    this.wss = null;
    this.wsClients = new Map(); // ws -> { sessionId, ... }
  }

  start() {
    // HTTP 服务器
    this.server = http.createServer((req, res) => {
      this._handleHttp(req, res);
    });

    // WebSocket
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      this._handleWs(ws);
    });

    this.server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  🧠 Modul Agent Web UI`);
      console.log(`  ──────────────────────`);
      console.log(`  🌐 http://192.168.10.152:${PORT}`);
      console.log(`  📡 WebSocket: ws://192.168.10.152:${PORT}\n`);
    });
  }

  // ====== HTTP ======
  _handleHttp(req, res) {
    const url = req.url;
    const method = req.method;

    // API: 获取系统状态
    if (url === '/api/status' && method === 'GET') {
      return this._json(res, 200, this.app.status());
    }

    // API: 获取模型供应商列表（预置模板）
    if (url === '/api/providers' && method === 'GET') {
      return this._json(res, 200, this._getProviderTemplates());
    }

    // API: 获取 Agent 列表
    if (url === '/api/agents' && method === 'GET') {
      return this._json(res, 200, this.app.registry.list());
    }

    // API: 获取 Agent 详情
    const agentDetailMatch = url.match(/^\/api\/agents\/(.+)$/);
    if (agentDetailMatch && method === 'GET') {
      try {
        const detail = this.app.registry.getDetail(decodeURIComponent(agentDetailMatch[1]));
        return this._json(res, 200, detail);
      } catch {
        return this._json(res, 404, { error: 'Agent not found' });
      }
    }

    // API: 注册新 Agent
    if (url === '/api/agents' && method === 'POST') {
      return this._parseBody(req).then(body => {
        try {
          const agent = this.app.registry.register(body.name || body.model, body);
          return this._json(res, 200, { ok: true, agent });
        } catch (err) {
          return this._json(res, 400, { error: err.message });
        }
      });
    }

    // API: 更新 Agent
    if (agentDetailMatch && method === 'PUT') {
      return this._parseBody(req).then(body => {
        try {
          const agent = this.app.registry.update(decodeURIComponent(agentDetailMatch[1]), body);
          return this._json(res, 200, { ok: true, agent });
        } catch (err) {
          return this._json(res, 400, { error: err.message });
        }
      });
    }

    // API: 删除 Agent
    if (agentDetailMatch && method === 'DELETE') {
      try {
        this.app.registry.remove(decodeURIComponent(agentDetailMatch[1]));
        return this._json(res, 200, { ok: true });
      } catch (err) {
        return this._json(res, 400, { error: err.message });
      }
    }

    // API: 获取模型供应商列表（预置模板）
    if (url === '/api/providers' && method === 'GET') {
      return this._json(res, 200, this._getProviderTemplates());
    }

    // API: 获取会话列表
    if (url === '/api/sessions' && method === 'GET') {
      return this._json(res, 200, this.app.sessions.list());
    }

    // API: 获取 Hand 列表（已加载的 Hand 插件）
    if (url === '/api/hands' && method === 'GET') {
      const hands = {};
      for (const [name, hand] of this.app.hands.hands) {
        hands[name] = {
          name: hand.name,
          description: hand.description,
          tools: Object.keys(hand.tools),
        };
      }
      return this._json(res, 200, hands);
    }

    // API: 获取工具管理页数据（所有已注册的工具）
    if (url === '/api/tools' && method === 'GET') {
      const hands = {};
      for (const [name, hand] of this.app.hands.hands) {
        hands[name] = {
          name: hand.name,
          description: hand.description,
          tools: Object.keys(hand.tools),
        };
      }
      return this._json(res, 200, {
        hands,
        // 每个 Agent 当前挂载的 Hand
        agentHands: this._getAgentHands(),
      });
    }

    // API: 给 Agent 挂载/卸载 Hand
    const agentHandMatch = url.match(/^\/api\/tools\/(.+)\/agents\/(.+)$/);
    if (agentHandMatch && method === 'PUT') {
      return this._parseBody(req).then(body => {
        try {
          const handName = decodeURIComponent(agentHandMatch[1]);
          const agentName = decodeURIComponent(agentHandMatch[2]);
          const action = body.action || 'mount'; // mount | unmount
          const agent = this.app.registry.get(agentName);
          let hands = agent.hands || [];
          if (action === 'mount') {
            if (!hands.includes(handName)) hands.push(handName);
          } else {
            hands = hands.filter(h => h !== handName);
          }
          this.app.registry.update(agentName, { hands });
          return this._json(res, 200, { ok: true, agent: this.app.registry.getDetail(agentName) });
        } catch (err) {
          return this._json(res, 400, { error: err.message });
        }
      });
    }

    // API: 列出所有已注册的工具（绑定信息）
    const toolsHandBindMatch = url.match(/^\/api\/tools\/(.+)\/agents$/);
    if (toolsHandBindMatch && method === 'GET') {
      try {
        const handName = decodeURIComponent(toolsHandBindMatch[1]);
        // 找出所有挂了此 Hand 的 Agent
        const agents = {};
        for (const [name, agent] of this.app.registry.agents) {
          if ((agent.hands || []).includes(handName)) {
            agents[name] = { name, type: agent.type, model: agent.model || agent.command };
          }
        }
        return this._json(res, 200, agents);
      } catch (err) {
        return this._json(res, 400, { error: err.message });
      }
    }

    // API: 获取会话详情
    const sessionMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)$/);
    if (sessionMatch && method === 'GET') {
      try {
        const session = this.app.getSession(sessionMatch[1]);
        return this._json(res, 200, {
          ...session,
          messages: session.messages.slice(-100),
        });
      } catch {
        return this._json(res, 404, { error: 'Session not found' });
      }
    }

    // API: 获取会话消息
    const msgMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)\/messages$/);
    if (msgMatch && method === 'GET') {
      try {
        const session = this.app.getSession(msgMatch[1]);
        return this._json(res, 200, session.messages.slice(-100));
      } catch {
        return this._json(res, 404, { error: 'Session not found' });
      }
    }

    // API: 创建会话
    if (url === '/api/sessions' && method === 'POST') {
      return this._parseBody(req).then(body => {
        const session = this.app.createSession({
          name: body.name || '新会话',
          agents: body.agents || [],
          orchestrator: body.orchestrator || 'broadcast',
        });
        return this._json(res, 200, session);
      });
    }

    // API: 发消息
    const sendMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)\/send$/);
    if (sendMatch && method === 'POST') {
      return this._parseBody(req).then(async body => {
        try {
          const results = await this.app.sendMessage(sendMatch[1], body.text);
          return this._json(res, 200, { results });
        } catch (err) {
          return this._json(res, 500, { error: err.message });
        }
      });
    }

    // API: 删除会话
    const delMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)$/);
    if (delMatch && method === 'DELETE') {
      this.app.sessions.delete(delMatch[1]);
      return this._json(res, 200, { ok: true });
    }

    // API: 给会话加 Agent
    const addMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)\/agents$/);
    if (addMatch && method === 'POST') {
      return this._parseBody(req).then(body => {
        try {
          const session = this.app.sessions.addAgent(addMatch[1], body.agent);
          return this._json(res, 200, session);
        } catch (err) {
          return this._json(res, 500, { error: err.message });
        }
      });
    }

    // API: 从会话移除 Agent
    const rmMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)\/agents\/(.+)$/);
    if (rmMatch && method === 'DELETE') {
      try {
        const session = this.app.sessions.removeAgent(rmMatch[1], decodeURIComponent(rmMatch[2]));
        return this._json(res, 200, session);
      } catch (err) {
        return this._json(res, 500, { error: err.message });
      }
    }

    // API: 设置调度模式
    const orchMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)\/orchestrator$/);
    if (orchMatch && method === 'PUT') {
      return this._parseBody(req).then(body => {
        try {
          const session = this.app.sessions.setOrchestrator(orchMatch[1], body.mode);
          return this._json(res, 200, session);
        } catch (err) {
          return this._json(res, 500, { error: err.message });
        }
      });
    }

    // API: 更新会话
    const updateSessionMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)$/);
    if (updateSessionMatch && method === 'PUT') {
      return this._parseBody(req).then(body => {
        try {
          const session = this.app.sessions.update(updateSessionMatch[1], body);
          return this._json(res, 200, session);
        } catch (err) {
          return this._json(res, 500, { error: err.message });
        }
      });
    }

    // API: 读取共享文件
    if (url.startsWith('/api/files/read') && method === 'GET') {
      const filePath = url.replace('/api/files/read?path=', '');
      try {
        const hand = this.app.hands.get('files');
        const result = hand.tools.read_file.execute({ path: decodeURIComponent(filePath) });
        return this._json(res, 200, result);
      } catch {
        return this._json(res, 404, { error: 'File not found' });
      }
    }

    // API: 列出所有会话的产出文件
    if (url === '/api/outputs' && method === 'GET') {
      return this._json(res, 200, this.app.sessions.listOutputs());
    }

    // API: 获取指定会话的产出文件
    const sessionOutputsMatch = url.match(/^\/api\/outputs\/([a-f0-9]+)$/);
    if (sessionOutputsMatch && method === 'GET') {
      try {
        const data = this.app.sessions.getSessionOutputs(sessionOutputsMatch[1]);
        return this._json(res, 200, data);
      } catch (err) {
        return this._json(res, 404, { error: err.message });
      }
    }

    // API: 读取产出文件内容（文本文件）
    const outputFileMatch = url.match(/^\/api\/outputs\/read\?path=(.+)$/);
    if (outputFileMatch && method === 'GET') {
      try {
        const filePath = decodeURIComponent(outputFileMatch[1]);
        const absPath = path.resolve(filePath);
        // 安全检查：必须在 outputs/ 目录内
        const outputsRoot = path.resolve(this.app.options.outputsRoot || path.join(__dirname, '..', 'outputs'));
        if (!absPath.startsWith(outputsRoot)) {
          return this._json(res, 403, { error: '越权访问' });
        }
        if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
          return this._json(res, 404, { error: '文件不存在' });
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        return this._json(res, 200, { content, path: absPath });
      } catch (e) {
        return this._json(res, 500, { error: e.message });
      }
    }

    // API: 下载产出文件
    const outputDownloadMatch = url.match(/^\/api\/outputs\/download\?path=(.+)$/);
    if (outputDownloadMatch && method === 'GET') {
      try {
        const filePath = decodeURIComponent(outputDownloadMatch[1]);
        const absPath = path.resolve(filePath);
        const outputsRoot = path.resolve(this.app.options.outputsRoot || path.join(__dirname, '..', 'outputs'));
        if (!absPath.startsWith(outputsRoot)) {
          return this._json(res, 403, { error: '越权访问' });
        }
        if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
          return this._json(res, 404, { error: '文件不存在' });
        }
        const name = path.basename(absPath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        });
        fs.createReadStream(absPath).pipe(res);
        return;
      } catch (e) {
        return this._json(res, 500, { error: e.message });
      }
    }

    // 静态文件
    if (url === '/' || url.startsWith('/')) {
      let filePath = url === '/' ? '/index.html' : url;
      const absPath = path.join(PUBLIC_DIR, filePath);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const ext = path.extname(absPath);
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        fs.createReadStream(absPath).pipe(res);
        return;
      }
    }

    // 404
    this._json(res, 404, { error: 'Not Found' });
  }

  // ====== WebSocket ======
  _handleWs(ws) {
    const client = { ws, sessionId: null };
    this.wsClients.set(ws, client);

    ws.on('message', async (raw) => {
      try {
        const pkt = JSON.parse(raw.toString());

        if (pkt.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (pkt.type === 'join') {
          client.sessionId = pkt.sessionId;
          ws.send(JSON.stringify({ type: 'joined', sessionId: pkt.sessionId }));
          return;
        }

        if (pkt.type === 'send') {
          const sessionId = client.sessionId || pkt.sessionId;
          if (!sessionId) {
            ws.send(JSON.stringify({ type: 'error', message: '未加入会话' }));
            return;
          }
          try {
            // 流式处理
            await this.app.orchestrator.processMessageStream(sessionId, pkt.text, (event) => {
              // 只发给当前客户端
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'stream', ...event }));
              }
            });
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
          return;
        }
      } catch {}
    });

    ws.on('close', () => {
      this.wsClients.delete(ws);
    });
  }

  _broadcastToSession(sessionId, data) {
    const msg = JSON.stringify(data);
    for (const [, client] of this.wsClients) {
      if (client.sessionId === sessionId && client.ws.readyState === 1) {
        client.ws.send(msg);
      }
    }
  }

  // ====== 工具 ======
  _getAgentHands() {
    const result = {};
    if (this.app.registry && this.app.registry.agents) {
      for (const [name, agent] of this.app.registry.agents) {
        if ((agent.hands || []).length > 0) {
          result[name] = { name, type: agent.type, model: agent.model || agent.command, hands: agent.hands };
        }
      }
    }
    return result;
  }

  _getProviderTemplates() {
    return {
      providers: [
        // ═══ 国内大模型 ═══
        {
          id: 'aliyun-bailian',
          name: '阿里云百炼（通义千问）',
          models: [
            'qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash',
            'qwen3.5-omni-plus', 'qwen-max-latest', 'qwen-plus', 'qwen-turbo',
            'qwen2.5-72b-instruct', 'qwen2.5-32b-instruct', 'qwen2.5-14b-instruct', 'qwen2.5-7b-instruct',
            'qwen2.5-coder-32b-instruct', 'qwen2.5-coder-14b-instruct',
            'qwen-vl-max', 'qwen-vl-plus',
            'qwen2-audio-instruct', 'text-embedding-v4',
          ],
          defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          type: 'api',
        },
        {
          id: 'zhipuai',
          name: '智谱AI（GLM）',
          models: [
            'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx',
            'glm-4.6', 'glm-4.5-air', 'glm-4.5-airx', 'glm-4-long',
            'glm-4.7-flash', 'glm-4-flashx-250414', 'glm-4-flash-250414',
            'glm-5v-turbo', 'glm-4.6v', 'glm-4.6v-flash',
            'glm-image', 'cogview-4', 'cogview-3-flash',
            'embedding-3', 'embedding-2',
          ],
          defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          type: 'api',
        },
        {
          id: 'baidu-qianfan',
          name: '百度千帆（ERNIE）',
          models: [
            'ernie-4.5-8k-preview', 'ernie-4.0-8k-preview', 'ernie-3.5-8k-preview',
            'ernie-speed-8k', 'ernie-speed-128k', 'ernie-lite-8k',
            'ernie-tiny-8k', 'ernie-char-8k', 'ernie-functions-8k',
          ],
          defaultBaseUrl: 'https://aip.baidubce.com',
          type: 'api',
        },
        {
          id: 'xunfei-spark',
          name: '讯飞星火（Spark）',
          models: [
            'spark-4.0-ultra', 'spark-3.5-max', 'spark-3.5-pro', 'spark-3.5-lite',
            'spark-3.1-max', 'spark-2.0-lite',
            'spark-4.0-vision', 'spark-4.0-general',
          ],
          defaultBaseUrl: 'https://spark-api.xf-yun.com/v3.5',
          type: 'api',
        },
        {
          id: 'moonshot',
          name: '月之暗面（Kimi）',
          models: [
            'kimi-k2.6', 'kimi-k2.5', 'kimi-k2', 'kimi-k2-thinking',
            'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto',
            'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview',
          ],
          defaultBaseUrl: 'https://api.moonshot.cn/v1',
          type: 'api',
        },
        {
          id: 'volcengine-doubao',
          name: '字节跳动豆包（火山引擎）',
          models: [
            'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428', 'doubao-seed-2-0-pro-260215',
            'doubao-seed-2-0-code-preview-260215', 'doubao-seed-2-0-lite-260215', 'doubao-seed-2-0-mini-260215',
            'doubao-seed-1-8-251228', 'doubao-seed-1-6-flash-250828',
            'doubao-seed-1-6-vision-250815', 'doubao-1-5-pro-32k-250115',
          ],
          defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          type: 'api',
        },
        {
          id: 'lingyiwanwu',
          name: '零一万物（Yi）',
          models: [
            'yi-lightning', 'yi-large', 'yi-medium', 'yi-medium-200k',
            'yi-spark', 'yi-vision-plus',
          ],
          defaultBaseUrl: 'https://api.lingyiwanwu.com/v1',
          type: 'api',
        },
        {
          id: 'minimax',
          name: 'MiniMax',
          models: [
            'minimax-text-01', 'abab-6.5s', 'abab-6.5', 'abab-6.5g',
            'abab-5.5', 'abab-5.5s',
          ],
          defaultBaseUrl: 'https://api.minimaxi.com/v1',
          type: 'api',
        },
        {
          id: 'tencent-hunyuan',
          name: '腾讯混元',
          models: [
            'hunyuan-turbo-latest', 'hunyuan-pro', 'hunyuan-standard',
            'hunyuan-lite', 'hunyuan-vision', 'hunyuan-code',
          ],
          defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
          type: 'api',
        },
        {
          id: 'sensetime-sensenova',
          name: '商汤日日新（SenseNova）',
          models: [
            'SenseChat-5-32K', 'SenseChat-5-131K', 'SenseChat-4-32K',
            'SenseChat-4-131K', 'SenseChat-4-Turbo', 'SenseChat-Vision',
          ],
          defaultBaseUrl: 'https://api.sensenova.com/v1',
          type: 'api',
        },
        // ═══ 国际大模型 ═══
        {
          id: 'openai',
          name: 'OpenAI',
          models: [
            'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
            'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
            'gpt-4o', 'gpt-4o-mini', 'gpt-4o-audio-preview',
            'o3-mini', 'o1', 'o1-mini',
            'gpt-image-2',
          ],
          defaultBaseUrl: 'https://api.openai.com/v1',
          type: 'api',
        },
        {
          id: 'deepseek',
          name: 'DeepSeek',
          models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
          defaultBaseUrl: 'https://api.deepseek.com',
          type: 'api',
        },
        {
          id: 'anthropic',
          name: 'Anthropic（Claude）',
          models: [
            'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
            'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001',
          ],
          defaultBaseUrl: 'https://api.anthropic.com',
          type: 'api',
        },
        {
          id: 'google-gemini',
          name: 'Google Gemini',
          models: [
            'gemini-2.5-flash-preview-05-06', 'gemini-2.5-flash-04-17', 'gemini-2.5-pro-03-25',
            'gemini-2.0-flash', 'gemini-2.0-flash-lite',
            'gemini-1.5-pro', 'gemini-1.5-flash',
            'gemma-3-27b-it',
          ],
          defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          type: 'api',
        },
        {
          id: 'xai-grok',
          name: 'xAI（Grok）',
          models: ['grok-4.3', 'grok-4.3-latest', 'grok-4-vision', 'grok-build-0.1'],
          defaultBaseUrl: 'https://api.x.ai/v1',
          type: 'api',
        },
        {
          id: 'mistral-ai',
          name: 'Mistral AI',
          models: [
            'mistral-large-2411', 'mistral-small-2503', 'mistral-medium-latest',
            'open-mistral-nemo', 'codestral-latest',
          ],
          defaultBaseUrl: 'https://api.mistral.ai/v1',
          type: 'api',
        },
        {
          id: 'cohere',
          name: 'Cohere',
          models: ['command-r-plus', 'command-r', 'command-a-03-2025', 'command-nightly'],
          defaultBaseUrl: 'https://api.cohere.com/v2',
          type: 'api',
        },
        {
          id: 'perplexity-ai',
          name: 'Perplexity AI',
          models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning', 'sonar-deep-research'],
          defaultBaseUrl: 'https://api.perplexity.ai',
          type: 'api',
        },
        {
          id: 'ai21-labs',
          name: 'AI21 Labs（Jamba）',
          models: ['jamba-1.6-mini', 'jamba-1.6-large', 'jamba-1.5-mini', 'jamba-1.5-large'],
          defaultBaseUrl: 'https://api.ai21.com/studio/v1',
          type: 'api',
        },
        // ═══ 聚合平台 & 推理加速 ═══
        {
          id: 'openrouter',
          name: 'OpenRouter（聚合）',
          models: [
            'openai/gpt-4o', 'openai/gpt-4o-mini',
            'anthropic/claude-sonnet-4', 'anthropic/claude-3.5-sonnet',
            'google/gemini-2.5-flash', 'google/gemini-2.0-flash',
            'deepseek/deepseek-chat', 'deepseek/deepseek-r1',
            'meta-llama/llama-4-maverick', 'meta-llama/llama-4-scout',
            'qwen/qwen-max', 'mistralai/mistral-large-2411',
          ],
          defaultBaseUrl: 'https://openrouter.ai/api/v1',
          type: 'api',
        },
        {
          id: 'siliconflow',
          name: 'SiliconFlow（硅基流动）',
          models: [
            'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1',
            'Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-32B-Instruct',
            'Qwen/Qwen2.5-Coder-32B-Instruct',
            'THUDM/glm-4-9b-chat',
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
            'Pro/Llama-4-Maverick-17B-128E-Instruct',
          ],
          defaultBaseUrl: 'https://api.siliconflow.cn/v1',
          type: 'api',
        },
        {
          id: 'groq',
          name: 'Groq（高速推理）',
          models: [
            'llama-4-scout-17b-16e-instruct', 'llama-4-maverick-17b-128e-instruct',
            'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
            'deepseek-r1-distill-llama-70b',
            'mixtral-8x7b-32768', 'gemma2-9b-it',
          ],
          defaultBaseUrl: 'https://api.groq.com/openai/v1',
          type: 'api',
        },
        {
          id: 'together-ai',
          name: 'Together AI',
          models: [
            'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            'mistralai/Mixtral-8x22B-Instruct-v0.1',
            'Qwen/Qwen2.5-72B-Instruct-Turbo',
            'deepseek-ai/DeepSeek-V3',
          ],
          defaultBaseUrl: 'https://api.together.xyz/v1',
          type: 'api',
        },
        {
          id: 'deepinfra',
          name: 'DeepInfra',
          models: [
            'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            'mistralai/Mixtral-8x22B-Instruct-v0.1',
            'Qwen/Qwen2.5-72B-Instruct',
            'deepseek-ai/DeepSeek-V3',
          ],
          defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
          type: 'api',
        },
        {
          id: 'deepbricks',
          name: 'DeepBricks',
          models: ['deepseek-v3', 'deepseek-r1', 'gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'qwen-max'],
          defaultBaseUrl: 'https://api.deepbricks.ai/v1',
          type: 'api',
        },
        // ═══ 通用 ═══
        {
          id: 'custom',
          name: '自定义 OpenAI 兼容',
          models: ['自定义模型名'],
          defaultBaseUrl: 'https://your-api-endpoint.com/v1',
          type: 'api',
        },
        {
          id: 'cli',
          name: '命令行（CLI）',
          models: ['hermes', 'openclaw', '其他 CLI 程序'],
          defaultBaseUrl: '',
          type: 'cli',
        },
      ],
    };
  }

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  _parseBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({}); }
      });
    });
  }
}

module.exports = ModulWebServer;

// 独立启动
if (require.main === module) {
  const app = new ModulAgent();
  const configPath = process.argv[2] || './config/default.json';
  try {
    app.loadConfig(configPath);
  } catch (err) {
    console.error(`❌ 加载配置失败: ${err.message}`);
    process.exit(1);
  }
  const server = new ModulWebServer(app);
  server.start();
}
