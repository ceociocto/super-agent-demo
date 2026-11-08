// Scripted models below are explicit test doubles. These tests do not call a live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Assistant } from '../server/assistant.js';

const completion = content => ({ message: { role: 'assistant', content }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, model: 'scripted-test-only' });
const calls = (...items) => ({ message: { role: 'assistant', content: null, tool_calls: items.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, model: 'scripted-test-only' });
const report = (id = 'report', summary = '实际测试产物已完成') => calls([id, 'report_task', { status: 'completed', summary }]);
const isRouter = args => args.tools.some(t => t.function.name === 'create_task');
const emptyTools = () => ({ tools: [], jobs: new Map(), close: async () => {} });
function scripted(handler) {
  const requests = [];
  return { configured: true, name: 'test-double', model: 'scripted-test-only', requests, async complete(args) { requests.push(structuredClone({ messages: args.messages, tools: args.tools })); return handler(args, requests.length); } };
}
function deferred(signal) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  return { promise, resolve, reject };
}
async function until(condition, message = 'condition did not settle') {
  for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}
function fixture(model, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-test-'));
  const paths = { dbPath: join(dir, 'state.sqlite'), workspaceRoot: join(dir, 'workspaces') };
  const engine = new Assistant({ ...paths, model, toolFactory: emptyTools, ...options });
  return { dir, paths, engine, async cleanup() { if (!engine.closed) await engine.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Router dispatches multiple tasks in one chat; at most two Workers execute concurrently', async () => {
  let routerCalls = 0;
  const pending = [];
  const model = scripted(args => {
    if (isRouter(args)) return ++routerCalls === 1 ? calls(
      ['dispatch-a', 'create_task', { title: 'A', objective: '执行任务 A' }],
      ['dispatch-b', 'create_task', { title: 'B', objective: '执行任务 B' }],
      ['dispatch-c', 'create_task', { title: 'C', objective: '执行任务 C' }],
    ) : completion('已安排三个独立任务。');
    const job = deferred(args.signal); pending.push(job); return job.promise;
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation();
    e.sendMessage(chat.id, { text: '同时处理 A、B、C。', requestId: 'message-one' });
    e.tick();
    await until(() => e.state().tasks.length === 3 && !e.routers.size);
    assert.ok(e.state().tasks.every(task => task.conversationId === chat.id));
    e.tick(); await until(() => pending.length === 2);
    assert.equal(e.workers.size, 2);
    assert.equal(e.state().tasks.filter(task => task.status === 'queued').length, 1);
    pending[0].resolve(report('report-a'));
    await until(() => e.workers.size === 1);
    e.tick(); await until(() => pending.length === 3);
    assert.equal(e.workers.size, 2);
    pending[1].resolve(report('report-b')); pending[2].resolve(report('report-c'));
    await until(() => !e.workers.size);
    assert.ok(e.state().tasks.every(task => task.status === 'completed'));
    assert.equal(e.all('run').length, 3);
    assert.equal(e.state().conversations[0].messages.filter(m => m.taskId).length, 3);
    assert.ok(!e.state().tasks.some(task => task.status === 'awaiting_approval'));
  } finally { await f.cleanup(); }
});

test('followup during a live Worker turn enters the original context without restarting or duplicating Task', async () => {
  let first;
  const snapshots = [];
  const model = scripted(args => {
    snapshots.push(structuredClone(args.messages));
    if (snapshots.length === 1) { first = deferred(args.signal); return first.promise; }
    return report('new-report', '已处理新增边界条件');
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '处理文件' });
    e.tick(); await until(() => first);
    const controller = e.workers.get(task.id).controller;
    e.followup(task.id, { text: '再补充一个边界条件', requestId: 'followup-one' });
    e.followup(task.id, { text: '再补充一个边界条件', requestId: 'followup-one' });
    assert.equal(controller.signal.aborted, false);
    first.resolve(report('premature-report', '旧要求完成'));
    await until(() => !e.workers.size);
    const current = e.task(task.id);
    assert.equal(e.state().tasks.length, 1);
    assert.equal(current.revision, 2);
    assert.equal(current.runs.length, 1);
    assert.equal(current.status, 'completed');
    assert.equal(current.result, '已处理新增边界条件');
    assert.ok(snapshots[1].some(m => m.role === 'user' && m.content === '再补充一个边界条件'));
    assert.ok(snapshots[1].some(m => m.role === 'tool' && m.content.includes('尚未读取')));
  } finally { await f.cleanup(); }
});

test('Router forwards a later chat message into the existing completed Worker session', async () => {
  let taskId, routerTurns = 0, workerTurns = 0;
  const model = scripted(args => {
    if (isRouter(args)) {
      routerTurns++;
      return routerTurns === 1 ? calls(['forward-existing', 'send_to_task', { taskId, text: '展开已有结果' }]) : completion('已交给原任务继续。');
    }
    workerTurns++;
    if (workerTurns === 2) assert.ok(args.messages.some(m => m.role === 'tool' && m.tool_call_id === 'initial-report'));
    return report(workerTurns === 1 ? 'initial-report' : 'followup-report', workerTurns === 1 ? '初稿' : '展开后的结果');
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '整理资料' }); taskId = task.id;
    e.tick(); await until(() => !e.workers.size);
    assert.equal(e.task(taskId).status, 'completed');
    e.sendMessage(chat.id, { text: '刚才那个任务再展开一下。' });
    e.tick(); await until(() => !e.routers.size);
    e.tick(); await until(() => !e.workers.size);
    assert.equal(e.state().tasks.length, 1);
    assert.equal(e.task(taskId).runs.length, 2);
    assert.equal(e.task(taskId).result, '展开后的结果');
    assert.equal(workerTurns, 2);
  } finally { await f.cleanup(); }
});

