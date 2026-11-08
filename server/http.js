import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AssistantError } from './assistant.js';

const exec = promisify(execFile);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AssistantError('请发送 JSON 请求', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 65536) throw new AssistantError('请求超过 64 KiB', 413); chunks.push(Buffer.from(chunk)); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new AssistantError('请求 JSON 无效'); }
}
async function confined(root, path) {
  const base = await realpath(root), file = await realpath(resolve(root, path));
  if (!file.startsWith(base + sep)) throw new AssistantError('文件路径不允许', 403);
  return file;
}

export function createAssistantHandler(assistant, { publicRoot = resolve('public') } = {}) {
  let environmentCache;
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    try {
      const host = req.headers.host || ''; const hostUrl = new URL(`http://${host}`);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname) || hostUrl.username || hostUrl.password) throw new AssistantError('仅接受本机请求', 403);
      const url = new URL(req.url, hostUrl);
      if (url.origin !== hostUrl.origin) throw new AssistantError('请求地址与本机服务不一致', 403);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new AssistantError('仅接受本机请求', 403);
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new AssistantError('不支持此方法', 405);
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AssistantError('拒绝跨站请求', 403);
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AssistantError('拒绝跨站请求', 403);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: '0.4.0', configured: Boolean(assistant.model?.configured) });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, assistant.state());
      if (req.method === 'GET' && url.pathname === '/api/environment') {
        if (!environmentCache || Date.now() - environmentCache.at > 30000) {
          let github;
          try { const result = await exec('gh', ['api', 'user', '--jq', '.login'], { timeout: 8000, maxBuffer: 4096 }); github = { available: true, login: result.stdout.trim() }; }
          catch { github = { available: false, error: 'gh 未安装、未登录或当前无法连接 GitHub' }; }
          environmentCache = { at: Date.now(), github };
        }
        return send(res, 200, { model: assistant.state().model, github: environmentCache.github, runtime: { node: process.version, platform: process.platform } });
      }
      if (req.method === 'POST' && url.pathname === '/api/conversations') return send(res, 201, assistant.createConversation(await body(req)));
      const conversation = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
      if (req.method === 'POST' && conversation) return send(res, 202, assistant.sendMessage(conversation[1], await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const input = await body(req); return send(res, 201, assistant.createTask(input, input.requestId ? `${input.conversationId}:${input.requestId}` : null));
      }
      const task = url.pathname.match(/^\/api\/tasks\/([\w-]+)(?:\/(messages|actions|file))?$/);
      if (task) {
        if (req.method === 'GET' && !task[2]) return send(res, 200, assistant.task(task[1]));
        if (req.method === 'POST' && task[2] === 'messages') return send(res, 202, assistant.followup(task[1], await body(req)));
        if (req.method === 'POST' && task[2] === 'actions') return send(res, 200, assistant.action(task[1], await body(req)));
        if (req.method === 'GET' && task[2] === 'file') {
          const workspace = assistant.get('task', task[1]).workspace;
          const requested = url.searchParams.get('path') || '';
          if (!requested || requested.split(/[\\/]/).some(p => p === '.git' || p.startsWith('.env'))) throw new AssistantError('文件路径不允许', 403);
          const file = await confined(workspace, requested), info = await stat(file);
          if (relative(await realpath(workspace), file).split(sep).some(p => p === '.git' || p.startsWith('.env'))) throw new AssistantError('文件路径不允许', 403);
          if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new AssistantError('文件不是普通文件或超过下载上限', 413);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(relative(workspace, file).split(sep).at(-1))}`, 'Cache-Control': 'no-store' });
          return res.end(await readFile(file));
        }
      }
      if (url.pathname.startsWith('/api/')) throw new AssistantError('接口不存在', 404);
      if (req.method === 'POST') throw new AssistantError('接口不存在', 404);
      const file = await confined(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const data = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500);
      send(res, status, { error: error.status ? error.message : status === 404 ? '文件不存在' : '服务内部错误，请查看服务日志' });
    }
  };
}
