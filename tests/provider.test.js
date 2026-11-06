import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../server/engine.js';
import { createProviderFromEnv, DEEPSEEK_ENDPOINT } from '../server/provider.js';

const event = (overrides = {}) => ({ eventId: 'e1', source: 'github', sourceThreadId: 'issue-1', actor: 'alice', text: '发布有哪些要求？', scenario: 'docs', ...overrides });
const generate = e => { e.tick(); e.tick(); e.tick(); };
const result = text => ({ text, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
function controlledProvider() {
  const calls = [];
  return { name: 'fake', model: 'test-only', calls, generate(args) { return new Promise((resolve, reject) => calls.push({ ...args, resolve, reject })); } };
}
const settle = async () => { await delay(0); };

test('provider defaults to simulation; live requires a key and does not expose it', async () => {
  assert.equal(createProviderFromEnv({}), null);
  assert.throws(() => createProviderFromEnv({ MODEL_PROVIDER: 'deepseek' }), /DEEPSEEK_API_KEY/);
  assert.throws(() => createProviderFromEnv({ MODEL_PROVIDER: 'other' }), /仅支持/);
  let sent;
  const p = createProviderFromEnv({ MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-not-real' }, async (url, options) => {
    sent = { url, options };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '草案 [KB-001]' } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) };
  });
  const r = await p.generate({ messages: [{ role: 'user', content: 'test' }], signal: new AbortController().signal, maxTokens: 2048 });
  assert.equal(sent.url, DEEPSEEK_ENDPOINT); assert.equal(sent.options.redirect, 'error');
  assert.equal(JSON.parse(sent.options.body).max_tokens, 2048); assert.equal(JSON.parse(sent.options.body).tools, undefined);
  assert.equal(JSON.parse(sent.options.body).model, 'deepseek-flash');
  assert.deepEqual(JSON.parse(sent.options.body).thinking, { type: 'disabled' });
  assert.equal(createProviderFromEnv({ MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-not-real', DEEPSEEK_MODEL: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  assert.equal(r.usage.totalTokens, 18); assert.ok(!JSON.stringify(p).includes('test-not-real'));
});

test('live model produces reviewable text with actual usage, never auto-approves', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider });
  try {
    const t = e.ingest(event()).task; generate(e);
    assert.equal(e.task(t.id).status, 'generating'); assert.equal(provider.calls.length, 1);
    assert.equal(e.state().mode, 'live'); assert.equal(e.state().metrics.modelCalls, 1);
    assert.equal(provider.calls[0].maxTokens, 2048);
    provider.calls[0].resolve(result('需负责人审阅 [KB-001]。')); await settle();
    const task = e.task(t.id); assert.equal(task.status, 'awaiting_approval');
    assert.match(task.artifact.content, /需负责人审阅/); assert.equal(task.artifact.kind, 'model_review_draft');
    assert.equal(e.state().metrics.tokens, 15); assert.equal(e.state().metrics.cost, null); assert.equal(e.state().metrics.usageComplete, true);
    assert.equal(e.state().notifications.length, 1);
  } finally { e.close(); }
});

test('in-flight model cancellation discards late results and does not notify approval', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider });
  try {
    const t = e.ingest(event()).task; generate(e); e.action(t.id, { action: 'cancel' });
    assert.equal(provider.calls[0].signal.aborted, true);
    provider.calls[0].resolve(result('迟到的旧结果')); await settle();
    assert.equal(e.task(t.id).status, 'cancelled'); assert.equal(e.task(t.id).artifact, null);
    assert.equal(e.state().notifications.length, 0); assert.equal(e.state().metrics.usageComplete, false);
  } finally { e.close(); }
});

test('followup invalidates generation; old result cannot overwrite revised draft', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider });
  try {
    const t = e.ingest(event()).task; generate(e);
    e.followup(t.id, { text: '还需要说明P1故障处理' });
    assert.equal(e.task(t.id).status, 'queued'); generate(e);
    assert.equal(provider.calls.length, 2); assert.match(provider.calls[1].messages[1].content, /P1故障处理/);
    provider.calls[1].resolve(result('新版本')); provider.calls[0].resolve(result('旧版本')); await settle();
    assert.equal(e.task(t.id).status, 'awaiting_approval');
    assert.match(e.task(t.id).artifact.content, /新版本/); assert.ok(!e.task(t.id).artifact.content.includes('旧版本'));
    assert.equal(e.task(t.id).revision, 2); assert.equal(e.state().notifications.length, 1);
  } finally { e.close(); }
});

test('pause aborts generation; resume generates anew and preserves review gate', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider });
  try {
    const t = e.ingest(event()).task; generate(e); e.action(t.id, { action: 'pause' });
    provider.calls[0].resolve(result('旧结果')); await settle();
    assert.equal(e.task(t.id).status, 'paused'); assert.equal(e.task(t.id).artifact, null);
    e.action(t.id, { action: 'resume' }); generate(e);
    provider.calls[1].resolve(result('恢复后的结果')); await settle();
    assert.equal(e.task(t.id).status, 'awaiting_approval');
  } finally { e.close(); }
});

