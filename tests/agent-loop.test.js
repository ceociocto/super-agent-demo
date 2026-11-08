import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, DEFAULT_GLM_BASE_URL } from '../server/agent/model.js';
import { runAgent } from '../server/agent/loop.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const text = content => ({ message: { role: 'assistant', content }, usage });
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const turn = (...calls) => ({ message: { role: 'assistant', content: null, reasoning_content: 'private reasoning', tool_calls: calls }, usage });
const sequence = outputs => ({ model: 'test-model', async complete() { if (!outputs.length) throw Error('Unexpected model request'); return outputs.shift(); } });
const add = { name: 'add', description: 'Add two integers', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false }, execute: async ({ a, b }) => ({ sum: a + b }) };
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const choice = (message, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }], model: 'glm-5.3', id: 'request-test', usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });

test('GLM adapter uses real endpoint, preserves tool reasoning and reports actual usage without exposing key', async () => {
  let request;
  const model = createModel({ GLM_API_KEY: 'test-secret' }, { config: {}, fetchImpl: async (url, options) => { request = { url, ...options }; return response(choice({ role: 'assistant', content: null, reasoning_content: 'hidden', tool_calls: [call('one', 'add', { a: 1, b: 2 })] }, 'tool_calls')); } });
  const result = await model.complete({ messages: [{ role: 'user', content: 'add' }], tools: [] });
  assert.equal(request.url, `${DEFAULT_GLM_BASE_URL}/chat/completions`);
  assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(result.message.reasoning_content, 'hidden');
  assert.equal(result.message.tool_calls[0].id, 'one');
  assert.equal(result.usage.totalTokens, 19);
  assert.equal(result.requestId, 'request-test');
  assert.ok(!JSON.stringify(model).includes('test-secret'));
});