test('a Worker cannot report completion while a background command is still running', async () => {
  let step = 0, inspected = false;
  const jobs = new Map([['job-one', { status: 'running' }]]);
  const model = scripted(args => {
    step++;
    if (step === 1) return report('early-report');
    if (step === 2) {
      assert.ok(args.messages.some(m => m.role === 'tool' && m.content.includes('后台命令运行')));
      return calls(['inspect', 'inspect_job', {}]);
    }
    return report('verified-report', '命令已退出并核对输出');
  });
  const f = fixture(model, { toolFactory: () => ({ jobs, close: async () => {}, tools: [{ name: 'inspect_job', description: 'test-only job inspection', parameters: { type: 'object', properties: {} }, execute: async () => { inspected = true; jobs.get('job-one').status = 'completed'; return { exitCode: 0, output: 'actual test fixture result' }; } }] }) }), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '等待命令结束并验证' });
    e.tick(); await until(() => !e.workers.size);
    assert.equal(inspected, true);
    assert.equal(e.task(task.id).status, 'completed');
    const reports = e.task(task.id).runs[0].events.filter(event => event.type === 'report');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].summary, '命令已退出并核对输出');
  } finally { await f.cleanup(); }
});

test('stop retains Task and Run, resume creates a new Run with prior context and reconciliation instruction', async () => {
  let pending, requests = 0;
  const model = scripted(args => {
    if (++requests === 1) { pending = deferred(args.signal); return pending.promise; }
    assert.ok(args.messages.some(m => m.content?.includes('不能重复已经成功的操作')));
    return report('resumed-report', '核查后完成剩余工作');
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '可恢复任务' });
    e.tick(); await until(() => pending);
    e.action(task.id, { action: 'stop' });
    await until(() => !e.workers.size);
    let current = e.task(task.id);
    assert.equal(current.status, 'stopped');
    assert.equal(current.runs[0].status, 'interrupted');
    e.action(task.id, { action: 'resume' }); e.tick(); await until(() => !e.workers.size);
    current = e.task(task.id);
    assert.equal(current.id, task.id);
    assert.equal(current.runs.length, 2);
    assert.notEqual(current.runs[0].id, current.runs[1].id);
    assert.equal(current.status, 'completed');
  } finally { await f.cleanup(); }
});

