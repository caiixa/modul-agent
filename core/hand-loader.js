// ============================================================
// Hand Loader — 能力插件加载器
// ============================================================
// 扫描 hands/ 目录，动态加载所有 Hand 插件
// 每个 Hand 是一个独立模块，导出 name / tools / execute
// ============================================================

const fs = require('fs');
const path = require('path');

class HandLoader {
  constructor(handsDir) {
    this.handsDir = path.resolve(handsDir || path.join(__dirname, '..', 'hands'));
    this.hands = new Map(); // handName -> HandModule
  }

  // 加载所有 Hand
  loadAll() {
    const entries = fs.readdirSync(this.handsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const handPath = path.join(this.handsDir, entry.name, 'index.js');
        if (fs.existsSync(handPath)) {
          this._loadHand(entry.name, handPath);
        }
      }
    }
    console.log(`[HandLoader] ✅ 已加载 ${this.hands.size} 个 Hand`);
    return this;
  }

  // 加载单个 Hand
  _loadHand(name, filePath) {
    try {
      const hand = require(filePath);
      if (!hand.name || !hand.tools) {
        console.warn(`[HandLoader] ⚠️ Hand "${name}" 缺少 name 或 tools 定义，跳过`);
        return;
      }
      this.hands.set(hand.name, hand);
      console.log(`[HandLoader]   ├─ ${hand.name}: ${Object.keys(hand.tools).length} 个工具`);
      // 如果 Hand 有 init 方法，异步初始化
      if (typeof hand.init === 'function') {
        hand.init().catch(err => {
          console.error(`[HandLoader] ⚠️ ${hand.name} init 失败: ${err.message}`);
        });
      }
    } catch (err) {
      console.error(`[HandLoader] ❌ 加载 Hand "${name}" 失败:`, err.message);
    }
  }

  // 获取某个 Hand
  get(name) {
    if (!this.hands.has(name)) {
      throw new Error(`Hand "${name}" 未加载`);
    }
    return this.hands.get(name);
  }

  // 获取多个 Hand 的工具定义（用于生成模型的 system prompt）
  getToolsForHands(handNames) {
    const tools = {};
    for (const name of handNames) {
      if (this.hands.has(name)) {
        Object.assign(tools, this.hands.get(name).tools);
      }
    }
    return tools;
  }

  // 生成给模型的工具描述文本
  generateToolsPrompt(handNames) {
    const tools = this.getToolsForHands(handNames);
    const lines = ['## 可用工具'];
    for (const [name, tool] of Object.entries(tools)) {
      const params = tool.parameters 
        ? Object.entries(tool.parameters)
            .map(([k, v]) => `  - ${k}: ${v.description || v.type || 'any'}`)
            .join('\n')
        : '  无参数';
      lines.push(`\n### ${name}`);
      lines.push(`${tool.description || '无描述'}`);
      lines.push(`参数：`);
      lines.push(params);
    }
    return lines.join('\n');
  }

  // 执行一个工具调用
  async executeTool(handName, toolName, params) {
    const hand = this.hands.get(handName);
    if (!hand) {
      return { error: `Hand "${handName}" 未加载` };
    }
    const tool = hand.tools[toolName];
    if (!tool) {
      return { error: `工具 "${toolName}" 在 Hand "${handName}" 中不存在` };
    }
    if (!tool.execute) {
      return { error: `工具 "${toolName}" 没有 execute 实现` };
    }

    try {
      const result = await tool.execute(params);
      return { result };
    } catch (err) {
      return { error: err.message };
    }
  }

  // 自动判断工具属于哪个 Hand
  findHandForTool(toolName) {
    for (const [handName, hand] of this.hands) {
      if (hand.tools[toolName]) {
        return handName;
      }
    }
    return null;
  }
}

module.exports = HandLoader;
