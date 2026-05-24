// ============================================================
// web-search Hand — 网页搜索工具插件
// ============================================================
// 通过 SearXNG（自部署元搜索引擎）搜索互联网。
// 提供搜索和网页抓取两种能力。
// 2 个工具：web_search / web_extract
// ============================================================

const http = require('http');
const https = require('https');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:4000';

const webSearchHand = {
  name: 'web-search',
  description: '网页搜索 — 搜索互联网获取最新信息、新闻、资料等',

  tools: {
    web_search: {
      description: '搜索互联网，返回标题、URL、摘要列表。适合查资料、找新闻、了解最新动态。',
      parameters: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数（默认 5，最大 10）', default: 5 },
      },
      execute: async ({ query, limit }) => {
        if (!query || !query.trim()) {
          return { error: '搜索关键词不能为空' };
        }

        const maxResults = Math.min(limit || 5, 10);

        try {
          const data = await _searchSearXNG(query, maxResults);
          if (data.results && data.results.length > 0) {
            return {
              result: data.results.slice(0, maxResults).map(r => ({
                title: r.title || '(无标题)',
                url: r.url,
                snippet: r.content || r.snippet || '',
              })),
              metadata: {
                total: data.results.length,
                engine: 'SearXNG',
              },
            };
          }

          // SearXNG 返回空，返回友好提示
          return { result: [], metadata: { total: 0, engine: 'SearXNG', note: '未找到结果，可尝试不同的关键词' } };
        } catch (err) {
          // SearXNG 不可用，返回友好提示
          return {
            error: `搜索服务暂不可用: ${err.message}。请检查 SearXNG 是否在 ${SEARXNG_URL} 运行。`,
          };
        }
      },
    },

    web_extract: {
      description: '获取一个网页的文本内容（Markdown 格式）。适合阅读文章、文档、新闻详情。',
      parameters: {
        url: { type: 'string', description: '要获取的网页 URL' },
      },
      execute: async ({ url }) => {
        if (!url) return { error: 'URL 不能为空' };

        // 简单校验 URL 格式
        try {
          new URL(url);
        } catch {
          return { error: `无效的 URL: ${url}` };
        }

        try {
          const content = await _fetchPage(url);
          return {
            result: content,
            metadata: { url, length: content.length },
          };
        } catch (err) {
          return { error: `获取网页失败: ${err.message}` };
        }
      },
    },
  },
};

function _searchSearXNG(query, limit) {
  return new Promise((resolve, reject) => {
    const url = new URL('/search', SEARXNG_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'zh-CN,en');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('pageno', '1');

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url.toString(), { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`SearXNG 返回非 JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('搜索超时')); });
  });
}

function _fetchPage(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      let data = '';
      // 限制大小
      let size = 0;
      const MAX_SIZE = 500 * 1024;

      res.on('data', chunk => {
        size += chunk.length;
        if (size < MAX_SIZE) data += chunk;
      });
      res.on('end', () => {
        if (size >= MAX_SIZE) {
          resolve(data + '\n\n[内容过大，已被截断]');
        } else {
          // 简单的 HTML 标签剥离，保留纯文本
          resolve(_stripHtml(data).slice(0, 10000));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

function _stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = webSearchHand;