test('generic endpoint/model overrides omit GLM-specific request fields', async () => {
  let request;
  const model = createModel({ MODEL_API_KEY: 'generic-key', MODEL_BASE_URL: 'https://example.test/v1', MODEL_NAME: 'other-model', GLM_REASONING_EFFORT: 'max' }, { config: {}, fetchImpl: async (_, options) => { request = options; return response(choice({ content: 'ok' })); } });
  await model.complete({ messages: [] });
  const body = JSON.parse(request.body);
  assert.equal(model.name, 'openai-compatible');
  assert.equal(body.model, 'other-model');
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('secret-free configuration supports env key reference and refuses reserved extra body fields', async () => {
  let request;
  const model = createModel({ CUSTOM_KEY: 'custom-secret' }, { config: { baseUrl: 'http://localhost:9000/v1', model: 'custom', apiKeyEnv: 'CUSTOM_KEY', extraBody: { temperature: 0.3 } }, fetchImpl: async (_, options) => { request = options; return response(choice({ content: 'ok' })); } });
  await model.complete({ messages: [] });
  assert.equal(request.headers.Authorization, 'Bearer custom-secret');
  assert.equal(JSON.parse(request.body).temperature, 0.3);
  assert.throws(() => createModel({}, { config: { extraBody: { messages: [] } } }), /extraBody/);
  assert.throws(() => createModel({ MODEL_BASE_URL: 'https://secret@example.test/v1' }, { config: {} }), /凭证/);
  assert.throws(() => createModel({ MODEL_BASE_URL: 'https://example.test/v1?key=hidden' }, { config: {} }), /查询参数/);
});

test('explicit LAN HTTP endpoint is used unchanged with the configured credential', async () => {
  let request;
  const model = createModel({ MODEL_BASE_URL: 'http://192.168.1.25:8080/v1', MODEL_NAME: 'local-model', MODEL_API_KEY: 'local-test-key' }, { config: {}, fetchImpl: async (url, options) => { request = { url, ...options }; return response(choice({ content: 'ok' })); } });
  await model.complete({ messages: [] });
  assert.equal(request.url, 'http://192.168.1.25:8080/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer local-test-key');
  assert.equal(request.redirect, 'error');
});

test('output length parameter is configurable and never sends both token fields', async () => {
  for (const maxTokensField of ['max_tokens', 'max_completion_tokens']) {
    let body;
    const model = createModel({ MODEL_API_KEY: 'test-only' }, { config: { model: 'generic', maxTokensField, maxTokens: 1234 }, fetchImpl: async (_, options) => { body = JSON.parse(options.body); return response(choice({ content: 'ok' })); } });
    await model.complete({ messages: [] });
    assert.equal(body[maxTokensField], 1234);
    assert.equal(body[maxTokensField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'], undefined);
  }
  assert.throws(() => createModel({}, { config: { maxTokensField: 'invalid_field' } }), /maxTokensField/);
  assert.throws(() => createModel({}, { config: { extraBody: { max_completion_tokens: 100 } } }), /extraBody/);
});

test('changing only the endpoint never sends a legacy GLM key to another provider', async () => {
  for (const configuration of [
    { env: { MODEL_BASE_URL: 'https://other-provider.test/v1', GLM_API_KEY: 'legacy-secret' }, config: {} },
    { env: { GLM_API_KEY: 'legacy-secret' }, config: { baseUrl: 'http://192.168.1.25:8080/v1' } },
  ]) {
    let called = false;
    const model = createModel(configuration.env, { config: configuration.config, fetchImpl: async () => { called = true; return response(choice({ content: 'not expected' })); } });
    assert.equal(model.configured, false);
    await assert.rejects(model.complete({ messages: [] }), { code: 'MODEL_NOT_CONFIGURED' });
    assert.equal(called, false);
  }
});

test('explicit apiKeyEnv wins over generic credentials and public configuration contains no secret', async () => {
  let request;
  const model = createModel({ MODEL_API_KEY: 'generic-secret', CUSTOM_KEY: 'chosen-secret', GLM_API_KEY: 'legacy-secret' }, { config: { baseUrl: 'https://chosen-provider.test/v1', model: 'chosen-model', apiKeyEnv: 'CUSTOM_KEY', extraBody: { temperature: 0.2 } }, fetchImpl: async (_, options) => { request = options; return response(choice({ content: 'ok' })); } });
  await model.complete({ messages: [] });
  assert.equal(request.headers.Authorization, 'Bearer chosen-secret');
  assert.deepEqual(JSON.parse(JSON.stringify(model)), { name: 'openai-compatible', model: 'chosen-model', baseUrl: 'https://chosen-provider.test/v1', configured: true });
  const missingExplicit = createModel({ MODEL_API_KEY: 'generic-secret' }, { config: { apiKeyEnv: 'MISSING_SPECIFIC_KEY' } });
  assert.equal(missingExplicit.configured, false);
  await assert.rejects(missingExplicit.complete({ messages: [] }), { code: 'MODEL_NOT_CONFIGURED' });
});

test('missing key never falls back to simulated output', async () => {
  let called = false;
  const model = createModel({}, { config: {}, fetchImpl: async () => { called = true; } });
  assert.equal(model.configured, false);
  await assert.rejects(model.complete({ messages: [] }), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('HTTP errors and fetch exceptions do not expose provider bodies or credentials', async () => {
  for (const fetchImpl of [async () => new Response('test-secret leaked body', { status: 401 }), async () => { throw Error('test-secret leaked exception'); }]) {
    const model = createModel({ GLM_API_KEY: 'test-secret' }, { config: {}, fetchImpl });
    await assert.rejects(model.complete({ messages: [] }), error => !error.message.includes('test-secret'));
  }
});

test('truncated, empty, duplicated, or oversized model responses are rejected before tools execute', async () => {
  const cases = [choice({ content: 'partial' }, 'length'), choice({ content: '' }), choice({ content: null, tool_calls: [call('x', 'add'), call('x', 'add')] }, 'tool_calls')];
  for (const item of cases) {
    const model = createModel({ GLM_API_KEY: 'x' }, { config: {}, fetchImpl: async () => response(item) });
    await assert.rejects(model.complete({ messages: [] }), /模型/);
  }
  const model = createModel({ GLM_API_KEY: 'x' }, { config: {}, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(model.complete({ messages: [] }), { code: 'MODEL_OUTPUT_LIMIT' });
});

test('adapter enforces timeout even if a transport ignores its signal', async () => {
  const model = createModel({ GLM_API_KEY: 'x', GLM_TIMEOUT_MS: '10' }, { config: {}, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(model.complete({ messages: [] }), { code: 'MODEL_TIMEOUT' });
});

test('agent completes a real tool round trip, checkpoints protocol history, and hides reasoning from events', async () => {
  const messages = [{ role: 'user', content: '1+2?' }], events = [], checkpoints = [];
  const model = sequence([turn(call('one', 'add', { a: 1, b: 2 })), text('3')]);
  const result = await runAgent({ model, messages, tools: [add], onEvent: e => events.push(e), checkpoint: history => checkpoints.push(structuredClone(history)) });
  assert.equal(result.text, '3');
  assert.equal(result.steps, 2);
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(messages[1].reasoning_content, 'private reasoning');
  assert.deepEqual(JSON.parse(messages[2].content), { sum: 3 });
  assert.equal(checkpoints.length, 3);
  assert.equal(events.filter(e => e.type === 'tool.start').length, 1);
  assert.ok(!JSON.stringify(events).includes('private reasoning'));
});

test('invalid arguments and unknown tools are feedback, not executions', async () => {
  let executions = 0;
  const tool = { ...add, execute: async () => { executions += 1; } };
  const messages = [];
  const model = sequence([turn(call('one', 'add', { a: '1', b: 2 }), call('two', 'missing')), text('无法完成')]);
  await runAgent({ model, messages, tools: [tool] });
  assert.equal(executions, 0);
  assert.match(JSON.parse(messages[1].content).error, /类型/);
  assert.match(JSON.parse(messages[2].content).error, /未知工具/);
});

test('tool failures feed back into the next model turn for correction', async () => {
  const messages = [];
  const model = sequence([turn(call('one', 'add', { a: 1, b: 2 })), text('工具失败，需要检查')]);
  await runAgent({ model, messages, tools: [{ ...add, execute: async () => { throw Error('actual failure'); } }] });
  assert.equal(JSON.parse(messages[1].content).error, 'actual failure');
});

test('beforeStep injects followups at model boundaries without discarding prior results', async () => {
  const messages = [], inputs = [[{ role: 'user', content: 'first' }], [{ role: 'user', content: 'followup' }]];
  const model = sequence([turn(call('one', 'add', { a: 1, b: 2 })), text('done')]);
  await runAgent({ model, messages, tools: [add], beforeStep: async () => inputs.shift() });
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  assert.equal(messages[3].content, 'followup');
});

test('cancellation completes pending protocol entries but never executes remaining tools', async () => {
  const controller = new AbortController(), messages = [];
  let executions = 0;
  const model = sequence([turn(call('one', 'add', { a: 1, b: 2 }), call('two', 'add', { a: 2, b: 3 }))]);
  await assert.rejects(runAgent({ model, messages, signal: controller.signal, tools: [{ ...add, execute: async () => { executions += 1; controller.abort(); return { sum: 3 }; } }] }), { name: 'AbortError' });
  assert.equal(executions, 1);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.slice(1).map(m => m.tool_call_id), ['one', 'two']);
  assert.equal(JSON.parse(messages[2].content).skipped, true);
});

test('handoff skips later calls, preserves protocol, and ends without another model request', async () => {
  let stop = false, executions = 0;
  const messages = [];
  const result = await runAgent({ model: sequence([turn(call('one', 'add', { a: 1, b: 2 }), call('two', 'add', { a: 2, b: 3 }))]), messages, context: { shouldStop: () => stop }, tools: [{ ...add, execute: async () => { executions += 1; stop = true; return { status: 'waiting_input' }; } }] });
  assert.equal(executions, 1);
  assert.equal(result.steps, 1);
  assert.equal(JSON.parse(messages[2].content).skipped, true);
});

test('step limit is explicit failure; unknown usage stays unknown', async () => {
  const messages = [];
  await assert.rejects(runAgent({ model: sequence([turn(call('one', 'add', { a: 1, b: 2 }))]), messages, tools: [add], maxSteps: 1 }), { code: 'AGENT_STEP_LIMIT' });
  const result = await runAgent({ model: sequence([{ message: { role: 'assistant', content: 'ok' } }]), messages: [] });
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.complete, false);
});

test('tool context carries the exact persisted model call ID for deduplication', async () => {
  const messages = [], received = [];
  await runAgent({ model: sequence([turn(call('stable-first', 'add', { a: 1, b: 2 }), call('stable-second', 'add', { a: 3, b: 4 })), text('done')]), messages, context: { taskId: 'task-a' }, tools: [{ ...add, execute: async (args, context) => { received.push(context); return { sum: args.a + args.b }; } }] });
  assert.deepEqual(received.map(x => x.toolCallId), ['stable-first', 'stable-second']);
  assert.ok(received.every(x => x.taskId === 'task-a'));
  assert.deepEqual(messages[0].tool_calls.map(x => x.id), received.map(x => x.toolCallId));
});

test('model failure emits structural metadata without leaking exception text', async () => {
  const events = [], error = Object.assign(new Error('private key and prompt'), { code: 'MODEL_HTTP' });
  await assert.rejects(runAgent({ model: { model: 'test', complete: async () => { throw error; } }, messages: [], onEvent: event => events.push(event) }), error);
  assert.deepEqual(events.at(-1), { type: 'model.error', step: 1, model: 'test', code: 'MODEL_HTTP' });
  assert.ok(!JSON.stringify(events).includes('private key'));
});

test('claimed inbox messages checkpoint as one complete batch even when persistence fails', async () => {
  const messages = [{ role: 'user', content: 'existing' }];
  const added = [{ role: 'user', content: 'first followup' }, { role: 'user', content: 'second followup' }];
  const snapshots = [];
  let modelCalled = false;
  await assert.rejects(runAgent({
    model: { complete: async () => { modelCalled = true; return text('unexpected'); } }, messages,
    beforeStep: async () => added,
    checkpoint: async history => { snapshots.push(structuredClone(history)); throw Error('simulated crash after write'); },
  }), /simulated crash/);
  assert.equal(modelCalled, false);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].map(m => m.content), ['existing', 'first followup', 'second followup']);
  assert.deepEqual(messages, snapshots[0]);
});