test('restart preserves state and closes interrupted tool protocol without replaying unknown effects', async () => {
  const model = scripted(args => {
    const missing = args.messages.find(m => m.role === 'tool' && m.tool_call_id === 'unknown-effect');
    assert.ok(missing?.content.includes('操作结果未知'));
    assert.ok(args.messages.some(m => m.role === 'user' && m.content.includes('先检查现有文件')));
    return report('recovered-report', '已检查原记录并恢复');
  });
  const f = fixture(model), first = f.engine;
  let second;
  try {
    const chat = first.createConversation(), created = first.createTask({ conversationId: chat.id, objective: '保持任务身份' });
    const task = first.get('task', created.id);
    task.status = 'running'; task._inbox = [];
    task._history = [{ role: 'user', content: '保持任务身份' }, calls(['unknown-effect', 'execute_command', { command: 'git push' }]).message];
    first.put('task', task);
    first.put('run', { id: 'old-run', taskId: task.id, status: 'running', events: [], usage: [], startedAt: new Date().toISOString() });
    await first.close();
    second = new Assistant({ ...f.paths, model, toolFactory: emptyTools });
    assert.equal(second.task(task.id).status, 'interrupted');
    assert.equal(second.task(task.id).runs[0].status, 'interrupted');
    assert.equal(second.task(task.id).workspace, created.workspace);
    second.tick(); await until(() => !second.workers.size);
    assert.equal(model.requests.length, 0);
    second.action(task.id, { action: 'resume' }); second.tick(); await until(() => !second.workers.size);
    assert.equal(second.task(task.id).status, 'completed');
    assert.equal(second.task(task.id).runs.length, 2);
    assert.equal(model.requests.length, 1);
  } finally { if (second && !second.closed) await second.close(); await f.cleanup(); }
});

test('Router tools cannot read, mutate, or cancel another conversation task', async () => {
  let targetId, phase = 0;
  const model = scripted(args => {
    assert.equal(isRouter(args), true);
    if (++phase === 1) return calls(
      ['cross-read', 'get_task', { taskId: targetId }],
      ['cross-write', 'send_to_task', { taskId: targetId, text: 'unauthorized followup' }],
      ['cross-stop', 'cancel_task', { taskId: targetId }],
      ['scoped-list', 'list_tasks', {}],
    );
    const toolResults = args.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    assert.equal(toolResults.slice(0, 3).every(r => r.error?.includes('不属于当前会话')), true);
    assert.deepEqual(toolResults[3], []);
    return completion('无法操作其他聊天任务。');
  });
  const f = fixture(model, { maxWorkers: 0 }), e = f.engine;
  try {
    const chatA = e.createConversation(), chatB = e.createConversation();
    targetId = e.createTask({ conversationId: chatB.id, objective: 'private-other-task' }).id;
    e.sendMessage(chatA.id, { text: '查询另一个会话的任务' }); e.tick(); await until(() => !e.routers.size);
    const target = e.task(targetId);
    assert.equal(target.status, 'queued');
    assert.equal(target.revision, 1);
    assert.equal(target.messages.length, 1);
    assert.equal(e.get('conversation', chatA.id).routerStatus, 'idle');
  } finally { await f.cleanup(); }
});

test('duplicate client input and dispatch keys do not create duplicate work', async () => {
  const f = fixture(scripted(() => completion('ok')), { maxWorkers: 0 }), e = f.engine;
  try {
    const chat = e.createConversation();
    e.sendMessage(chat.id, { text: 'one', requestId: 'same-message' });
    e.sendMessage(chat.id, { text: 'one', requestId: 'same-message' });
    assert.equal(e.get('conversation', chat.id).messages.length, 1);
    const a = e.createTask({ conversationId: chat.id, objective: 'one-task' }, `${chat.id}:call-1`);
    const b = e.createTask({ conversationId: chat.id, objective: 'one-task' }, `${chat.id}:call-1`);
    assert.equal(a.id, b.id);
    assert.equal(e.state().tasks.length, 1);
  } finally { await f.cleanup(); }
});

