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

    // API: 获取 Agent 列表
    if (url === '/api/agents' && method === 'GET') {
      return this._json(res, 200, this.app.registry.list());
    }

    // API: 获取会话列表
    if (url === '/api/sessions' && method === 'GET') {
      return this._json(res, 200, this.app.sessions.list());
    }

    // API: 获取 Hand 列表
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
            const results = await this.app.sendMessage(sessionId, pkt.text);
            // 广播给所有在同一个会话的客户端
            this._broadcastToSession(sessionId, {
              type: 'agent_replies',
              results,
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
