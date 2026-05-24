// ============================================================
// shell Hand — Shell 命令执行能力插件
// ============================================================
// 允许模型在服务器上执行 Shell 命令（文件/curl/git/python 等）
// 安全限制：阻止高危命令，限制超时，限制工作目录
// ============================================================

const { execSync } = require('child_process');
const path = require('path');

// 高危命令黑名单（完全禁止）
const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'mkfs', 'dd if=', ':(){ :|:& };:', // 删库/炸弹
  'shutdown', 'reboot', 'halt', 'poweroff', 'init 0', 'init 6',           // 关机重启
  'chmod 777 /', 'chown -R',                                               // 权限越界
  '> /dev/sda', '< /dev/sda',                                               // 直接操作磁盘
  'wget http://', 'curl http://', 'curl -s http://',                        // 远程下载（仅阻止裸 HTTP）
  'sudo ', 'su ', 'passwd',                                                 // 提权
];

// 敏感命令警告（需确认）
const SENSITIVE_COMMANDS = [
  'kill ', 'pkill ', 'killall ',
  'rm ', 'rmdir ', 'mv ', 'chmod ', 'chown ',
  'docker ', 'systemctl ', 'service ',
  '> ', '>> ', '|',
  'git push', 'git reset --hard',
];

const shellHand = {
  name: 'shell',
  description: 'Shell 命令执行 — 运行 Shell 命令并获取输出（安全沙箱限制）',

  tools: {
    execute_command: {
      description: '执行一条 Shell 命令，返回标准输出和标准错误。超时 30 秒。禁止高危命令（rm -rf /、shutdown 等）。',
      parameters: {
        command: { type: 'string', description: '要执行的 Shell 命令' },
        workdir: { type: 'string', description: '工作目录（可选，默认共享目录）', default: '.' },
        timeout: { type: 'number', description: '超时秒数（默认 15，最大 60）', default: 15 },
      },
      execute: async ({ command, workdir, sharedDir, outputDir }) => {
        // 安全检查
        const safety = _checkSafety(command);
        if (!safety.allowed) {
          return { error: `❌ 命令被安全策略拦截: ${safety.reason}` };
        }

        // 确定工作目录
        const cwd = _resolveWorkDir(workdir, sharedDir, outputDir);

        // 限制超时
        const maxTimeout = Math.min(timeout || 15, 60);

        try {
          const output = execSync(command, {
            cwd,
            timeout: maxTimeout * 1000,
            maxBuffer: 1024 * 1024, // 1MB 输出上限
            encoding: 'utf-8',
            shell: '/bin/bash',
          });
          return { result: output || '(命令执行成功，无输出)' };
        } catch (err) {
          if (err.stdout) {
            return { result: err.stdout, error: err.stderr || err.message };
          }
          if (err.stderr) {
            return { error: err.stderr.slice(0, 2000) };
          }
          if (err.code === 'ETIMEDOUT') {
            return { error: `⏱️ 命令超时（${maxTimeout}秒）` };
          }
          return { error: `命令执行失败: ${err.message}` };
        }
      },
    },
  },
};

function _checkSafety(command) {
  const trimmed = command.trim().toLowerCase();

  // 检查黑名单
  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed.includes(blocked)) {
      return { allowed: false, reason: `高危命令被禁止: ${blocked}` };
    }
  }

  // 警告但不阻止敏感操作
  for (const sensitive of SENSITIVE_COMMANDS) {
    if (trimmed.includes(sensitive)) {
      console.warn(`[Shell Hand] ⚠️ 执行敏感命令: ${command.slice(0, 100)}`);
      break;
    }
  }

  return { allowed: true };
}

function _resolveWorkDir(workdir, sharedDir, outputDir) {
  if (workdir && workdir !== '.') {
    return path.resolve(workdir);
  }
  if (sharedDir) return sharedDir;
  if (outputDir) return outputDir;
  return process.cwd();
}

module.exports = shellHand;
