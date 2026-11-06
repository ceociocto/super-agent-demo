import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { queryTokens, normalizeText } from '../runtime/query.mjs';
import { ColimaExecutor, dockerRunArgs, containerNameForRun } from '../server/executor.js';

const input = { id: 'task-a', runId: 'run-a', revision: 1, scenario: 'docs', messages: [{ role: 'user', text: '发布规范' }], knowledge: [{ id: 'KB-1', title: '规范', content: '发布前测试。' }] };
const output = { artifact: { name: 'answer.md', content: '实际检索结果', citations: [], mimeType: 'text/markdown', published: false }, execution: { containerId: 'abc123', hostname: 'abc123', platform: 'linux/arm64', exitCode: 0 } };
function fakeSpawn(handler) {
  const calls = [];
  const fn = (file, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { child.killed = signal; return true; };
    let text = '';
    child.stdin.on('data', c => { text += c.toString(); });
    const call = { file, args, options, child, input: () => text };
    calls.push(call);
    queueMicrotask(() => handler(call));
    return child;
  };
  fn.calls = calls;
  return fn;
}
function respond(call, text, code = 0) { if (text) call.child.stdout.write(text); call.child.emit('close', code); }

function lifecycle(handler) {
  return fakeSpawn(c => {
    if (c.args[2] === 'create') respond(c, 'a'.repeat(64));
    else if (c.args[2] === 'inspect') respond(c, 'true');
    else if (c.args[2] === 'rm') respond(c, 'removed');
    else handler(c);
  });
}

test('executor uses explicit context, no shell, no host mounts, constrained containers and unique run names', async () => {
  const args = dockerRunArgs({ runId: 'weird; $(touch /tmp/no)' });
  assert.equal(args[0], '--context'); assert.equal(args[1], 'colima-superagent-demo');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('ALL')); assert.ok(args.includes('no-new-privileges'));
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.ok(!args.includes('--volume')); assert.ok(!args.includes('--mount')); assert.ok(!args.some(x => x.includes('docker.sock')));
  assert.match(args[args.indexOf('--name') + 1], /^sa-demo-[a-f0-9]{20}$/);
  assert.notEqual(containerNameForRun('run-1'), containerNameForRun('run-2'));
  const spawn = lifecycle(c => respond(c, JSON.stringify({ type: 'result', result: output }) + '\n'));
  const executor = new ColimaExecutor({ spawnImpl: spawn });
  await executor.run(input);
  assert.equal(spawn.calls[0].file, 'docker'); assert.equal(spawn.calls[0].options.shell, false);
  assert.deepEqual(JSON.parse(spawn.calls.find(c => c.args[2] === 'start').input()).knowledge, input.knowledge);
});

test('executor parses streaming logs and Linux result and reports run identity', async () => {
  const spawn = lifecycle(c => {
    const text = JSON.stringify({ type: 'log', text: '真实日志：测试通过' }) + '\n' + JSON.stringify({ type: 'result', result: output }) + '\n';
    c.child.stdout.write(Buffer.from(text).subarray(0, 23)); c.child.stdout.write(Buffer.from(text).subarray(23)); c.child.emit('close', 0);
  });
  const logs = []; let started;
  const executor = new ColimaExecutor({ spawnImpl: spawn });
  const result = await executor.run({ ...input, onLog: t => logs.push(t), onStart: x => { started = x; } });
  assert.ok(logs.includes('真实日志：测试通过')); assert.equal(started.runId, 'run-a');
  assert.equal(result.execution.containerName, containerNameForRun('run-a')); assert.equal(result.execution.exitCode, 0);
  assert.equal(result.artifact.content, output.artifact.content);
});

test('status requires both reachable Linux Docker and an existing image', async () => {
  const spawn = fakeSpawn(c => respond(c, c.args.includes('info') ? JSON.stringify({ OSType: 'linux', Name: 'colima', ServerVersion: '29' }) : 'sha256:test'));
  const state = await new ColimaExecutor({ spawnImpl: spawn }).status();
  assert.equal(state.available, true); assert.equal(state.imageId, 'sha256:test');
  const bad = fakeSpawn(c => c.child.emit('error', new Error('ENOENT')));
  assert.equal((await new ColimaExecutor({ spawnImpl: bad }).status()).available, false);
});

