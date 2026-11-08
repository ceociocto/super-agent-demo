import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTools } from '../server/agent/tools.js';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const node = source => `${quote(process.execPath)} -e ${quote(source)}`;
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-tools-'));
  const workspace = join(directory, 'work'), events = [];
  const instance = createLocalTools({ workspace, onEvent: event => events.push(event), ...options });
  return { ...instance, directory, workspace, events,
    call(name, args) { return instance.tools.find(tool => tool.name === name).execute(args); },
    async dispose() { await instance.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('file tools write, uniquely edit, paginate and list real files', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('write_file', { path: 'nested/note.txt', content: '你好abc\n第二行' })).written, true);
    const first = await f.call('read_file', { path: 'nested/note.txt', limit: 2 });
    assert.equal(first.content, '你好'); assert.equal(first.totalLength, 9); assert.equal(first.hasMore, true);
    const second = await f.call('read_file', { path: first.path, offset: first.nextOffset, limit: 20 });
    assert.equal(second.content, 'abc\n第二行'); assert.equal(second.hasMore, false);
    assert.equal((await f.call('edit_file', { path: 'nested/note.txt', oldText: 'abc', newText: 'xyz' })).replacements, 1);
    assert.equal(await readFile(join(f.workspace, 'nested/note.txt'), 'utf8'), '你好xyz\n第二行');
    const entries = await f.call('list_files', { path: 'nested' }); assert.equal(entries.entries[0].name, 'note.txt');
    await f.call('write_file', { path: 'duplicate.txt', content: 'abc abc' });
    assert.match((await f.call('edit_file', { path: 'duplicate.txt', oldText: 'abc', newText: 'x' })).error, /恰好出现一次/);
    assert.equal(await readFile(join(f.workspace, 'duplicate.txt'), 'utf8'), 'abc abc');
  } finally { await f.dispose(); }
});

test('writes reject traversal and external symlinks; explicit outside reads work', async () => {
  const f = await fixture();
  try {
    const external = join(f.directory, 'outside.txt'); await writeFile(external, 'reference');
    assert.match((await f.call('write_file', { path: '../outside.txt', content: 'bad' })).error, /工作目录/);
    await symlink(external, join(f.workspace, 'link.txt'));
    assert.match((await f.call('write_file', { path: 'link.txt', content: 'bad' })).error, /符号链接/);
    assert.equal((await f.call('read_file', { path: external })).content, 'reference');
    assert.equal(await readFile(external, 'utf8'), 'reference');
  } finally { await f.dispose(); }
});

test('real commands return true exit code and tools do not receive model key environment', async () => {
  const f = await fixture();
  try {
    const result = await f.call('run_command', { command: node("console.log('ok'); console.error('problem'); process.exit(7)"), yieldMs: 500 });
    assert.equal(result.exitCode, 7); assert.equal(result.status, 'failed');
    assert.match(result.stdout, /ok/); assert.match(result.stderr, /problem/);
    assert.match(await readFile(result.logPath, 'utf8'), /problem/);
    const env = await f.call('run_command', { command: node("console.log(Object.keys(process.env).filter(k => /API_KEY$/.test(k)).length)"), yieldMs: 500 });
    assert.equal(env.stdout.trim(), '0');
    assert.ok(f.events.some(e => e.type === 'job.start')); assert.ok(f.events.some(e => e.type === 'job.end'));
  } finally { await f.dispose(); }
});

test('long commands run in background and preserve split UTF-8 and full paged log', async () => {
  const f = await fixture();
  try {
    const source = "const b=Buffer.from('中文🙂'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>{process.stdout.write(b.subarray(2));process.stdout.write('z'.repeat(30000));},100)";
    const started = await f.call('run_command', { command: node(source), yieldMs: 0 });
    assert.equal(started.status, 'running');
    const done = await f.call('inspect_job', { jobId: started.jobId, waitMs: 1000 });
    assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0);
    assert.ok(done.output.startsWith('中文🙂')); assert.equal(done.output.includes('�'), false);
    assert.equal(done.totalLength, 30004); assert.equal(done.hasMore, true); assert.equal(done.previewTruncated, true);
    const last = await f.call('read_file', { path: done.logPath, offset: 30000 });
    assert.equal(last.content, 'zzzz'); assert.equal(last.hasMore, false);
    assert.equal((await readFile(done.stdoutPath, 'utf8')).length, 30004);
  } finally { await f.dispose(); }
});