test('compacted task history archives old user messages and read_history retrieves them without reasoning', async () => {
  const marker = 'earliest-user-evidence-42';
  let step = 0;
  const model = scripted(args => {
    if (++step === 1) {
      assert.ok(!args.messages.some(m => m.content === marker));
      return calls(['recall', 'read_history', { kind: 'messages', offset: 0, limit: 2 }]);
    }
    const evidence = args.messages.find(m => m.role === 'tool' && m.tool_call_id === 'recall');
    assert.ok(evidence.content.includes(marker));
    assert.ok(!evidence.content.includes('private-old-reasoning'));
    return report('recall-report', '已找回早期证据');
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation(), created = e.createTask({ conversationId: chat.id, objective: '找回早期证据' });
    const task = e.get('task', created.id);
    task._history = [
      { role: 'user', content: marker },
      { role: 'assistant', content: 'a'.repeat(40000), reasoning_content: 'private-old-reasoning' },
      { role: 'user', content: 'middle-request' },
      { role: 'assistant', content: 'b'.repeat(40000) },
      { role: 'user', content: 'latest-request' },
      { role: 'assistant', content: 'c'.repeat(40000) },
    ];
    e.put('task', task);
    e.tick(); await until(() => !e.workers.size);
    assert.equal(e.task(task.id).status, 'completed');
    const archives = e.all('archive').filter(a => a.ownerId === task.id);
    assert.equal(archives.length, 1);
    assert.ok(archives[0].messages.some(m => m.content === marker));
    assert.equal(step, 2);
  } finally { await f.cleanup(); }
});

test('failed Worker and Router model requests count as calls with incomplete usage', async () => {
  const model = scripted(args => {
    if (isRouter(args) || args.messages[0].content.includes('failure-objective')) throw Object.assign(new Error('test-only provider outage'), { code: 'MODEL_HTTP' });
    return report('successful-report');
  });
  const f = fixture(model), e = f.engine;
  try {
    const chat = e.createConversation();
    const success = e.createTask({ conversationId: chat.id, objective: 'success-objective' });
    const failure = e.createTask({ conversationId: chat.id, objective: 'failure-objective' });
    e.tick(); await until(() => !e.workers.size);
    assert.equal(e.task(success.id).status, 'completed');
    assert.equal(e.task(failure.id).status, 'failed');
    e.sendMessage(chat.id, { text: '询问进度' }); e.tick(); await until(() => !e.routers.size);
    const metrics = e.state().metrics;
    assert.equal(metrics.modelCalls, 3);
    assert.equal(metrics.totalTokens, 8);
    assert.equal(metrics.usageComplete, false);
    assert.equal(e.all('call').filter(call => call.status === 'failed').length, 2);
  } finally { await f.cleanup(); }
});

test('background wait wakes on new user input without polling the model', async () => {
  let step = 0;
  const jobs = new Map([['job-one', { id: 'job-one', status: 'running', done: new Promise(() => {}) }]]);
  const model = scripted(args => {
    step++;
    if (step === 1) return calls(['wait', 'wait_for_jobs', {}]);
    if (step === 2) {
      assert.ok(args.messages.some(m => m.role === 'user' && m.content === '新增说明'));
      assert.ok(args.messages.some(m => m.role === 'tool' && m.content.includes('"inputPending":true')));
      return calls(['finish-test-job', 'finish_test_job', {}]);
    }
    return report('after-wake-report');
  });
  const f = fixture(model, { toolFactory: () => ({ jobs, close: async () => {}, tools: [{ name: 'finish_test_job', description: 'Finish controlled test job', parameters: { type: 'object', properties: {} }, execute: async () => { jobs.get('job-one').status = 'completed'; return { exitCode: 0 }; } }] }) }), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '等待后台工作' });
    e.tick(); await until(() => e.workers.get(task.id)?.inputReady);
    assert.equal(step, 1);
    e.followup(task.id, { text: '新增说明' });
    await until(() => !e.workers.size);
    assert.equal(e.task(task.id).status, 'completed');
    assert.equal(step, 3);
    assert.equal(e.task(task.id).runs.length, 1);
  } finally { await f.cleanup(); }
});