test('provider failure is explicit, does not leak error contents, and requires manual retry', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider });
  try {
    const t = e.ingest(event()).task; generate(e);
    provider.calls[0].reject(new Error('potential-secret-do-not-expose')); await settle();
    assert.equal(e.task(t.id).status, 'failed'); assert.equal(e.task(t.id).artifact, null);
    assert.ok(!JSON.stringify(e.state()).includes('potential-secret-do-not-expose'));
    generate(e); assert.equal(provider.calls.length, 1);
    e.action(t.id, { action: 'retry' }); generate(e); provider.calls[1].resolve(result('重试结果')); await settle();
    assert.equal(e.task(t.id).status, 'awaiting_approval'); assert.equal(e.state().metrics.modelCalls, 2);
  } finally { e.close(); }
});

test('timeout aborts transport and fails explicitly without simulation fallback', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider, generationTimeoutMs: 10 });
  try {
    const t = e.ingest(event()).task; generate(e); await delay(25);
    assert.equal(provider.calls[0].signal.aborted, true); assert.equal(e.task(t.id).status, 'failed');
    assert.match(e.task(t.id).error, /超时/); assert.equal(e.task(t.id).artifact, null);
  } finally { e.close(); }
});

test('generating jobs count against concurrency limit; each gets only its own context', async () => {
  const provider = controlledProvider(); const e = new Engine({ provider, maxWorkers: 1 });
  try {
    const a = e.ingest(event({ text: '任务A唯一标记' })).task;
    const b = e.ingest(event({ eventId: 'e2', sourceThreadId: 'two', text: '任务B唯一标记' })).task;
    generate(e); generate(e); assert.equal(provider.calls.length, 1); assert.equal(e.task(b.id).status, 'queued');
    assert.match(provider.calls[0].messages[1].content, /任务A唯一标记/); assert.ok(!provider.calls[0].messages[1].content.includes('任务B唯一标记'));
    provider.calls[0].resolve(result('A完成')); await settle(); generate(e);
    assert.equal(provider.calls.length, 2); assert.ok(!provider.calls[1].messages[1].content.includes('任务A唯一标记'));
    provider.calls[1].resolve(result('B完成')); await settle();
    assert.equal(e.task(a.id).status, 'awaiting_approval');
  } finally { e.close(); }
});

test('restart invalidates pending generation; simulation never silently executes persisted live work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-live-test-')); const path = join(dir, 'test.sqlite');
  const provider = controlledProvider(); let e = new Engine({ dbPath: path, provider });
  try {
    const t = e.ingest(event()).task; generate(e); e.close();
    e = new Engine({ dbPath: path }); assert.equal(e.task(t.id).status, 'queued'); generate(e);
    assert.equal(e.task(t.id).status, 'failed'); assert.match(e.task(t.id).summary, /不会自动降级/);
    assert.throws(() => e.action(t.id, { action: 'retry' }), /不能降级/);
    e.close(); e = new Engine({ dbPath: path, provider }); e.action(t.id, { action: 'retry' }); generate(e);
    provider.calls[1].resolve(result('重启后的新草案')); await settle();
    assert.equal(e.task(t.id).status, 'awaiting_approval'); assert.equal(e.state().metrics.modelCalls, 2);
  } finally { e.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP failure and truncated/tool responses never become accepted text', async () => {
  const env = { MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'fake-key' };
  const args = { messages: [], signal: new AbortController().signal, maxTokens: 2048 };
  const failed = createProviderFromEnv(env, async () => ({ ok: false, status: 401 }));
  await assert.rejects(failed.generate(args), /HTTP 401/);
  const truncated = createProviderFromEnv(env, async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'unfinished' } }] }) }));
  await assert.rejects(truncated.generate(args), /不完整/);
  const tool = createProviderFromEnv(env, async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'execute', tool_calls: [{}] } }] }) }));
  await assert.rejects(tool.generate(args), /无效/);
});

test('followup after restart retains full prior draft in same-task context without cross-task leakage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-draft-test-')); const path = join(dir, 'test.sqlite');
  const provider = controlledProvider(); let e = new Engine({ dbPath: path, provider });
  try {
    const a = e.ingest(event()).task; generate(e);
    const priorDraft = '# 第一版\n\n第一段。\n\nUNIQUE_PRIOR_DRAFT_731 第二段完整内容。';
    provider.calls[0].resolve(result(priorDraft)); await settle();
    assert.ok(e.task(a.id).messages.some(m => m.role === 'assistant' && m.text.includes(priorDraft)));
    e.close(); e = new Engine({ dbPath: path, provider });
    e.followup(a.id, { text: '请改写上一稿第二段，保留第一段。' });
    assert.equal(e.task(a.id).artifact, null);
    const b = e.ingest(event({ eventId: 'e2', sourceThreadId: 'other', text: '独立任务B' })).task;
    generate(e);
    const callA = provider.calls.find((call, i) => i > 0 && call.messages[1].content.includes('请改写上一稿第二段'));
    const callB = provider.calls.find((call, i) => i > 0 && call.messages[1].content.includes('独立任务B'));
    assert.ok(callA); assert.ok(callB);
    const contextA = JSON.parse(callA.messages[1].content);
    assert.ok(contextA.taskMessages.some(m => m.role === 'assistant' && m.text.includes(priorDraft)));
    assert.ok(!callB.messages[1].content.includes('UNIQUE_PRIOR_DRAFT_731'));
    assert.ok(!callA.messages[1].content.includes('独立任务B'));
    callA.resolve(result('修订稿')); callB.resolve(result('独立任务B草案')); await settle();
    assert.equal(e.task(a.id).status, 'awaiting_approval'); assert.equal(e.task(b.id).status, 'awaiting_approval');
  } finally { e.close(); rmSync(dir, { recursive: true, force: true }); }
});
