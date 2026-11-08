import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Assistant } from '../server/assistant.js';
import { createModel } from '../server/agent/model.js';

// Opt-in live acceptance: no GitHub writes, private source files, or preset answers.
const root = await mkdtemp(join(tmpdir(), 'personal-assistant-live-'));
const model = createModel(); const start = Date.now(); let assistant;
const until = async predicate => {
  while (!predicate()) {
    if (Date.now() - start > 300000) throw new Error('真实助理验证超过5分钟，请查看失败记录');
    await new Promise(r => setTimeout(r, 100));
  }
};
try {
  const alpha = randomBytes(8).toString('hex'), beta = randomBytes(8).toString('hex');
  assistant = new Assistant({ model, dbPath: join(root, 'state.sqlite'), workspaceRoot: join(root, 'work'), maxSteps: 16 });
  const chat = assistant.createConversation(); assistant.start();
  assistant.sendMessage(chat.id, { text: `请创建并同时执行两个独立任务。任务一标题为「Alpha文件」：在自己的工作目录实际运行一个 Node.js 脚本，等待3秒后写入alpha.txt，文件内容必须为 ${alpha}；读回核验后报告完成。任务二标题为「Beta文件」：在自己的工作目录用文件工具写beta.txt，内容必须为 ${beta}；读回核验后报告完成。这两个任务互不依赖，不需要询问。` });
  await until(() => assistant.state().tasks.length >= 2 || assistant.state().conversations[0].routerStatus === 'failed');
  assert.equal(assistant.state().tasks.length, 2, 'Router must create two tasks');
  await until(() => assistant.state().tasks.every(t => !['queued', 'running'].includes(t.status)));
  const tasks = assistant.state().tasks;
  assert.ok(tasks.every(t => t.status === 'completed'), JSON.stringify(tasks.map(t => ({ title: t.title, status: t.status, summary: t.summary }))));
  const a = tasks.find(t => /Alpha/i.test(t.title)), b = tasks.find(t => /Beta/i.test(t.title));
  assert.ok(a && b);
  assert.equal((await readFile(join(a.workspace, 'alpha.txt'), 'utf8')).trim(), alpha);
  assert.equal((await readFile(join(b.workspace, 'beta.txt'), 'utf8')).trim(), beta);
  const arun = assistant.task(a.id).runs[0], brun = assistant.task(b.id).runs[0];
  assert.ok(Date.parse(arun.startedAt) < Date.parse(brun.finishedAt) && Date.parse(brun.startedAt) < Date.parse(arun.finishedAt), 'Workers must overlap');
  assistant.sendMessage(chat.id, { text: '刚才的Alpha文件任务继续：读取原来的alpha.txt，另写followup.txt，内容为原内容加后缀 -continued。不要新建任务；完成后报告。' });
  await until(() => assistant.task(a.id).runs.length >= 2 || assistant.state().conversations[0].routerStatus === 'failed');
  await until(() => !['queued', 'running'].includes(assistant.task(a.id).status));
  assert.equal(assistant.task(a.id).status, 'completed');
  assert.equal(assistant.state().tasks.length, 2, 'Followup must retain Task identity');
  assert.equal((await readFile(join(a.workspace, 'followup.txt'), 'utf8')).trim(), alpha + '-continued');
  const metrics = assistant.state().metrics;
  await assistant.close(); assistant = new Assistant({ model, dbPath: join(root, 'state.sqlite'), workspaceRoot: join(root, 'work') });
  assert.equal(assistant.task(a.id).runs.length, 2);
  assert.equal(assistant.task(a.id).status, 'completed');
  console.log(JSON.stringify({ verified: true, model: model.model, taskCount: 2, overlappingWorkers: true, followupSameTask: true, originalAndFollowupFilesVerified: true, restartPreservesHistory: true, metrics, elapsedMs: Date.now() - start }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verified: false, error: error.message, tasks: assistant?.closed ? [] : assistant?.state().tasks.map(t => ({ title: t.title, status: t.status, summary: t.summary })) }, null, 2));
  process.exitCode = 1;
} finally { if (assistant && !assistant.closed) await assistant.close(); await rm(root, { recursive: true, force: true }); }
