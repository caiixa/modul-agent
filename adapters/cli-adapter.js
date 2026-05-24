// ============================================================
// CLI Adapter — 适配 CLI 类型模型（Hermes / OpenClaw）
// ============================================================
// 调命令行进程执行
// ============================================================

const { spawn } = require('child_process');

class CliAdapter {
  async call(agentConfig, { message, toolsPrompt, history, sharedDir }) {
    if (!agentConfig.command) {
      return { text: '[配置错误: CLI 模型未指定 command]', toolCalls: [] };
    }

    // 构建完整输入
    const input = `${message || ''}\n\n可用工具:\n${toolsPrompt}\n\n共享目录: ${sharedDir || '.'}`;
    const escaped = input.replace(/'/g, "'\\''");

    // 组装命令
    const cmd = agentConfig.command.replace('{input}', `'${escaped}'`);
    
    try {
      const result = await this._execCommand(cmd, agentConfig);
      return { text: result, toolCalls: [] };
    } catch (err) {
      return { text: `[CLI 调用失败: ${err.message}]`, toolCalls: [] };
    }
  }

  _execCommand(cmd, agentConfig) {
    return new Promise((resolve, reject) => {
      const proc = spawn('/bin/bash', ['-c', cmd], {
        cwd: agentConfig.workingDir || process.env.HOME,
        timeout: 120_000,
        env: { ...process.env },
      });

      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else if (stdout.trim()) {
          resolve(stdout.trim());
        } else if (stderr.trim()) {
          resolve(stderr.trim());
        } else {
          resolve('[CLI 无输出]');
        }
      });

      proc.on('error', reject);
    });
  }
}

module.exports = CliAdapter;
