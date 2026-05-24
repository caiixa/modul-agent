// ============================================================
// MCP Client — 连接 MCP 标准协议服务器
// ============================================================
// 支持 stdio 和 HTTP SSE 两种传输方式
// 把 MCP Server 的工具暴露为 Hand 工具
// ============================================================

const { spawn } = require('child_process');
const http = require('http');

class McpClient {
  constructor(name, config) {
    this.name = name;
    this.config = config; // { transport: 'stdio'|'sse', command, args, url }
    this.serverProcess = null;
    this.messageId = 0;
    this.pending = new Map(); // id -> { resolve, reject }
    this.buffer = '';
    this.connected = false;
  }

  // 连接到 MCP Server
  async connect() {
    if (this.config.transport === 'stdio') {
      return this._connectStdio();
    } else if (this.config.transport === 'sse') {
      return this._connectSSE();
    }
    throw new Error(`未知的 MCP 传输方式: ${this.config.transport}`);
  }

  _connectStdio() {
    return new Promise((resolve, reject) => {
      const cmd = this.config.command;
      const args = this.config.args || [];
      this.serverProcess = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, this.config.env || {}),
      });

      let initialized = false;

      this.serverProcess.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._processMessages();
      });

      this.serverProcess.stderr.on('data', (chunk) => {
        // MCP server 的日志可能走 stderr
      });

      this.serverProcess.on('error', (err) => {
        if (!initialized) reject(err);
      });

      this.serverProcess.on('close', (code) => {
        this.connected = false;
      });

      // 发送 initialize 请求
      this._sendRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'modul-agent-mcp', version: '1.0.0' },
      }).then((response) => {
        initialized = true;
        this.connected = true;
        resolve(response);
      }).catch(reject);
    });
  }

  _connectSSE() {
    // HTTP SSE 方式 — 简化版本
    return Promise.reject(new Error('SSE 传输暂未实现'));
  }

  _processMessages() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // 保留不完整行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result || msg);
        }
      } catch {
        // 非 JSON 行跳过
      }
    }
  }

  _sendRequest(method, params = {}) {
    const id = ++this.messageId;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.serverProcess && this.serverProcess.stdin.writable) {
        this.serverProcess.stdin.write(message);
      } else {
        this.pending.delete(id);
        reject(new Error('MCP 未连接'));
      }
      // 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30000);
    });
  }

  // 列出可用工具
  async listTools() {
    const result = await this._sendRequest('tools/list');
    return result.tools || [];
  }

  // 调用工具
  async callTool(name, args) {
    const result = await this._sendRequest('tools/call', { name, arguments: args });
    return result;
  }

  disconnect() {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
    this.connected = false;
  }
}

module.exports = { McpClient };