test('abort terminates only the labelled task container and rejects late results', async () => {
  let running;
  const spawn = lifecycle(c => { if (c.args[2] === 'start') running = c; });
  const executor = new ColimaExecutor({ spawnImpl: spawn }); const controller = new AbortController();
  const promise = executor.run({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  running.child.stdout.write(JSON.stringify({ type: 'result', result: output }) + '\n'); running.child.emit('close', 0);
  await assert.rejects(promise, { code: 'ABORTED' });
  const removal = spawn.calls.find(c => c.args.includes('rm'));
  assert.equal(removal.args.at(-1), containerNameForRun('run-a')); assert.ok(running.child.killed);
});

test('timeout, malformed output and nonzero exit are explicit errors, never success templates', async () => {
  const spawn = lifecycle(() => {});
  await assert.rejects(new ColimaExecutor({ spawnImpl: spawn, timeoutMs: 5 }).run(input), { code: 'EXECUTOR_TIMEOUT' });
  const malformed = lifecycle(c => respond(c, 'not json\n'));
  await assert.rejects(new ColimaExecutor({ spawnImpl: malformed }).run(input), { code: 'EXECUTOR_PROTOCOL' });
  const failed = lifecycle(c => { c.child.stderr.write('test failed'); c.child.emit('close', 1); });
  await assert.rejects(new ColimaExecutor({ spawnImpl: failed }).run(input), { code: 'EXECUTOR_FAILED' });
});

test('cleanup refuses foreign labels, run validates input and rejects already cancelled tasks', async () => {
  const spawn = fakeSpawn(c => respond(c, 'false'));
  const executor = new ColimaExecutor({ spawnImpl: spawn });
  await assert.rejects(executor.cleanup('foreign'), { code: 'EXECUTOR_SCOPE' });
  assert.equal(spawn.calls.some(c => c.args.includes('rm')), false);
  await assert.rejects(executor.run({ ...input, scenario: 'shell' }), { code: 'EXECUTOR_INPUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executor.run({ ...input, signal: controller.signal }), { code: 'ABORTED' });
});

test('abort while create is pending waits for creation and never starts container', async () => {
  let creation;
  const spawn = fakeSpawn(c => {
    if (c.args[2] === 'create') creation = c;
    else if (c.args[2] === 'inspect') respond(c, 'true');
    else if (c.args[2] === 'rm') respond(c, 'removed');
    else assert.fail('start must not be dispatched');
  });
  const controller = new AbortController();
  const promise = new ColimaExecutor({ spawnImpl: spawn }).run({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal(creation.child.killed, undefined);
  respond(creation, 'a'.repeat(64));
  await assert.rejects(promise, error => error.code === 'ABORTED' && error.cleanupPending === false);
  assert.equal(spawn.calls.some(c => c.args[2] === 'start'), false);
  assert.equal(spawn.calls.some(c => c.args[2] === 'rm'), true);
});

test('unavailable cleanup is reported and cannot be mistaken for a removed container', async () => {
  let running;
  const spawn = fakeSpawn(c => {
    if (c.args[2] === 'create') respond(c, 'a'.repeat(64));
    else if (c.args[2] === 'start') running = c;
    else c.child.emit('error', new Error('ECONNREFUSED'));
  });
  const controller = new AbortController();
  const promise = new ColimaExecutor({ spawnImpl: spawn }).run({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(promise, error => error.code === 'ABORTED' && error.cleanupPending === true && error.cleanupError.includes('不可用'));
  assert.ok(running.child.killed);
});

test('timed-out create remains fenced even if immediate cleanup cannot find a container', async () => {
  const spawn = fakeSpawn(c => {
    if (c.args[2] === 'create') return;
    c.child.stderr.write('Error: No such container'); c.child.emit('close', 1);
  });
  await assert.rejects(new ColimaExecutor({ spawnImpl: spawn, timeoutMs: 5 }).run(input), error => error.code === 'EXECUTOR_TIMEOUT' && error.cleanupPending === true && error.creationUncertain === true);
  assert.equal(spawn.calls.some(c => c.args[2] === 'start'), false);
});

test('knowledge follow-up retains original query and explicit never-pull prevents implicit downloads', () => {
  const tokens = queryTokens([{ role: 'user', text: '发布规范需要做哪些测试？' }, { role: 'user', text: '再展开一点' }]);
  assert.ok(tokens.includes('发布'));
  assert.ok(tokens.some(token => normalizeText('发布前回归测试必须通过。').includes(token)));
  const args = dockerRunArgs({ runId: 'fixed' });
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
});

test('definite pre-create failures do not leave a false uncertain-creation fence', async () => {
  for (const failure of ['missing-client', 'context "colima-superagent-demo": context not found', 'Error: No such image: superagent-worker:local']) {
    const spawn = fakeSpawn(c => {
      assert.equal(c.args[2], 'create');
      if (failure === 'missing-client') c.child.emit('error', Object.assign(new Error('no binary'), { code: 'ENOENT' }));
      else { c.child.stderr.write(failure); c.child.emit('close', 1); }
    });
    await assert.rejects(new ColimaExecutor({ spawnImpl: spawn }).run(input), error => error.cleanupPending === false && error.creationUncertain === false);
    assert.equal(spawn.calls.length, 1);
  }
});

test('daemon transport failure is uncertain even when inspect immediately reports absence', async () => {
  const spawn = fakeSpawn(c => {
    c.child.stderr.write(c.args[2] === 'create' ? 'Error response from daemon: connection reset' : 'Error: No such container');
    c.child.emit('close', 1);
  });
  await assert.rejects(new ColimaExecutor({ spawnImpl: spawn }).run(input), error => error.creationUncertain === true && error.cleanupPending === true);
});

test('actual removal resolves an initially uncertain create outcome', async () => {
  const spawn = fakeSpawn(c => {
    if (c.args[2] === 'create') { c.child.stderr.write('Error response from daemon: connection reset'); c.child.emit('close', 1); }
    else if (c.args[2] === 'inspect') respond(c, 'true');
    else if (c.args[2] === 'rm') respond(c, 'removed');
  });
  await assert.rejects(new ColimaExecutor({ spawnImpl: spawn }).run(input), error => error.creationUncertain === false && error.cleanupPending === false);
});
