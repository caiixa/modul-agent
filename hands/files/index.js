// ============================================================
// files Hand — 文件操作能力插件
// ============================================================
// 提供共享文件库的读写能力
// ============================================================

const fs = require('fs');
const path = require('path');

const filesHand = {
  name: 'files',
  description: '文件读写操作 — 读取、写入、列出、搜索共享文件库中的文件',

  tools: {
    read_file: {
      description: '读取文件内容。path 可以是绝对路径或相对于共享目录的路径。',
      parameters: {
        path: { type: 'string', description: '文件路径' },
      },
      execute: async ({ path: filePath, sharedDir }) => {
        const absPath = _resolvePath(filePath, sharedDir);
        if (!fs.existsSync(absPath)) {
          return { error: `文件不存在: ${absPath}` };
        }
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          return { error: `路径是目录，不是文件: ${absPath}` };
        }
        // 限制文件大小（10MB）
        if (stat.size > 10 * 1024 * 1024) {
          return { error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 10MB` };
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        return {
          result: content,
          metadata: {
            path: absPath,
            size: stat.size,
            lines: content.split('\n').length,
            modified: stat.mtime,
          },
        };
      },
    },

    write_file: {
      description: '写入文件。如果文件已存在会覆盖。自动创建父目录。',
      parameters: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      execute: async ({ path: filePath, content, sharedDir }) => {
        const absPath = _resolvePath(filePath, sharedDir);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(absPath, content, 'utf-8');
        const stat = fs.statSync(absPath);
        return {
          result: `写入成功: ${absPath} (${stat.size} 字节)`,
          metadata: { path: absPath, size: stat.size },
        };
      },
    },

    append_file: {
      description: '追加内容到文件末尾。适合协作时多人写同一个文件。',
      parameters: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要追加的内容' },
      },
      execute: async ({ path: filePath, content, sharedDir }) => {
        const absPath = _resolvePath(filePath, sharedDir);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(absPath, '\n' + content, 'utf-8');
        return { result: `追加成功: ${absPath}` };
      },
    },

    list_files: {
      description: '列出目录下的文件和文件夹（不递归）。',
      parameters: {
        path: { type: 'string', description: '目录路径，默认共享目录根', default: '.' },
      },
      execute: async ({ path: dirPath, sharedDir }) => {
        const absPath = _resolvePath(dirPath, sharedDir);
        if (!fs.existsSync(absPath)) {
          return { error: `目录不存在: ${absPath}` };
        }
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        const files = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? fs.statSync(path.join(absPath, e.name)).size : null,
        }));
        return { result: files };
      },
    },

    search_files: {
      description: '按文件名或内容搜索文件。支持 glob 模式。',
      parameters: {
        pattern: { type: 'string', description: '搜索关键词或 glob 模式' },
        path: { type: 'string', description: '搜索目录，默认共享目录根', default: '.' },
      },
      execute: async ({ pattern, path: dirPath, sharedDir }) => {
        const absPath = _resolvePath(dirPath, sharedDir);
        const results = [];
        
        function walk(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.')) walk(fullPath);
            } else if (entry.name.includes(pattern)) {
              const stat = fs.statSync(fullPath);
              results.push({
                path: fullPath.replace(absPath, '.'),
                size: stat.size,
                modified: stat.mtime,
              });
            }
          }
        }

        walk(absPath);
        return { result: results };
      },
    },

    delete_file: {
      description: '删除文件或空目录。',
      parameters: {
        path: { type: 'string', description: '要删除的文件路径' },
      },
      execute: async ({ path: filePath, sharedDir }) => {
        const absPath = _resolvePath(filePath, sharedDir);
        if (!fs.existsSync(absPath)) {
          return { error: `路径不存在: ${absPath}` };
        }
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          fs.rmdirSync(absPath);
        } else {
          fs.unlinkSync(absPath);
        }
        return { result: `已删除: ${absPath}` };
      },
    },
  },
};

// 解析路径：相对路径拼共享目录，绝对路径直接用（限制在共享目录内）
function _resolvePath(inputPath, sharedDir) {
  const base = sharedDir || process.cwd();
  if (path.isAbsolute(inputPath)) {
    // 限制在共享目录内，不能逃逸
    const resolved = path.resolve(inputPath);
    const baseResolved = path.resolve(base);
    if (!resolved.startsWith(baseResolved)) {
      throw new Error(`路径越权: ${inputPath} 不在共享目录 ${base} 内`);
    }
    return resolved;
  }
  return path.resolve(base, inputPath);
}

module.exports = filesHand;
