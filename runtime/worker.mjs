import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { normalizeText as normalized, queryTokens as extractQueryTokens } from './query.mjs';

const startedAt = new Date().toISOString();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const log = text => emit({ type: 'log', text });
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 524288) throw new Error('Task input exceeds 512 KiB');
  chunks.push(chunk);
}
const task = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!['bugfix', 'docs', 'analysis'].includes(task.scenario)) throw new Error('Unsupported workflow');
if (!Array.isArray(task.messages) || !Array.isArray(task.knowledge)) throw new Error('Invalid task data');
const sources = task.knowledge.filter(x => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.content === 'string');
const request = task.messages.filter(x => x.role === 'user').map(x => String(x.text || '')).join('\n');
const latestRequest = task.messages.filter(x => x.role === 'user').at(-1)?.text || request;
const execution = { containerId: os.hostname(), hostname: os.hostname(), platform: `${os.platform()}/${os.arch()}`, startedAt, exitCode: 0 };
log(`执行主机 ${execution.hostname} · ${execution.platform} · Node ${process.version}`);
log(`任务 ${task.id} / 修订 ${task.revision} / ${task.scenario}`);
let artifact;

if (task.scenario === 'bugfix') {
  await mkdir('/work', { recursive: true });
  for (const name of ['order-service.mjs', 'order-service.test.mjs']) {
    await copyFile(`/opt/superagent/fixtures/${name}`, `/work/${name}`);
  }
  function testRun(stage) {
    log(`${stage}：运行 node --test order-service.test.mjs`);
    const result = spawnSync(process.execPath, ['--test', 'order-service.test.mjs'], { cwd: '/work', encoding: 'utf8', timeout: 15000, maxBuffer: 262144, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' } });
    const output = String(result.stdout || '') + String(result.stderr || '');
    for (const line of output.split('\n').filter(Boolean)) log(line);
    if (result.error) throw new Error(`Test subprocess failed: ${result.error.code || 'unknown'}`);
    return { exitCode: result.status, output, passed: Number(output.match(/# pass (\d+)/)?.[1] || 0), failed: Number(output.match(/# fail (\d+)/)?.[1] || 0) };
  }
  const before = testRun('修复前');
  if (before.exitCode === 0 || before.failed !== 1 || before.passed !== 2) throw new Error('Baseline did not reproduce the expected single regression');
  const original = await readFile('/work/order-service.mjs', 'utf8');
  const patched = original.replace('return rows.length ? rows : null;', 'return rows;');
  if (patched === original) throw new Error('Fixture patch precondition failed');
  await writeFile('/work/order-service.mjs', patched);
  log('已修改容器 /work/order-service.mjs；未改动 Mac 或公司仓库。');
  const after = testRun('修复后');
  if (after.exitCode !== 0 || after.passed !== 3 || after.failed !== 0) throw new Error('Patched fixture failed regression tests');
  const diff = '--- a/order-service.mjs\n+++ b/order-service.mjs\n@@ -1,3 +1,3 @@\n export function findOrders(rows) {\n-  return rows.length ? rows : null;\n+  return rows;\n }\n';
  execution.tests = { before, after };
  execution.diff = diff;
  artifact = {
    name: 'fix-review.md', mimeType: 'text/markdown', kind: 'executed_fixture_patch', published: false,
    content: `# 订单查询修复 · Linux 实测\n\n固定演练修复器，非任意 AI 编码。实际在独立容器中复制代码、复现缺陷、修改文件、运行测试。\n\n## 请求上下文\n\n${request}\n\n## 结果\n\n修复前：${before.passed} 通过，${before.failed} 失败，退出码 ${before.exitCode}。\n修复后：${after.passed} 通过，${after.failed} 失败，退出码 ${after.exitCode}。\n\n## 代码差异\n\n\`\`\`diff\n${diff}\`\`\`\n\n## 修复后原始测试输出\n\n\`\`\`text\n${after.output}\`\`\`\n\n## 边界\n\n仅修改隔离容器内的合成订单代码。没有执行用户正文中的命令，没有修改真实仓库，也没有发布。更多需求仅保留为上下文，不会自动变成额外代码变更。\n`,
    citations: [{ id: 'FIXTURE-order-service', title: '容器内订单演练代码与三项测试', content: original, synthetic: true }],
  };
} else {
  log(`已读取本任务传入的 ${sources.length} 项知识资料（不是全盘扫描）。`);
  const queryTokens = extractQueryTokens(task.messages);
  const ranked = sources.map(source => {
    const title = normalized(source.title), content = normalized(source.content);
    const score = queryTokens.reduce((n, word) => n + (title.includes(word) ? 3 : 0) + (content.includes(word) ? 1 : 0), 0);
    return { ...source, score };
  }).sort((a, b) => b.score - a.score);
  const selected = task.scenario === 'docs' ? ranked.filter(x => x.score > 0).slice(0, 5) : ranked.slice(0, 10);
  for (const source of selected) log(`读取 [${source.id}] ${source.title} · 检索匹配分 ${source.score}`);
  let content;
  if (task.scenario === 'docs') {
    const paragraphs = selected.map(source => {
      const lines = source.content.split(/\n+/).filter(x => x.trim());
      const matches = lines.map((line, index) => ({ line, index, score: queryTokens.filter(w => normalized(line).includes(w)).length })).sort((a, b) => b.score - a.score || a.index - b.index);
      const excerpt = matches.slice(0, 3).sort((a, b) => a.index - b.index).map(x => x.line).join('\n').slice(0, 1600);
      return `### [${source.id}] ${source.title}\n\n${excerpt}\n`;
    });
    content = `# 知识检索结果\n\n问题：${latestRequest}\n\n${selected.length ? paragraphs.join('\n') : '证据不足：当前传入资料中未找到与问题匹配的内容。请补充可访问文档或使用更具体的词重新提问。'}\n\n## 方法与边界\n\n在 Linux 容器中执行中文双字片段/英文词匹配，对标题加权并抽取相关原文。结果是证据摘录，不是模型推理；分数不是可信度或事实验证。仅使用本任务收到的资料，未访问其他任务或外部网络。\n`;
  } else {
    content = `# 资料汇总报告\n\n需求：${latestRequest}\n\n${selected.length ? selected.map(source => `## [${source.id}] ${source.title}\n\n${source.content.split(/\n+/).filter(x => x.trim()).slice(0, 12).join('\n').slice(0, 2400)}\n`).join('\n') : '没有可用资料，无法生成有证据的报告。'}\n\n## 方法与边界\n\n本报告由 Linux 容器实际读取传入文档并按匹配程度整理原文，属于规则式摘录汇总，不是模型语义总结；不推断未记载的负责人、完成状态或日期。所有结论应由审阅者核对原始资料。\n`;
  }
  artifact = { name: task.scenario === 'docs' ? 'knowledge-answer.md' : 'engineering-report.md', mimeType: 'text/markdown', kind: 'executed_knowledge_workflow', content, citations: selected.map(({ score, ...source }) => ({ ...source, score })), published: false };
  execution.retrieval = { sourceCount: sources.length, matchedCount: selected.length, queryTokens, algorithm: 'weighted-literal-bigram-v1' };
}
execution.finishedAt = new Date().toISOString();
log('产物已生成，返回控制台等待人工验收。');
emit({ type: 'result', result: { artifact, execution } });
