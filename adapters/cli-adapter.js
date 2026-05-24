// ============================================================
// Cli Adapter — CLI 代理适配器
// ============================================================
// 将用户输入转发给 CLI 代理（如 Hermes），并处理返回结果
// ============================================================

class CliAdapter {
  async call(agentConfig, { message, toolsPrompt, history, sharedDir, outputDir }) {
    if (!agentConfig.command) {
      return { text: '[配置错误: CLI 模型未指定 command]', toolCalls: [] };
    }

    // 构建完整输入
    const outputHint = outputDir || sharedDir || '.';
    const input = `${message || ''}\n\n可用工具:\n${toolsPrompt}\n\n共享目录: ${sharedDir || '.'}\n产出目录（请将最终产物写到这里）: ${outputHint}`;
    const escaped = input.replace(/'/g, "'\\''");

    // 组装命令
    const cmd = agentConfig.command.replace('{input}', `'${escaped}'`);

    const { execSync } = require('child_process');
    const opts = {
      timeout: (agentConfig.timeout || 300) * 1000,
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
      env: Object.assign({}, process.env, agentConfig.env || {}),
    };

    const start = Date.now();
    try {
      const stdout = execSync(cmd, opts).toString();
      const elapsed = Date.now() - start;
      const text = stdout.trim();
      console.log(`[CliAdapter] ✅ ${agentConfig.name} 回复 (${elapsed}ms) len=${text.length}`);
      return { text, toolCalls: [] };
    } catch (e) {
      const elapsed = Date.now() - start;
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      const output = stdout + '\n' + stderr;
      console.error(`[CliAdapter] ❌ ${agentConfig.name} 失败 (${elapsed}ms): ${e.message}`);
      return { text: output.trim() || `[执行失败] ${e.message}`, toolCalls: [] };
    }
  }
}

module.exports = { CliAdapter };
