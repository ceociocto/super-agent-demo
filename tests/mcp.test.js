import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { serviceUrl } from '../scripts/client.mjs';
import { handleMessage } from '../scripts/mcp.mjs';

async function fixture(t) {
  const tasks = [], conversations = [], received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    received.push({ path: req.url, body });
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/api/state') return send(200, { tasks, model: { model: 'test-provider' }, metrics: { totalTasks: tasks.length } });
    if (req.url === '/api/conversations') { const conversation = { id: `c${conversations.length + 1}` }; conversations.push(conversation); return send(201, conversation); }
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(req.url)) {
      const conversationId = req.url.split('/')[3];
      const task = { id: `t${tasks.length + 1}`, conversationId, title: body.text, status: 'running', messages: [] }; tasks.push(task);
      return send(200, { conversationId, message: { text: body.text }, taskId: task.id });
    }
    const match = req.url.match(/^\/api\/tasks\/([^/]+)(?:\/(messages|actions))?$/);
    if (match) {
      const task = tasks.find(task => task.id === match[1]);
      if (!task) return send(404, { error: '任务不存在' });
      if (match[2] === 'messages') task.messages.push(body.text);
      if (match[2] === 'actions') task.status = 'stopped';
      return send(200, task);
    }
    send(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, tasks, received, conversations };
}
function run(script, args, base, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ASSISTANT_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const data = response => JSON.parse(response.result.content[0].text);

test('MCP stdio initialize, notifications, list and calls share one real HTTP task', async t => {
  const f = await fixture(t);
  const requests = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'submit_request', { text: '读取本地项目并说明运行方式' }),
    call(3, 'list_tasks'), call(4, 'followup_task', { taskId: 't1', text: '补充测试命令' }),
    call(5, 'get_task', { taskId: 't1' }), call(6, 'stop_task', { taskId: 't1' }),
  ];
  const result = await run('scripts/mcp.mjs', [], f.base, requests.map(item => JSON.stringify(item)).join('\n') + '\n');
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 7, 'notifications have no response');
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.tools.length, 5);
  assert.equal(data(responses[2]).conversationId, 'c1');
  assert.equal(data(responses[3]).tasks[0].id, 't1');
  assert.deepEqual(data(responses[5]).messages, ['补充测试命令']);
  assert.equal(data(responses[6]).status, 'stopped');
  assert.equal(f.tasks.length, 1); assert.equal(f.conversations.length, 1);
  assert.match(f.received.find(item => item.path.endsWith('/messages')).body.requestId, /^[a-f0-9-]+$/);
});

test('MCP protocol errors differ from actual service/tool failures', async t => {
  const f = await fixture(t);
  const missing = await handleMessage(call(1, 'get_task', { taskId: 'missing' }), f.base);
  assert.equal(missing.result.isError, true); assert.match(missing.result.content[0].text, /任务不存在/);
  const invalid = await handleMessage(call(2, 'followup_task', { taskId: 't1' }), f.base);
  assert.equal(invalid.error.code, -32602);
  const extra = await handleMessage(call(3, 'list_tasks', { shell: 'wrong' }), f.base);
  assert.equal(extra.error.code, -32602);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'unknown' }, f.base)).error.code, -32601);
  const result = await run('scripts/mcp.mjs', [], f.base, '{bad}\n' + JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].error.code, -32700); assert.deepEqual(responses[1].result, {});
});

test('CLI follows and queries the exact task created through MCP', async t => {
  const f = await fixture(t);
  await handleMessage(call(1, 'submit_request', { text: '写说明', conversationId: 'existing-chat' }), f.base);
  let result = await run('scripts/client.mjs', ['followup', 't1', '保留中文'], f.base);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).id, 't1');
  result = await run('scripts/client.mjs', ['task', 't1'], f.base);
  assert.deepEqual(JSON.parse(result.stdout).messages, ['保留中文']);
  result = await run('scripts/client.mjs', ['ask', '第二项工作', '--conversation', 'existing-chat'], f.base);
  assert.equal(JSON.parse(result.stdout).conversationId, 'existing-chat');
  assert.equal(f.tasks.length, 2); assert.equal(f.conversations.length, 0);
  result = await run('scripts/client.mjs', ['stop', 't1'], f.base);
  assert.equal(JSON.parse(result.stdout).status, 'stopped');
});

test('terminal adapters only connect to local HTTP service origins', () => {
  assert.equal(serviceUrl('http://localhost:4317'), 'http://localhost:4317');
  for (const value of ['https://example.com', 'http://192.168.1.1:4317', 'http://user:pass@localhost', 'http://localhost/other', 'http://localhost?token=secret']) assert.throws(() => serviceUrl(value), /本机 HTTP/);
});
