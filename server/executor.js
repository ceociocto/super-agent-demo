import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const EXECUTOR_CONTEXT = 'colima-superagent-demo';
export const EXECUTOR_IMAGE = 'superagent-worker:local';
export const containerNameForRun = runId => `sa-demo-${createHash('sha256').update(String(runId)).digest('hex').slice(0, 20)}`;
const knownScenarios = new Set(['bugfix', 'docs', 'analysis']);
function executorError(message, code = 'EXECUTOR_ERROR') { const e = new Error(message); e.code = code; return e; }

export function dockerRunArgs({ context = EXECUTOR_CONTEXT, image = EXECUTOR_IMAGE, runId }) {
  return ['--context', context, 'run', '--rm', '--pull', 'never', '--interactive', '--name', containerNameForRun(runId),
    '--label', 'superagent.demo=true', '--label', `superagent.run=${createHash('sha256').update(String(runId)).digest('hex')}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--user', '1000:1000',
    '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700', image];
}

export class ColimaExecutor {
  constructor({ context = EXECUTOR_CONTEXT, image = EXECUTOR_IMAGE, spawnImpl = spawn, timeoutMs = 60000, maxOutputBytes = 1048576 } = {}) {
    if (!/^[A-Za-z0-9_.-]+$/.test(context) || !/^[A-Za-z0-9_./:@-]+$/.test(image)) throw new Error('Invalid executor configuration');
    this.context = context; this.image = image; this.spawnImpl = spawnImpl; this.timeoutMs = timeoutMs; this.maxOutputBytes = maxOutputBytes;
  }
  async command(args, { timeoutMs = 8000, maxBytes = 65536 } = {}) {
    return new Promise((resolve, reject) => {
      let child, output = '', errorOutput = '', length = 0, finished = false;
      const settle = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child?.kill('SIGKILL'); settle(executorError('执行主机响应超时', 'EXECUTOR_TIMEOUT')); }, timeoutMs);
      try { child = this.spawnImpl('docker', ['--context', this.context, ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
      catch { settle(Object.assign(executorError('无法运行 Docker 客户端', 'EXECUTOR_UNAVAILABLE'), { requestNotSent: true })); return; }
      const collect = (stream, chunk) => {
        length += Buffer.byteLength(chunk);
        if (length > maxBytes) { child.kill('SIGKILL'); settle(executorError('执行主机输出超过限制', 'EXECUTOR_OUTPUT_LIMIT')); return; }
        if (stream === 'out') output += chunk.toString(); else errorOutput += chunk.toString();
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', c => collect('out', c)); child.stderr.on('data', c => collect('err', c));
      child.on('error', error => settle(Object.assign(executorError('Docker 客户端或指定执行主机不可用', 'EXECUTOR_UNAVAILABLE'), { requestNotSent: ['ENOENT', 'EACCES'].includes(error.code) })));
      child.on('close', code => code === 0 ? settle(null, output.trim()) : settle(executorError(`Docker 操作失败（退出码 ${code}）：${errorOutput.trim().slice(0, 500)}`, 'EXECUTOR_UNAVAILABLE')));
    });
  }
  async status() {
    const base = { available: false, context: this.context, image: this.image, os: null };
    try {
      const raw = await this.command(['info', '--format', '{{json .}}']);
      const info = JSON.parse(raw);
      const imageId = await this.command(['image', 'inspect', this.image, '--format', '{{.Id}}']);
      if (info.OSType !== 'linux') return { ...base, error: '目标执行主机不是 Linux' };
      return { ...base, available: true, os: info.OSType, hostname: info.Name, serverVersion: info.ServerVersion, imageId };
    } catch (error) { return { ...base, error: error.message }; }
  }
  async cleanup(runId) {
    if (typeof runId !== 'string' || !runId || runId.length > 200) throw executorError('无效执行 ID', 'EXECUTOR_INPUT');
    const name = containerNameForRun(runId);
    let label;
    try { label = await this.command(['inspect', '--format', '{{index .Config.Labels "superagent.demo"}}', name], { timeoutMs: 4000 }); }
    catch (error) { if (/no such (object|container)/i.test(error.message)) return { removed: false, name }; throw error; }
    if (label !== 'true') throw executorError('拒绝清理非本项目容器', 'EXECUTOR_SCOPE');
    await this.command(['rm', '--force', name], { timeoutMs: 5000 });
    return { removed: true, name };
  }
  async run({ id, runId = randomUUID(), revision, scenario, messages = [], knowledge = [], signal, onLog = () => {}, onStart = () => {} }) {
    if (!knownScenarios.has(scenario) || typeof id !== 'string' || id.length > 200 || typeof runId !== 'string' || !runId || runId.length > 200 || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(messages) || !Array.isArray(knowledge)) throw executorError('无效执行任务', 'EXECUTOR_INPUT');
    if (signal?.aborted) throw Object.assign(executorError('执行已取消', 'ABORTED'), { cleanupPending: false });
    const input = JSON.stringify({ id, runId, revision, scenario, messages, knowledge });
    if (Buffer.byteLength(input) > 524288) throw executorError('任务上下文超过 512 KiB，请减少资料', 'EXECUTOR_INPUT');
    const containerName = containerNameForRun(runId);
    const safeLog = text => { try { onLog(String(text)); } catch { /* Observers do not control execution. */ } };
    const markCleanup = async (error, uncertainCreation = false) => {
      error.creationUncertain = uncertainCreation;
      try {
        const cleaned = await this.cleanup(runId);
        error.cleanupPending = uncertainCreation && !cleaned.removed;
        error.creationUncertain = uncertainCreation && !cleaned.removed;
        if (error.creationUncertain) error.cleanupError = '创建请求结果不明；需待执行主机恢复后重新核对该 runId，不能重派。';
      } catch (cleanupError) {
        error.cleanupPending = true;
        error.cleanupError = cleanupError.message;
      }
      error.containerName = containerName;
      return error;
    };
    // Create and start are separate: a cancellation during create waits for its
    // completion, never starts it, and removes the known object afterwards.
    // A timed-out/failed create has an uncertain daemon outcome and is fenced
    // for recovery, even when an immediate inspect finds no object yet.
    const begin = Date.now();
    let containerId;
    safeLog(`准备 ${this.context} / ${containerName}；无网络、无宿主目录挂载。`);
    try {
      const args = dockerRunArgs({ context: this.context, image: this.image, runId }).slice(2).filter(arg => arg !== '--rm');
      args[0] = 'create';
      containerId = await this.command(args, { timeoutMs: Math.min(this.timeoutMs, 10000) });
    } catch (error) {
      // These failures happen before a create request can create an object.
      // Do not treat a disconnected daemon or generic transport failure as one.
      const notCreated = error.requestNotSent === true || /(?:context[^\n]*(?:not found|does not exist)|no such image|unable to find image)/i.test(error.message);
      if (signal?.aborted) error = executorError(notCreated ? '执行已取消；创建请求未完成派发' : '执行已取消，但创建请求结果需要恢复核对', 'ABORTED');
      if (notCreated) throw Object.assign(error, { cleanupPending: false, creationUncertain: false, containerName });
      throw await markCleanup(error, true);
    }
    try { onStart({ containerId, name: containerName, runId }); } catch { /* Preserve execution semantics. */ }
    if (signal?.aborted) throw await markCleanup(executorError('执行已取消；未启动容器', 'ABORTED'));
    const remaining = this.timeoutMs - (Date.now() - begin);
    if (remaining <= 0) throw await markCleanup(executorError('执行准备超过时间限制；未启动容器', 'EXECUTOR_TIMEOUT'));
    return new Promise((resolve, reject) => {
      let child, buffer = '', result = null, stderr = '', outputBytes = 0, settled = false, finishing = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const finish = async (error, value) => {
        if (finishing || settled) return;
        finishing = true;
        clearTimeout(timer);
        if (error) child?.kill('SIGTERM');
        const cleanup = await markCleanup(error || executorError('产物已生成，但容器清理未确认', 'EXECUTOR_CLEANUP'));
        if (error) child?.kill('SIGKILL');
        if (error || cleanup.cleanupPending) { done(cleanup); return; }
        if (signal?.aborted) { done(Object.assign(executorError('执行已取消，容器已清理', 'ABORTED'), { cleanupPending: false, containerName })); return; }
        done(null, value);
      };
      const abort = () => { void finish(executorError('执行已取消，正在核对容器清理', 'ABORTED')); };
      const timer = setTimeout(() => { void finish(executorError('执行超过时间限制，正在核对容器清理', 'EXECUTOR_TIMEOUT')); }, remaining);
      const consume = line => {
        if (!line.trim() || finishing || settled) return;
        let item;
        try { item = JSON.parse(line); } catch { void finish(executorError('执行器返回了无效日志协议', 'EXECUTOR_PROTOCOL')); return; }
        if (item.type === 'log' && typeof item.text === 'string') safeLog(item.text.slice(0, 12000));
        else if (item.type === 'result' && !result && item.result?.artifact && item.result?.execution) result = item.result;
        else void finish(executorError('执行器返回了未知或重复结果', 'EXECUTOR_PROTOCOL'));
      };
      try { child = this.spawnImpl('docker', ['--context', this.context, 'start', '--attach', '--interactive', containerName], { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
      catch { void finish(executorError('无法启动 Docker 客户端', 'EXECUTOR_UNAVAILABLE')); return; }
      signal?.addEventListener('abort', abort, { once: true });
      safeLog(`启动已创建容器 ${containerName}`);
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > this.maxOutputBytes) { void finish(executorError('执行日志或产物超过输出限制', 'EXECUTOR_OUTPUT_LIMIT')); return; }
        buffer += stdoutDecoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); consume(line); }
      });
      child.stderr.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > this.maxOutputBytes) { void finish(executorError('执行日志超过输出限制', 'EXECUTOR_OUTPUT_LIMIT')); return; }
        const text = stderrDecoder.write(chunk);
        stderr += text; if (text) safeLog(text.slice(0, 2000));
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { void finish(executorError('Docker 客户端或执行主机不可用', 'EXECUTOR_UNAVAILABLE')); });
      child.on('close', code => {
        if (finishing || settled) return;
        buffer += stdoutDecoder.end(); stderr += stderrDecoder.end();
        if (buffer.trim()) consume(buffer);
        if (finishing || settled) return;
        if (code !== 0) { void finish(executorError(`容器执行失败（退出码 ${code}）：${stderr.trim().slice(0, 600) || '请查看任务日志'}`, 'EXECUTOR_FAILED')); return; }
        if (!result || typeof result.artifact.content !== 'string' || result.execution.platform?.startsWith('linux/') !== true) { void finish(executorError('执行结束但没有有效 Linux 产物', 'EXECUTOR_PROTOCOL')); return; }
        void finish(null, { ...result, execution: { ...result.execution, containerId, containerName, context: this.context, image: this.image, runId, exitCode: code, cleanupPending: false } });
      });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
}
