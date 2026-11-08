import { promises as fs, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_READ = 24000;
const MAX_OUTPUT = 16 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inside = (root, file) => { const r = relative(root, file); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const num = (description, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', description, minimum, maximum });

function commandEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:API_KEY|CLIENT_SECRET|ACCESS_KEY|PRIVATE_KEY)$/i.test(key) &&
    !/^(?:GLM|ZAI|ZHIPU|OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|GOOGLE_API|MODEL)_.*(?:KEY|TOKEN|SECRET)/i.test(key)));
}

function privateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) {
    const suffix = value.slice(7);
    if (isIP(suffix) === 4) return privateAddress(suffix);
    const parts = suffix.split(':');
    if (parts.length === 2) {
      const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
      return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return true;
  }
  if (isIP(value) === 6) return value === '::' || value === '::1' || /^(?:fc|fd|fe[89ab]|ff)/.test(value);
  if (isIP(value) !== 4) return true;
  const [a, b] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b));
}

/** Native-user tools, not a security sandbox. Independent workspaces prevent accidental write collisions. */
export function createLocalTools({ workspace, signal, onEvent = async () => {}, artifactDir, commandTimeoutMs = 300000 } = {}) {
  if (!workspace || !isAbsolute(workspace)) throw new Error('workspace must be an absolute directory');
  const root = resolve(workspace);
  const logs = resolve(artifactDir || join(root, '.agent-logs'));
  mkdirSync(root, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const jobs = new Map();
  const eventWrites = new Set();
  let closed = false;
  const emit = event => {
    try {
      const pending = Promise.resolve(onEvent(event)).catch(() => {});
      eventWrites.add(pending); pending.finally(() => eventWrites.delete(pending));
    } catch {}
  };
  const active = () => { if (closed || signal?.aborted) throw new Error('工具执行已停止'); };
  const pathOf = path => resolve(root, path || '.');

  async function writePath(path) {
    if (typeof path !== 'string' || !path) throw new Error('必须提供文件路径');
    const target = pathOf(path), realRoot = await fs.realpath(root);
    if (!inside(root, target)) throw new Error('文件写入必须位于当前任务工作目录');
    let existing = target;
    while (true) {
      try {
        if (!inside(realRoot, await fs.realpath(existing))) throw new Error('文件路径通过符号链接指向任务目录之外');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    await fs.mkdir(dirname(target), { recursive: true });
    return target;
  }

  const groupExists = job => {
    // Once disappearance is confirmed, never signal this numeric ID again: it
    // could subsequently be reused by an unrelated process group.
    if (job.groupSettled || !Number.isSafeInteger(job.pid)) return false;
    try { process.kill(process.platform === 'win32' ? job.pid : -job.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  const signalGroup = (job, sig) => {
    if (!groupExists(job)) return;
    try { process.kill(process.platform === 'win32' ? job.pid : -job.pid, sig); } catch {}
  };
  const terminate = (job, reason) => {
    if (job.status === 'running') job.stopReason = reason;
    if (job.cleanup) return job.cleanup;
    job.cleanup = (async () => {
      signalGroup(job, 'SIGTERM');
      for (let attempt = 0; attempt < 25 && groupExists(job); attempt++) await sleep(20);
      if (groupExists(job)) {
        signalGroup(job, 'SIGKILL');
        for (let attempt = 0; attempt < 25 && groupExists(job); attempt++) await sleep(20);
      }
      job.cleanupPending = groupExists(job);
      job.groupSettled = !job.cleanupPending;
      if (job.cleanupPending) job.error = '所属进程组清理尚未确认，请检查后继续；不能认定后台工作已完成。';
    })();
    return job.cleanup;
  };
  const abort = () => { for (const job of jobs.values()) terminate(job, 'cancelled'); };
  signal?.addEventListener('abort', abort, { once: true });

  async function snapshot(job, offset = 0) {
    const content = await fs.readFile(job.logPath, 'utf8');
    const start = bounded(offset, 0, 0, content.length);
    const output = content.slice(start, start + MAX_READ);
    return { jobId: job.id, status: job.status, exitCode: job.exitCode, signal: job.exitSignal || null,
      stopReason: job.stopReason || null, cleanupPending: Boolean(job.cleanupPending), cwd: job.cwd, output, offset: start, nextOffset: start + output.length,
      totalLength: content.length, hasMore: start + output.length < content.length,
      stdout: job.stdout, stderr: job.stderr, previewTruncated: job.stdoutTruncated || job.stderrTruncated,
      logPath: job.logPath, stdoutPath: job.stdoutPath, stderrPath: job.stderrPath,
      startedAt: job.startedAt, finishedAt: job.finishedAt || null,
      ...(job.error ? { error: job.error } : {}) };
  }

  const definitions = [
    ['list_files', '列出目录中的实际文件，不递归。可以指定明确的绝对资料路径。', schema({ path: str('相对工作目录或绝对目录'), maxEntries: num('最多返回条目', 1, 500) }), async ({ path = '.', maxEntries = 100 }) => {
      const directory = pathOf(path), entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { path: directory, total: entries.length, entries: entries.slice(0, bounded(maxEntries, 100, 1, 500)).map(x => ({ name: x.name, type: x.isDirectory() ? 'directory' : x.isSymbolicLink() ? 'symlink' : 'file' })) };
    }],
    ['read_file', '按字符偏移分页读取 UTF-8 文件或历史日志。输出包括总长度和下一页位置；需要时继续读取，不猜测省略部分。', schema({ path: str('文件路径'), offset: num('字符偏移'), limit: num('最多字符', 1, MAX_READ) }, ['path']), async ({ path, offset = 0, limit = 12000 }) => {
      const file = pathOf(path), stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('路径不是文件');
      if (stat.size > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，请通过命令有针对性地读取');
      const content = await fs.readFile(file, 'utf8');
      const start = bounded(offset, 0, 0, content.length), text = content.slice(start, start + bounded(limit, 12000, 1, MAX_READ));
      return { path: file, content: text, offset: start, nextOffset: start + text.length, totalLength: content.length, hasMore: start + text.length < content.length };
    }],
    ['write_file', '在当前任务工作目录中实际创建或覆盖 UTF-8 文件。', schema({ path: str('任务目录内文件路径'), content: str('完整文件内容') }, ['path', 'content']), async ({ path, content }) => {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('文件内容必须为最多 4 MiB 的文本');
      const file = await writePath(path);
      await fs.writeFile(file, content, 'utf8');
      return { path: file, bytesWritten: Buffer.byteLength(content), written: true };
    }],
    ['edit_file', '在任务目录内文件中精确替换唯一一处文本；未找到或出现多次会拒绝修改。', schema({ path: str('文件路径'), oldText: str('必须唯一匹配的原文'), newText: str('替换文本') }, ['path', 'oldText', 'newText']), async ({ path, oldText, newText }) => {
      if (!oldText || typeof oldText !== 'string' || typeof newText !== 'string') throw new Error('原文不能为空且替换内容必须是文本');
      const file = await writePath(path), content = await fs.readFile(file, 'utf8');
      const first = content.indexOf(oldText);
      if (first < 0 || content.indexOf(oldText, first + 1) >= 0) throw new Error('原文必须在文件中恰好出现一次，未修改文件');
      await fs.writeFile(file, content.slice(0, first) + newText + content.slice(first + oldText.length));
      return { path: file, replacements: 1 };
    }],
    ['run_command', '以当前本机用户执行真实 Shell 命令，可使用 git/gh 等现有工具。长命令直接执行，不要自行加 &：超过等待时间会返回后台 jobId，须 inspect_job 核对结果。Shell退出后遗留的同组子进程会被清理并标记失败。不是容器隔离；取消不会回滚远端操作。', schema({ command: str('要执行的命令'), cwd: str('工作目录，默认当前任务目录'), yieldMs: num('等待首次结果的毫秒数', 0, 5000) }, ['command']), async ({ command, cwd, yieldMs = 1000 }) => {
      if (typeof command !== 'string' || !command.trim() || command.length > 32000) throw new Error('命令必须为 1–32000 字符');
      const directory = pathOf(cwd), stat = await fs.stat(directory);
      if (!stat.isDirectory()) throw new Error('cwd 不是目录');
      active();
      const id = `job_${randomUUID().slice(0, 12)}`;
      const job = { id, status: 'running', exitCode: null, cwd: directory, startedAt: new Date().toISOString(), stdout: '', stderr: '', bytes: 0,
        logPath: join(logs, `${id}.log`), stdoutPath: join(logs, `${id}.stdout.log`), stderrPath: join(logs, `${id}.stderr.log`) };
      for (const file of [job.logPath, job.stdoutPath, job.stderrPath]) writeFileSync(file, '');
      const child = spawn('/bin/sh', ['-c', command], { cwd: directory, env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      Object.assign(job, { child, pid: child.pid });
      jobs.set(id, job);
      emit({ type: 'job.start', jobId: id, command, cwd: directory, logPath: job.logPath });
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const append = (stream, text) => {
        if (!text || job.logError) return;
        try { appendFileSync(job.logPath, text); appendFileSync(job[`${stream}Path`], text); }
        catch (error) {
          job.logError = true; job.error = `日志保存失败（${error.code || 'write_error'}）`;
          terminate(job, 'log_write_failed'); return;
        }
        const available = Math.max(0, 12000 - job[stream].length);
        job[stream] += text.slice(0, available);
        if (text.length > available) job[`${stream}Truncated`] = true;
        emit({ type: 'job.output', jobId: id, stream, text: text.slice(0, 4000), truncated: text.length > 4000, logPath: job.logPath });
      };
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        const remaining = MAX_OUTPUT - job.bytes;
        job.bytes += chunk.length;
        if (remaining > 0) append(stream, decoders[stream].write(chunk.subarray(0, remaining)));
        if (job.bytes > MAX_OUTPUT && job.stopReason !== 'output_limit') terminate(job, 'output_limit');
      });
      job.done = new Promise(resolveDone => {
        child.on('error', error => { job.error = `无法运行命令（${error.code || 'spawn_error'}）`; });
        child.on('exit', () => {
          // close may wait on inherited pipes. Detect orphaned descendants at
          // shell exit, including children which redirected their own output.
          if (groupExists(job)) {
            if (!job.stopReason) job.error = 'Shell 已退出但仍有后台子进程，已请求清理。请直接运行长命令并使用返回的 jobId。';
            void terminate(job, job.stopReason || 'background_descendants');
          } else job.groupSettled = true;
        });
        child.on('close', async (code, exitSignal) => {
          clearTimeout(job.timer);
          for (const stream of ['stdout', 'stderr']) append(stream, decoders[stream].end());
          if (groupExists(job)) await terminate(job, job.stopReason || 'background_descendants');
          else if (job.cleanup) await job.cleanup;
          else job.groupSettled = true;
          job.exitCode = code; job.exitSignal = exitSignal; job.status = job.stopReason === 'cancelled' || job.stopReason === 'stopped' ? 'cancelled' : job.stopReason || job.error || code !== 0 ? 'failed' : 'completed';
          job.finishedAt = new Date().toISOString();
          emit({ type: 'job.end', jobId: id, status: job.status, exitCode: code, stopReason: job.stopReason || null, cleanupPending: Boolean(job.cleanupPending), logPath: job.logPath });
          resolveDone();
        });
      });
      job.timer = setTimeout(() => terminate(job, 'timeout'), bounded(commandTimeoutMs, 300000, 50, 3600000));
      job.timer.unref();
      if (signal?.aborted || closed) terminate(job, 'cancelled');
      await Promise.race([job.done, sleep(bounded(yieldMs, 1000, 0, 5000))]);
      return snapshot(job);
    }],
    ['inspect_job', '读取当前任务后台命令的真实状态和增量日志。offset 来自上次 nextOffset；退出码不为 0 表示命令失败。', schema({ jobId: str('后台命令 ID'), offset: num('日志字符偏移'), waitMs: num('最多等待毫秒数', 0, 1000) }, ['jobId']), async ({ jobId, offset = 0, waitMs = 0 }) => {
      const job = jobs.get(jobId); if (!job) throw new Error('当前任务中没有该后台命令');
      if (job.status === 'running' && waitMs) await Promise.race([job.done, sleep(bounded(waitMs, 0, 0, 1000))]);
      return snapshot(job, offset);
    }],
    ['stop_job', '停止当前任务的后台命令进程组；已经发生的文件或远端操作不会自动回滚。', schema({ jobId: str('后台命令 ID') }, ['jobId']), async ({ jobId }) => {
      const job = jobs.get(jobId); if (!job) throw new Error('当前任务中没有该后台命令');
      terminate(job, 'stopped'); await Promise.race([job.done, sleep(1000)]);
      return snapshot(job);
    }],
    ['fetch_url', '读取公开 HTTP/HTTPS URL 的真实文本（不是搜索引擎）。阻止私网/本机地址，不携带登录凭证；大内容保存为文件供分页读取。', schema({ url: str('公开网页完整 URL') }, ['url']), async ({ url }) => {
      const timeout = AbortSignal.timeout(20000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let current = new URL(url);
      for (let redirects = 0; redirects <= 4; redirects++) {
        active();
        if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) throw new Error('只允许不带凭证的 HTTP/HTTPS 地址');
        const host = current.hostname.replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('不读取本机或私网 URL');
        const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
        if (!addresses.length || addresses.some(x => privateAddress(x.address))) throw new Error('不读取本机或私网 URL');
        // DNS is checked before fetch. This is an accidental-access guard, not a rebinding-proof proxy.
        const response = await fetch(current, { redirect: 'manual', signal: combined, headers: { accept: 'text/html,text/plain,application/json' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (!response.headers.get('location')) throw new Error('重定向缺少目标');
          current = new URL(response.headers.get('location'), current); continue;
        }
        if (!response.ok) { await response.body?.cancel(); return { url: current.href, status: response.status, error: '网页返回非成功状态' }; }
        const type = response.headers.get('content-type') || '';
        if (!/(?:text\/|json|xml|javascript)/i.test(type)) { await response.body?.cancel(); throw new Error('网页不是支持的文本内容'); }
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('网页超过 2 MiB 读取限制'); chunks.push(chunk); }
        const content = Buffer.concat(chunks).toString('utf8'), file = join(logs, `web_${randomUUID().slice(0, 12)}.txt`);
        await fs.writeFile(file, content);
        return { url: current.href, status: response.status, contentType: type, content: content.slice(0, 12000), totalLength: content.length, truncated: content.length > 12000, path: file };
      }
      throw new Error('网页重定向次数超过限制');
    }],
  ];
  const tools = definitions.map(([name, description, parameters, implementation]) => ({ name, description, parameters,
    async execute(args = {}) {
      active();
      try { return await implementation(args); }
      catch (error) {
        if (signal?.aborted || closed) throw new Error('工具执行已停止');
        const message = error.code ? `工具操作失败（${error.code}）` : String(error.message || '工具操作失败').slice(0, 300);
        return { error: message };
      }
    },
  }));
  return { tools, jobs, async close() {
    closed = true; signal?.removeEventListener('abort', abort); abort();
    await Promise.all([...jobs.values()].map(async job => {
      // Include groups whose shell has already exited, not only running jobs.
      await terminate(job, job.stopReason || 'cancelled');
      await Promise.race([job.done, sleep(1500)]);
    }));
    await Promise.allSettled([...eventWrites]);
  } };
}
