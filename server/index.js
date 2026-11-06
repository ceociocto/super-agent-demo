import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, AppError } from './engine.js';
import { createProviderFromEnv } from './provider.js';
import { ColimaExecutor } from './executor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const allowedHosts = new Set(['127.0.0.1', 'localhost']);

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('请使用 application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new AppError('请求过大', 413); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
  catch { throw new AppError('请求必须是有效 JSON 对象'); }
}

export function createHandler(engine) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    try {
      const host = req.headers.host || '';
      const url = new URL(req.url, `http://${host}`);
      if (!allowedHosts.has(url.hostname)) throw new AppError('仅允许回环主机', 403);
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new AppError('不支持此请求方法', 405);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) throw new AppError('拒绝跨站写入', 403);
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError('拒绝跨站写入', 403);
        // Requests without browser headers are allowed for local CLI demonstrations only.
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, mode: engine.mode });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, engine.state());
      if ((req.method === 'GET' && url.pathname === '/api/executor') || (req.method === 'POST' && url.pathname === '/api/executor/check')) {
        return send(res, 200, engine.executor ? await engine.executor.status() : { available: false, error: '未配置 Colima 执行器', context: 'colima-superagent-demo', image: 'superagent-worker:local', os: null });
      }
      if (req.method === 'GET' && url.pathname === '/api/knowledge') return send(res, 200, engine.knowledge());
      if (req.method === 'POST' && url.pathname === '/api/knowledge') return send(res, 201, engine.putKnowledge(await body(req)));
      const knowledgeMatch = url.pathname.match(/^\/api\/knowledge\/([a-zA-Z0-9_-]+)\/delete$/);
      if (req.method === 'POST' && knowledgeMatch) { await body(req); return send(res, 200, engine.deleteKnowledge(knowledgeMatch[1])); }
      if (req.method === 'POST' && url.pathname === '/api/events') return send(res, 200, engine.ingest(await body(req)));
      const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(message|action))?$/);
      if (match) {
        if (req.method === 'GET' && !match[2]) return send(res, 200, engine.task(match[1]));
        if (req.method === 'POST' && match[2] === 'message') return send(res, 200, engine.followup(match[1], await body(req)));
        if (req.method === 'POST' && match[2] === 'action') return send(res, 200, engine.action(match[1], await body(req)));
      }
      if (url.pathname.startsWith('/api/')) throw new AppError('接口不存在', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('接口不存在', 404);
      const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!path.startsWith(publicRoot + sep)) throw new AppError('路径不允许', 403);
      try {
        const content = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new AppError('文件不存在', 404); throw error; }
    } catch (error) { send(res, error.status || 500, { error: error.status ? error.message : '服务内部错误' }); }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
  const provider = createProviderFromEnv();
  const executor = new ColimaExecutor();
  const engine = new Engine({ dbPath: process.env.DEMO_DB_PATH || resolve(root, 'data', 'demo.sqlite'), provider, executor });
  const server = createServer(createHandler(engine));
  server.listen(port, '127.0.0.1', async () => { await engine.recoverExecutions(); engine.start(); console.log(`Superagent ${engine.mode} / Colima: http://127.0.0.1:${port}`); });
  const stop = () => { server.close(() => { engine.close(); process.exit(0); }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
