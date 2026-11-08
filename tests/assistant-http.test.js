import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../server/assistant.js';
import { createAssistantHandler } from '../server/http.js';

async function fixture(t, { configured = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-http-'));
  const publicRoot = join(root, 'public'); mkdirSync(publicRoot);
  writeFileSync(join(publicRoot, 'index.html'), '<!doctype html><title>Assistant</title>');
  writeFileSync(join(publicRoot, 'app.js'), 'export const example = true;');
  writeFileSync(join(root, 'outside.txt'), 'outside the public and task roots');
  symlinkSync(join(root, 'outside.txt'), join(publicRoot, 'outside-link.txt'));
  const assistant = new Assistant({ workspaceRoot: join(root, 'tasks'), model: { name: 'test-double', model: 'fixture', configured, complete() { throw new Error('This HTTP test must never call a model'); } } });
  // Deliberately do not start the scheduler: these are HTTP and persistence assertions.
  const server = createServer(createAssistantHandler(assistant, { publicRoot }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await assistant.close(); rmSync(root, { recursive: true, force: true }); });
  const req = ({ path = '/api/state', method = 'GET', payload, headers = {} } = {}) => new Promise((resolve, reject) => {
    const wire = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { ...(wire === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: response.statusCode, headers: response.headers, data, text });
      });
    });
    request.on('error', reject); request.end(wire);
  });
  return { assistant, req, root, port };
}

test('HTTP conversation intake and direct task APIs share durable state, idempotent follow-up and stop/resume', async t => {
  const { req } = await fixture(t);
  const conversation = await req({ path: '/api/conversations', method: 'POST', payload: { title: '两个工作' } });
  assert.equal(conversation.status, 201);
  const conversationId = conversation.data.id;
  const messagePath = `/api/conversations/${conversationId}/messages`;
  const submitted = await req({ path: messagePath, method: 'POST', payload: { text: '帮我整理项目说明', requestId: 'submit-once' } });
  assert.equal(submitted.status, 202); assert.equal(submitted.data.conversationId, conversationId);
  const repeated = await req({ path: messagePath, method: 'POST', payload: { text: '帮我整理项目说明', requestId: 'submit-once' } });
  assert.equal(repeated.data.message.id, submitted.data.message.id);
  const created = await req({ path: '/api/tasks', method: 'POST', payload: { conversationId, title: '整理说明', objective: '阅读项目并生成说明文件', requestId: 'create-once' } });
  assert.equal(created.status, 201);
  const taskId = created.data.id;
  const duplicate = await req({ path: '/api/tasks', method: 'POST', payload: { conversationId, objective: '阅读项目并生成说明文件', requestId: 'create-once' } });
  assert.equal(duplicate.data.id, taskId);
  const followed = await req({ path: `/api/tasks/${taskId}/messages`, method: 'POST', payload: { text: '补上测试步骤', requestId: 'follow-once' } });
  assert.equal(followed.status, 202); assert.equal(followed.data.revision, 2);
  const followedAgain = await req({ path: `/api/tasks/${taskId}/messages`, method: 'POST', payload: { text: '补上测试步骤', requestId: 'follow-once' } });
  assert.equal(followedAgain.data.revision, 2);
  const stopped = await req({ path: `/api/tasks/${taskId}/actions`, method: 'POST', payload: { action: 'stop' } });
  assert.equal(stopped.status, 200); assert.equal(stopped.data.status, 'stopped');
  const resumed = await req({ path: `/api/tasks/${taskId}/actions`, method: 'POST', payload: { action: 'resume' } });
  assert.equal(resumed.data.status, 'queued');
  const detail = await req({ path: `/api/tasks/${taskId}` });
  assert.equal(detail.data.messages.length, 2); assert.deepEqual(detail.data.runs, []); assert.deepEqual(detail.data.artifacts, []);
  const state = await req();
  assert.equal(state.data.tasks.length, 1); assert.equal(state.data.tasks[0].conversationId, conversationId);
  assert.equal(state.data.conversations[0].messages.length, 1);
  assert.equal(state.data.version, '0.4.0'); assert.equal(state.data.metrics.modelCalls, 0);
  assert.equal('_history' in state.data.conversations[0], false);
});