test('followup while stopping waits for old Worker cleanup, then resumes the same Task', async () => {
  let pending, workerCalls = 0, runtimeCount = 0, cleanupStarted = false, releaseCleanup;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const model = scripted(args => {
    if (++workerCalls === 1) { pending = deferred(args.signal); return pending.promise; }
    assert.ok(args.messages.some(m => m.role === 'user' && m.content === '停止后新增的要求'));
    return report('after-stop-followup', '已处理停止后收到的补充');
  });
  const f = fixture(model, { maxWorkers: 1, toolFactory: () => {
    const first = ++runtimeCount === 1;
    return { tools: [], jobs: new Map(), close: async () => { if (first) { cleanupStarted = true; await cleanupGate; } } };
  } }), e = f.engine;
  try {
    const chat = e.createConversation(), task = e.createTask({ conversationId: chat.id, objective: '中断后继续' });
    e.tick(); await until(() => pending);
    e.action(task.id, { action: 'stop' });
    e.followup(task.id, { text: '停止后新增的要求', requestId: 'during-stop' });
    await until(() => cleanupStarted);
    e.tick();
    assert.equal(e.workers.size, 1);
    assert.equal(workerCalls, 1);
    assert.equal(e.get('task', task.id)._resumeAfterStop, true);
    releaseCleanup(); await until(() => !e.workers.size);
    assert.equal(e.task(task.id).status, 'queued');
    assert.equal(e.get('task', task.id)._resumeAfterStop, undefined);
    e.tick(); await until(() => !e.workers.size);
    const current = e.task(task.id);
    assert.equal(current.status, 'completed');
    assert.equal(current.runs.length, 2);
    assert.equal(current.runs[0].status, 'interrupted');
    assert.equal(current.result, '已处理停止后收到的补充');
    assert.equal(e.state().tasks.length, 1);
  } finally { releaseCleanup(); await f.cleanup(); }
});

test('recovered repository preparation switches an existing clone off main onto its Task branch', { timeout: 10000 }, async () => {
  const model = scripted(() => report('prepared-report'));
  const f = fixture(model), e = f.engine;
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Assistant Test', '-c', 'user.email=assistant-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const source = join(f.dir, 'source-repo');
    git(f.dir, 'init', '-b', 'main', source);
    git(source, 'commit', '--allow-empty', '-m', 'Local test fixture');
    const chat = e.createConversation(), created = e.createTask({ conversationId: chat.id, objective: '恢复仓库准备', repository: source });
    const checkout = join(created.workspace, 'repo');
    // Simulate a crash after clone succeeded, before task branch creation.
    git(f.dir, 'clone', '--', source, checkout);
    assert.equal(git(checkout, 'branch', '--show-current'), 'main');
    assert.equal(e.get('task', created.id)._prepared, false);
    e.tick(); await e.workers.get(created.id).promise;
    assert.equal(e.task(created.id).status, 'completed');
    assert.equal(git(checkout, 'branch', '--show-current'), `codex/${created.id}`);
    assert.equal(git(source, 'branch', '--show-current'), 'main');
    assert.equal(e.get('task', created.id)._prepared, true);
    // Also reconcile the other interruption point: branch exists but metadata was not saved.
    const task = e.get('task', created.id); task._prepared = false; e.put('task', task);
    e.followup(created.id, { text: '再次核对已有工作目录' }); e.tick(); await e.workers.get(created.id).promise;
    assert.equal(e.task(created.id).status, 'completed');
    assert.equal(git(checkout, 'branch', '--show-current'), `codex/${created.id}`);
    assert.equal(e.task(created.id).runs.length, 2);
  } finally { await f.cleanup(); }
});
