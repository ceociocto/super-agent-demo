import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createModel } from '../server/agent/model.js';
import { runAgent } from '../server/agent/loop.js';

const dir = await mkdtemp(join(tmpdir(), 'superagent-model-'));
const started = Date.now();
try {
  const nonce = randomBytes(16).toString('hex');
  await writeFile(join(dir, 'proof.txt'), nonce, { mode: 0o600 });
  const model = createModel();
  let toolCalls = 0, returnedModel = model.model;
  const result = await runAgent({
    model, maxSteps: 4,
    onEvent: async event => { if (event.type === 'model.end') returnedModel = event.model; },
    messages: [{ role: 'system', content: 'Use the provided tool to read the verification value. Never invent the value.' }, { role: 'user', content: 'Call read_verification_file, then reply with its complete value, without additional text.' }],
    tools: [{ name: 'read_verification_file', description: 'Read the actual local verification file. Its value is unknown until this tool executes.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { toolCalls += 1; return { value: await readFile(join(dir, 'proof.txt'), 'utf8') }; } }],
  });
  if (!toolCalls || !result.text.includes(nonce)) throw new Error('未验证真实工具调用与结果回传');
  console.log(JSON.stringify({ verified: true, provider: model.name, model: returnedModel, toolCalls, steps: result.steps, usage: result.usage, elapsedMs: Date.now() - started }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verified: false, error: error.message, code: error.code || null, elapsedMs: Date.now() - started }));
  process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