test('stop cancels a background command and close ends the process group', async () => {
  const f = await fixture();
  try {
    const started = await f.call('run_command', { command: node('setInterval(()=>{},1000)'), yieldMs: 0 });
    const pid = f.jobs.get(started.jobId).pid;
    const stopped = await f.call('stop_job', { jobId: started.jobId });
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.stopReason, 'stopped');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const next = await f.call('run_command', { command: node('setInterval(()=>{},1000)'), yieldMs: 0 });
    const nextPid = f.jobs.get(next.jobId).pid;
    await f.close(); assert.throws(() => process.kill(nextPid, 0), /ESRCH/);
  } finally { await f.dispose(); }
});

test('shell exit cleans orphaned redirected children and never reports their work completed', async () => {
  const f = await fixture(); let pid;
  try {
    const source = "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('child.ready',String(process.pid)); setInterval(()=>{},1000)";
    const result = await f.call('run_command', {
      command: `${node(source)} >/dev/null 2>&1 & child=$!; while [ ! -s child.ready ]; do sleep 0.01; done; echo "$child"`, yieldMs: 1500,
    });
    pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(result.exitCode, 0); // Shell success does not imply child success.
    assert.equal(result.status, 'failed');
    assert.equal(result.stopReason, 'background_descendants');
    assert.equal(result.cleanupPending, false);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(f.events.find(e => e.type === 'job.end').status, 'failed');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await f.dispose();
  }
});

test('runtime close and AbortSignal wait for TERM-resistant process-group descendants', async () => {
  for (const action of ['close', 'abort']) {
    const controller = new AbortController(), f = await fixture({ signal: controller.signal }); let pid;
    try {
      const source = "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('child.ready',String(process.pid)); setInterval(()=>{},1000)";
      const result = await f.call('run_command', {
        command: `${node(source)} >/dev/null 2>&1 & child=$!; while [ ! -s child.ready ]; do sleep 0.01; done; echo "$child"; wait`, yieldMs: 150,
      });
      pid = Number(await readFile(join(f.workspace, 'child.ready'), 'utf8'));
      assert.equal(result.status, 'running');
      if (action === 'close') await f.close();
      else { controller.abort(); await f.jobs.get(result.jobId).done; }
      assert.equal(f.jobs.get(result.jobId).status, 'cancelled');
      assert.equal(f.jobs.get(result.jobId).cleanupPending, false);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await f.dispose();
    }
  }
});

test('AbortSignal and command deadlines are explicit failures, not success', async () => {
  const controller = new AbortController(), f = await fixture({ signal: controller.signal });
  try {
    const started = await f.call('run_command', { command: node('setInterval(()=>{},1000)'), yieldMs: 0 });
    controller.abort(); await f.jobs.get(started.jobId).done;
    assert.equal(f.jobs.get(started.jobId).status, 'cancelled');
    await assert.rejects(f.call('list_files', {}), /停止/);
  } finally { await f.dispose(); }
  const timed = await fixture({ commandTimeoutMs: 60 });
  try {
    const result = await timed.call('run_command', { command: node('setInterval(()=>{},1000)'), yieldMs: 300 });
    assert.equal(result.status, 'failed'); assert.equal(result.stopReason, 'timeout');
  } finally { await timed.dispose(); }
});

test('fetch URL guard rejects private/literal and credential URLs before network access', async () => {
  const f = await fixture();
  try {
    for (const url of ['http://localhost/a', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/']) {
      assert.match((await f.call('fetch_url', { url })).error, /私网/);
    }
    assert.match((await f.call('fetch_url', { url: 'https://user:pass@example.com/' })).error, /凭证/);
    assert.match((await f.call('fetch_url', { url: 'file:///etc/passwd' })).error, /HTTP/);
  } finally { await f.dispose(); }
});
