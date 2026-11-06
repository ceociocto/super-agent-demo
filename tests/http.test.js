import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Engine } from '../server/engine.js';
import { createHandler } from '../server/index.js';

async function request(engine, { method = 'GET', url = '/api/state', headers = {}, payload } = {}) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))]);
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:4317', ...headers } });
  const result = { headers: {}, status: null, body: null };
  const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, h) { result.status = status; Object.assign(result.headers, h); }, end(body) { result.body = body ? JSON.parse(body) : null; } };
  await createHandler(engine)(req, res); return result;
}

test('HTTP API exposes actual engine state and accepts local JSON', async () => {
  const e = new Engine();
  try {
    const response = await request(e, { method: 'POST', url: '/api/events', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4317' }, payload: { eventId: '1', source: 'github', sourceThreadId: 'one', actor: 'alice', text: '修复空结果', scenario: 'bugfix' } });
    assert.equal(response.status, 200);
    const state = await request(e); assert.equal(state.body.tasks.length, 1); assert.equal(state.body.mode, 'simulation');
  } finally { e.close(); }
});

test('HTTP rejects cross-origin writes, foreign Host, non-JSON and oversized bodies', async () => {
  const e = new Engine();
  try {
    assert.equal((await request(e, { method: 'POST', url: '/api/events', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, payload: {} })).status, 403);
    assert.equal((await request(e, { headers: { host: 'evil.invalid' } })).status, 403);
    assert.equal((await request(e, { method: 'POST', url: '/api/events', payload: {} })).status, 415);
    assert.equal((await request(e, { method: 'POST', url: '/api/events', headers: { 'content-type': 'application/json' }, payload: 'x'.repeat(40000) })).status, 413);
    assert.equal((await request(e, { method: 'POST', url: '/api/events', headers: { 'content-type': 'application/json' }, payload: '{invalid' })).status, 400);
    assert.equal(e.state().tasks.length, 0);
  } finally { e.close(); }
});
