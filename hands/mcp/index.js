// ============================================================
// MCP Hand — MCP 协议工具插件
// ============================================================
// 连接 MCP 标准协议服务器，把社区 MCP 插件暴露为 Hand 工具
// 支持 stdio 传输方式（通过命令启动子进程）
// ============================================================

const path = require('path');
const fs = require('fs');
const { McpClient } = require('../../core/mcp-client');

// MCP 服务器配置可以从文件加载
const MCP_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'mcp-servers.json');

let mcpClients = []; // McpClient 实例
let mcpTools = [];   // 合并后的工具列表
let initialized = false;

async function initMcpHand() {
  if (initialized) return;
  initialized = true;

  // 从配置文件加载 MCP 服务器列表
  let servers = [];
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
      servers = JSON.parse(raw);
    }
  } catch (e) {
    console.error(`[MCP-Hand] ⚠️ 加载配置文件失败: ${e.message}`);
  }

  if (!Array.isArray(servers) || servers.length === 0) {
    console.log('[MCP-Hand] ℹ️ 未配置 MCP 服务器，跳过（可在 config/mcp-servers.json 中配置）');
    return;
  }

  console.log(`[MCP-Hand] 🔌 正在连接 ${servers.length} 个 MCP 服务器...`);

  for (const cfg of servers) {
    try {
      const client = new McpClient(cfg.name, cfg);
      const result = await client.connect();
      console.log(`[MCP-Hand] ✅ ${cfg.name} 已连接`);

      // 拉取工具列表
      const tools = await client.listTools();
      console.log(`[MCP-Hand]   ├─ ${tools.length} 个工具可用`);

      for (const tool of tools) {
        mcpTools.push({
          name: `mcp_${cfg.name}_${tool.name}`,
          description: `[MCP:${cfg.name}] ${tool.description || tool.name}`,
          parameters: _convertJsonSchema(tool.inputSchema || {}),
          _mcpClientName: cfg.name,
          _mcpToolName: tool.name,
        });
      }

      mcpClients.push(client);
    } catch (e) {
      console.error(`[MCP-Hand] ❌ ${cfg.name} 连接失败: ${e.message}`);
    }
  }

  console.log(`[MCP-Hand] 📦 共注册 ${mcpTools.length} 个 MCP 工具`);
}

function _convertJsonSchema(schema) {
  const params = {};
  if (!schema || !schema.properties) return params;
  for (const [key, prop] of Object.entries(schema.properties)) {
    params[key] = {
      type: prop.type || 'string',
      description: prop.description || '',
    };
    // 如果不在 required 里，给个默认值让其可选
    const required = schema.required || [];
    if (!required.includes(key)) {
      params[key].default = null;
    }
  }
  return params;
}

async function executeMcpTool(toolName, args) {
  // 从工具名解析出 MCP 客户端和原始工具名
  const toolInfo = mcpTools.find(t => t.name === toolName);
  if (!toolInfo) {
    throw new Error(`未知的 MCP 工具: ${toolName}`);
  }

  const client = mcpClients.find(c => c.name === toolInfo._mcpClientName);
  if (!client || !client.connected) {
    throw new Error(`MCP 客户端 "${toolInfo._mcpClientName}" 未连接`);
  }

  const result = await client.callTool(toolInfo._mcpToolName, args);
  if (result.isError) {
    return { error: result.content?.[0]?.text || 'MCP 工具执行失败' };
  }
  // 组合 MCP content 为文本
  const text = (result.content || [])
    .map(c => c.text || JSON.stringify(c))
    .join('\n');
  return { text };
}

// 构建 MCP tools 对象
function buildMcpToolsObject() {
  const tools = {};
  for (const t of mcpTools) {
    tools[t.name] = {
      description: t.description,
      parameters: t.parameters,
      execute: async (params, context) => {
        return executeMcpTool(t.name, params);
      },
    };
  }
  return tools;
}

// Hand 导出
const mcpHand = {
  name: 'mcp',
  description: 'MCP 协议工具 — 连接社区 MCP 服务器',
  tools: {},
  async init() {
    await initMcpHand();
    this.tools = buildMcpToolsObject();
  },
};

module.exports = mcpHand;