test('HTTP input validation and same-origin controls reject invalid mutation requests', async t => {
  const { req, port } = await fixture(t);
  const post = extra => req({ path: '/api/conversations', method: 'POST', payload: {}, ...extra });
  assert.equal((await post({ headers: { origin: 'https://external.invalid' } })).status, 403);
  assert.equal((await post({ headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await req({ headers: { host: 'external.invalid' } })).status, 403);
  assert.equal((await post({ headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post({ payload: '{broken' })).status, 400);
  assert.equal((await post({ payload: [] })).status, 400);
  assert.equal((await post({ payload: 'x'.repeat(66000) })).status, 413);
  assert.equal((await req({ method: 'DELETE' })).status, 405);
  assert.equal((await post({ headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } })).status, 201);
  assert.equal((await req()).data.conversations.length, 1);
});

test('HTTP task downloads reject traversal and symlink escape while serving actual artifacts', async t => {
  const { req, assistant, root } = await fixture(t);
  const conversation = assistant.createConversation();
  const task = assistant.createTask({ conversationId: conversation.id, objective: '测试文件下载' });
  writeFileSync(join(task.workspace, '结果.md'), '# 实际文件\n中文结果');
  writeFileSync(join(task.workspace, '.env'), 'placeholder=not-a-secret');
  symlinkSync(join(root, 'outside.txt'), join(task.workspace, 'escape.txt'));
  symlinkSync(root, join(task.workspace, 'escape-dir'));
  const download = path => req({ path: `/api/tasks/${task.id}/file?path=${encodeURIComponent(path)}` });
  const good = await download('结果.md');
  assert.equal(good.status, 200); assert.match(good.text, /实际文件/);
  assert.match(good.headers['content-disposition'], /attachment;/); assert.equal(good.headers['x-content-type-options'], 'nosniff');
  assert.equal((await download('../../outside.txt')).status, 403);
  assert.equal((await download(join(root, 'outside.txt'))).status, 403);
  assert.equal((await download('escape.txt')).status, 403);
  assert.equal((await download('escape-dir/outside.txt')).status, 403);
  assert.equal((await download('.env')).status, 403);
  assert.equal((await download('missing.txt')).status, 404);
  const detail = await req({ path: `/api/tasks/${task.id}` });
  assert.ok(detail.data.artifacts.some(file => file.path === '结果.md'));
});

test('HTTP serves public files, HEAD and API errors without following public symlink escapes', async t => {
  const { req } = await fixture(t);
  const page = await req({ path: '/' });
  assert.equal(page.status, 200); assert.match(page.text, /<title>Assistant/); assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const script = await req({ path: '/app.js', method: 'HEAD' });
  assert.equal(script.status, 200); assert.equal(script.text, ''); assert.match(script.headers['content-type'], /javascript/);
  assert.equal((await req({ path: '/outside-link.txt' })).status, 403);
  assert.equal((await req({ path: '/%2e%2e%2foutside.txt' })).status, 403);
  assert.equal((await req({ path: '/absent.txt' })).status, 404);
  assert.equal((await req({ path: '/api/unknown' })).status, 404);
  assert.equal((await req({ path: '/api/tasks/unknown' })).status, 404);
});

test('HTTP missing model configuration returns a visible error, never creates a fake task', async t => {
  const { req } = await fixture(t, { configured: false });
  const conversation = await req({ path: '/api/conversations', method: 'POST', payload: {} });
  const result = await req({ path: `/api/conversations/${conversation.data.id}/messages`, method: 'POST', payload: { text: '执行任务' } });
  assert.equal(result.status, 503); assert.match(result.data.error, /尚未配置/);
  const created = await req({ path: '/api/tasks', method: 'POST', payload: { conversationId: conversation.data.id, objective: '执行任务' } });
  assert.equal(created.status, 503); assert.equal((await req()).data.tasks.length, 0);
});

test('HTTP Host validation is not bypassed by an absolute-form request URL', async t => {
  const { req, port } = await fixture(t);
  const response = await req({ path: `http://127.0.0.1:${port}/api/state`, headers: { host: 'external.invalid' } });
  assert.equal(response.status, 403);
});

test('HTTP download denies a harmless-looking symlink to a protected .env file', async t => {
  const { req, assistant } = await fixture(t);
  const conversation = assistant.createConversation();
  const task = assistant.createTask({ conversationId: conversation.id, objective: '检查下载边界' });
  writeFileSync(join(task.workspace, '.env'), 'placeholder=not-a-secret');
  symlinkSync(join(task.workspace, '.env'), join(task.workspace, 'settings.txt'));
  const response = await req({ path: `/api/tasks/${task.id}/file?path=settings.txt` });
  assert.equal(response.status, 403);
});
