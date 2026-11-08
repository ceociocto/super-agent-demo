const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { queued: '排队中', running: '执行中', waiting_input: '等待补充', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' };
const eventLabels = { 'model.start': '请求模型', 'model.end': '收到模型响应', assistant: 'Worker 更新', 'tool.start': '调用工具', 'tool.end': '工具返回', 'job.start': '启动命令', 'job.output': '命令输出', 'job.end': '命令结束', report: '任务报告' };
let state = { tasks: [], conversations: [], metrics: {}, model: {} }, conversationId = localStorage.getItem('assistant.conversation') || '', selectedId = '', selectedTask = null, detailTab = 'activity', connected = false, refreshing = false, toastTimer;
const selectedRuns = new Map(), drafts = new Map(), chatDrafts = new Map();
const fmt = (value, date = false) => { const time = new Date(value); return Number.isNaN(time.valueOf()) ? '' : time.toLocaleString('zh-CN', date ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const badge = status => `<span class="badge ${Object.hasOwn(labels, status) ? status : ''}">${esc(labels[status] || status)}</span>`;
const safeJson = value => JSON.stringify(value, (key, item) => /reasoning|api.?key|authorization/i.test(key) ? undefined : item, 2);
function richText(value) {
  return esc(value).replace(/https?:\/\/[^\s<>]+/g, raw => {
    const url = raw.replace(/[，。；！？、）]+$/, '');
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${raw.slice(url.length)}`;
  });
}
const htmlCache = new WeakMap(), itemCache = new WeakMap();
function setHTML(node, html) {
  if (htmlCache.get(node) === html) return false;
  node.innerHTML = html; htmlCache.set(node, html);
  return true;
}
// Polling must not replace a task button or an existing message just because a
// sibling changed. Stable IDs preserve focus, selected text and expanded logs.
function reconcileChildren(container, entries, fallback = '') {
  if (!entries.length) return setHTML(container, fallback);
  htmlCache.delete(container);
  const previous = new Map([...container.children].map(node => [node.dataset.renderKey, node]));
  const retained = new Set();
  const top = container.scrollTop, left = container.scrollLeft;
  let cursor = container.firstElementChild, changed = false;
  for (const { key, html } of entries) {
    let node = previous.get(String(key));
    if (!node || itemCache.get(node) !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild;
      if (!node || node.tagName !== next.tagName) {
        node = next;
      } else {
        for (const attribute of [...node.attributes]) {
          if (attribute.name !== 'data-render-key' && !next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
        }
        for (const attribute of next.attributes) if (node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
        if (node.innerHTML !== next.innerHTML) {
          const opened = [...node.querySelectorAll('details[open]')].map(detail => detail.dataset.event);
          const focusedEvent = document.activeElement?.closest('details')?.dataset.event;
          node.innerHTML = next.innerHTML;
          node.querySelectorAll('details').forEach(detail => {
            if (opened.includes(detail.dataset.event)) detail.open = true;
            if (focusedEvent && detail.dataset.event === focusedEvent) detail.querySelector('summary')?.focus({ preventScroll: true });
          });
        }
      }
      node.dataset.renderKey = String(key); itemCache.set(node, html); changed = true;
    }
    if (node !== cursor) { container.insertBefore(node, cursor); changed = true; }
    retained.add(node); cursor = node.nextElementSibling;
  }
  for (const node of [...container.children]) if (!retained.has(node)) { node.remove(); changed = true; }
  if (changed) { container.scrollTop = top; container.scrollLeft = left; }
  return changed;
}
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 5000); }
async function api(path, payload) {
  const response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
async function runButton(button, action) { if (button) button.disabled = true; try { await action(); } catch (error) { toast(error.message); } finally { if (button?.isConnected) button.disabled = false; } }
function choosePanel(panel) {
  $('.workspace').dataset.mobilePanel = panel;
  $('.workspace').classList.toggle('show-detail', panel === 'detail');
  $$('.mobile-nav button').forEach(button => button.classList.toggle('selected', button.dataset.panel === panel));
}
function messageHTML(message) {
  const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'system';
  return `<article class="message ${role}"><div class="message-meta"><span>${role === 'user' ? '你' : role === 'assistant' ? '助理' : '任务更新'}</span><time>${fmt(message.createdAt)}</time></div><div class="message-body">${richText(message.text || message.content || '')}</div></article>`;
}
function renderState() {
  const configured = state.model?.configured;
  $('#connection').className = `connection ${connected ? 'online' : 'offline'}`;
  setHTML($('#connection'), `<i></i>${connected ? '本机已连接' : '连接中断'}`);
  $('#environment-button').textContent = state.model?.model || '模型配置';
  const banner = $('#connection-banner');
  banner.hidden = connected && configured;
  banner.textContent = !connected ? '与本机服务的连接已中断，正在尝试重新连接。' : '模型尚未配置：在启动服务前设置 GLM_API_KEY，然后重新启动服务。';
  $('#send-chat').disabled = !connected || !configured;
  $('#worker-count').textContent = `${state.tasks.filter(task => task.status === 'running').length} 个任务运行中`;
  $('#worker-limit').textContent = state.maxWorkers ? `最多 ${state.maxWorkers} 个并发` : '';
  $('#task-count').textContent = state.tasks.length;
  const metrics = state.metrics || {};
  const tokens = Number.isFinite(metrics.totalTokens) ? `${metrics.totalTokens.toLocaleString()} tokens` : '用量未返回';
  $('#usage-line').textContent = metrics.modelCalls ? `${metrics.modelCalls} 次模型调用 · ${tokens}` : '任务进展与执行结果会保留在这里';
  if (!state.conversations.some(item => item.id === conversationId)) conversationId = state.conversations.at(-1)?.id || '';
  if (conversationId) localStorage.setItem('assistant.conversation', conversationId);
  const selector = $('#conversation-select');
  setHTML(selector, state.conversations.length ? state.conversations.map(item => `<option value="${esc(item.id)}">${esc(item.title || '新聊天')}</option>`).join('') : '<option value="">新聊天</option>');
  selector.value = conversationId;
  renderTasks(); renderChat();
}
function renderTasks() {
  const query = $('#task-search').value.toLocaleLowerCase(), filter = $('#task-filter').value;
  const tasks = [...state.tasks].reverse().filter(task => `${task.title} ${task.id} ${task.summary}`.toLocaleLowerCase().includes(query) && (filter === 'all' || (filter === 'active' && ['queued', 'running'].includes(task.status)) || (filter === 'attention' && ['waiting_input', 'failed', 'interrupted'].includes(task.status)) || filter === task.status));
  reconcileChildren($('#task-list'), tasks.map(task => ({ key: task.id, html: `<button class="task-row ${task.id === selectedId ? 'selected' : ''}" data-task-id="${esc(task.id)}"><div class="task-row-top">${badge(task.status)}<time>${fmt(task.updatedAt, true)}</time></div><div class="task-title">${esc(task.title || task.objective)}</div><div class="task-summary">${esc(task.summary || task.objective)}</div></button>` })), `<div class="empty"><span class="empty-icon">◇</span><h2>${state.tasks.length ? '没有匹配的任务' : '还没有任务'}</h2><p>${state.tasks.length ? '换个关键词或筛选条件试试。' : '在总聊天中提出要求，助理会把工作安排到这里。'}</p></div>`);
}
function renderChat() {
  const conversation = state.conversations.find(item => item.id === conversationId);
  $('#router-status').textContent = conversation?.routerStatus === 'running' ? '正在协调任务…' : conversation?.routerStatus === 'failed' ? '协调遇到问题' : '随时可以继续';
  $('#router-error').hidden = !conversation?.error; $('#router-error').textContent = conversation?.error || '';
  const box = $('#chat-messages'), nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const messages = conversation?.messages || [];
  const changed = reconcileChildren(box, messages.map((message, index) => ({ key: `${conversationId}:${message.id || index}`, html: messageHTML(message) })), '<div class="chat-welcome"><div class="empty"><span class="empty-icon">✳</span><h2>一个入口，多件事情。</h2><p>描述你的目标，附上需要使用的仓库或资料路径。助理会安排工作，并在这里带回进展和结果。</p></div></div>');
  if (changed && nearBottom) box.scrollTop = box.scrollHeight;
}
async function selectTask(taskId) {
  if (selectedId) drafts.set(selectedId, $('#followup-text').value);
  selectedId = taskId; selectedTask = null; $('#followup-text').value = drafts.get(taskId) || '';
  renderTasks(); choosePanel('detail');
  try { const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`); if (selectedId === taskId) { selectedTask = task; renderDetail(); } } catch (error) { toast(error.message); }
}
function eventHTML(event, index, runId) {
  const text = event.text || event.message || (event.type === 'tool.start' ? event.name : '') || (event.type === 'model.end' && event.usage ? `模型 ${event.model || ''} · ${event.usage.totalTokens ?? event.usage.total_tokens ?? '—'} tokens` : '') || '';
  const details = event.args !== undefined || event.result !== undefined || event.error !== undefined ? { ...(event.name ? { tool: event.name } : {}), ...(event.args !== undefined ? { arguments: event.args } : {}), ...(event.result !== undefined ? { result: event.result } : {}), ...(event.error !== undefined ? { error: event.error } : {}) } : null;
  return `<div class="event"><div class="event-title"><span>${esc(eventLabels[event.type] || event.type)}${event.name && event.type !== 'tool.start' ? ` · ${esc(event.name)}` : ''}</span><time>${fmt(event.createdAt || event.at)}</time></div>${text ? `<div class="event-content">${esc(text)}</div>` : ''}${details ? `<details data-event="${esc(event.id || `${runId}-${index}`)}"><summary>查看${event.type === 'tool.start' ? '参数' : '实际输出'}</summary><pre>${esc(safeJson(details))}</pre></details>` : ''}</div>`;
}
function renderDetail() {
  const task = selectedTask;
  $('#detail-empty').hidden = Boolean(task); $('#detail-selected').hidden = !task;
  if (!task) return;
  $('#detail-title').textContent = task.title || task.objective; $('#detail-id').textContent = `${task.id} · 版本 ${task.revision || 1}`;
  setHTML($('#detail-status'), badge(task.status)); $('#detail-summary').textContent = task.summary || '';
  let actions = '';
  if (['queued', 'running', 'waiting_input'].includes(task.status)) actions += '<button class="danger" data-action="stop">停止任务</button>';
  if (['failed', 'interrupted'].includes(task.status)) actions += '<button data-action="retry">重试</button>';
  if (task.status === 'stopped') actions += '<button data-action="resume">继续任务</button>';
  setHTML($('#detail-actions'), actions);
  $$('.detail-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.tab === detailTab));
  const runs = task.runs || [], requested = selectedRuns.get(task.id), run = runs.find(item => item.id === requested) || runs.at(-1);
  $('#run-bar').hidden = detailTab !== 'activity' || !runs.length;
  setHTML($('#run-select'), '<option value="latest">最新执行</option>' + [...runs].reverse().map((item, index) => `<option value="${esc(item.id)}">${runs.length - index} · ${esc(item.id)} · ${esc(labels[item.status] || item.status)} · ${fmt(item.startedAt)}</option>`).join(''));
  $('#run-select').value = requested || 'latest';
  let html, entries = null;
  if (detailTab === 'activity') html = run ? `${run.error ? `<div class="inline-error">${esc(run.error)}</div>` : ''}${(run.events || []).map((event, index) => eventHTML(event, index, run.id)).join('') || '<div class="empty"><p>等待执行事件…</p></div>'}` : '<div class="empty"><p>任务尚未开始执行。</p></div>';
  else if (detailTab === 'messages') html = (task.messages || []).map(messageHTML).join('') || '<div class="empty"><p>暂无任务消息。</p></div>';
  else {
    const artifacts = task.artifacts || [], result = typeof task.result === 'string' ? task.result : task.result ? safeJson(task.result) : '';
    html = artifacts.map(artifact => `<a class="artifact" href="/api/tasks/${encodeURIComponent(task.id)}/file?path=${encodeURIComponent(artifact.path)}" download><span>▤ ${esc(artifact.name || artifact.path)}</span><small>下载 ↗</small></a>`).join('') + (result ? `<div class="result-text">${richText(result)}</div>` : '<div class="empty"><p>交付结果会在完成后出现在这里。</p></div>') + `<div class="detail-meta">工作目录<br><span class="mono">${esc(task.workspace || '准备中')}</span>${task.repository ? `<br>仓库<br>${esc(task.repository)}` : ''}</div>`;
  }
  if (detailTab === 'activity' && run) entries = [
    ...(run.error ? [{ key: `${run.id}:error`, html: `<div class="inline-error">${esc(run.error)}</div>` }] : []),
    ...(run.events || []).map((event, index) => ({ key: `${run.id}:${event.id || index}`, html: eventHTML(event, index, run.id) })),
  ];
  if (detailTab === 'messages') entries = (task.messages || []).map((message, index) => ({ key: `${task.id}:${message.id || index}`, html: messageHTML(message) }));
  const content = $('#detail-content'), top = content.scrollTop;
  if (entries?.length) reconcileChildren(content, entries);
  else if (setHTML(content, html)) content.scrollTop = top;
  $('#followup-form button').disabled = !connected || !state.model.configured;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/api/state'); connected = true; renderState();
    if (selectedId) { const id = selectedId, task = await api(`/api/tasks/${encodeURIComponent(id)}`); if (selectedId === id) { selectedTask = task; renderDetail(); } }
  } catch (error) { connected = false; renderState(); }
  finally { refreshing = false; }
}
$('#task-list').onclick = event => { const button = event.target.closest('[data-task-id]'); if (button) selectTask(button.dataset.taskId); };
$('#task-search').oninput = renderTasks; $('#task-filter').onchange = renderTasks;
$('#refresh').onclick = () => refresh();
$$('.mobile-nav button').forEach(button => button.onclick = () => choosePanel(button.dataset.panel));
$('.detail-tabs').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) { detailTab = button.dataset.tab; $('#detail-content').scrollTop = 0; renderDetail(); } };
$('#run-select').onchange = event => { if (event.target.value === 'latest') selectedRuns.delete(selectedId); else selectedRuns.set(selectedId, event.target.value); renderDetail(); };
$('#conversation-select').onchange = event => { chatDrafts.set(conversationId, $('#chat-text').value); conversationId = event.target.value; localStorage.setItem('assistant.conversation', conversationId); $('#chat-text').value = chatDrafts.get(conversationId) || ''; renderChat(); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; };
$('#new-conversation').onclick = event => runButton(event.currentTarget, async () => { chatDrafts.set(conversationId, $('#chat-text').value); const conversation = await api('/api/conversations', {}); conversationId = conversation.id; localStorage.setItem('assistant.conversation', conversationId); $('#chat-text').value = ''; await refresh(); choosePanel('chat'); $('#chat-text').focus(); });
$('#chat-form').onsubmit = event => { event.preventDefault(); runButton($('#send-chat'), async () => { if (!connected) throw new Error('服务尚未连接'); const text = $('#chat-text').value.trim(); if (!text) return; if (!conversationId) { const conversation = await api('/api/conversations', {}); conversationId = conversation.id; localStorage.setItem('assistant.conversation', conversationId); } const target = conversationId; await api(`/api/conversations/${encodeURIComponent(target)}/messages`, { text, requestId: crypto.randomUUID() }); if (conversationId === target && $('#chat-text').value.trim() === text) $('#chat-text').value = ''; chatDrafts.delete(target); await refresh(); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }); };
$('#chat-text').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#send-chat').disabled) $('#chat-form').requestSubmit(); } };
$('#followup-form').onsubmit = event => { event.preventDefault(); runButton(event.submitter, async () => { const taskId = selectedId, text = $('#followup-text').value.trim(); if (!taskId || !text) return; await api(`/api/tasks/${encodeURIComponent(taskId)}/messages`, { text, requestId: crypto.randomUUID() }); drafts.delete(taskId); if (selectedId === taskId && $('#followup-text').value.trim() === text) $('#followup-text').value = ''; await refresh(); toast('补充要求已送到原任务。'); }); };
$('#detail-actions').onclick = event => { const button = event.target.closest('[data-action]'); if (button) runButton(button, async () => { await api(`/api/tasks/${encodeURIComponent(selectedId)}/actions`, { action: button.dataset.action }); await refresh(); }); };
$('#environment-button').onclick = event => runButton(event.currentTarget, async () => {
  $('#environment-dialog').showModal(); $('#environment-content').textContent = '正在检查…';
  try {
    const environment = await api('/api/environment');
    const row = (label, value) => `<div class="environment-row"><span>${label}</span><strong>${esc(value)}</strong></div>`;
    $('#environment-content').innerHTML = row('模型', environment.model?.model || '未配置') + row('凭证', environment.model?.configured ? '已配置（实际响应以执行记录为准）' : '未配置') + row('GitHub', environment.github?.available ? environment.github.login || '可用' : environment.github?.error || '未登录或未安装 gh') + row('运行环境', `${environment.runtime?.platform || ''} · Node ${environment.runtime?.node || ''}`) + (!environment.model?.configured ? '<p class="setup-note">在服务环境中设置 <code>GLM_API_KEY</code>，按需设置 <code>GLM_MODEL</code> 和 <code>GLM_BASE_URL</code>，然后重启服务。</p>' : '');
  } catch (error) { $('#environment-content').textContent = error.message; }
});
$('#close-environment').onclick = () => $('#environment-dialog').close();
$('#environment-dialog').onclick = event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close(); } };
await refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 1500); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
