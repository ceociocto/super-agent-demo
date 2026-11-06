const $ = selector => document.querySelector(selector);
const layouts = new Set(['cover','flow','columns','metrics','timeline','demo','closing']);
let deck = null;
let current = 0;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
function sourceLabel(source) {
  return source.title || source.url || '项目资料';
}
function sourceNode(source) {
  const title = sourceLabel(source);
  try {
    const url = new URL(source.url);
    if (url.protocol === 'https:') {
      const a = element('a', '', title);
      a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      return a;
    }
  } catch { /* Repository paths are labels until a hosting destination is known. */ }
  return element('span', '', title);
}
function createSlide(slide, index) {
  const layout = layouts.has(slide.layout) ? slide.layout : 'columns';
  const section = element('section', `slide layout-${layout}`);
  section.id = `slide-${index + 1}`;
  section.setAttribute('aria-label', `第 ${index + 1} 页：${slide.title}`);
  section.setAttribute('role', 'group');
  section.setAttribute('aria-roledescription', '幻灯片');
  const top = element('div', 'slide-topline');
  top.append(element('span','slide-kicker',slide.kicker || 'Superagent'),element('span','slide-index',`${String(index + 1).padStart(2,'0')} / ${String(deck.slides.length).padStart(2,'0')}`));
  section.append(top,element('h1','',slide.title));
  if (slide.summary) section.append(element('p','slide-summary',slide.summary));
  const items = Array.isArray(slide.items) ? slide.items : [];
  section.style.setProperty('--item-count', Math.max(items.length, 1));
  section.dataset.count = items.length;
  const list = element('div', 'slide-items');
  items.forEach((item, i) => {
    const part = element('div', 'slide-item');
    part.append(element('span','item-number',String(i + 1).padStart(2,'0')),element('h2','item-title',item.title),element('p','item-body',item.body || ''));
    list.append(part);
  });
  section.append(list);
  const footer = element('div', 'slide-footer');
  const sources = (slide.sources || []).map(sourceLabel).join(' / ');
  footer.append(element('span','',sources ? `依据：${sources}` : 'Superagent 内部技术分享'),element('span','','技术分享 · 2026.11'));
  section.append(footer);
  return section;
}
function hashIndex() {
  const match = location.hash.match(/^#(?:slide-)?(\d+)$/);
  return match ? Math.min(deck.slides.length - 1, Math.max(0, Number(match[1]) - 1)) : 0;
}
function go(index, updateHash = true) {
  if (!deck) return;
  current = Math.min(deck.slides.length - 1, Math.max(0, index));
  const slide = deck.slides[current];
  document.querySelectorAll('.slide').forEach((node, i) => {
    node.classList.toggle('active', i === current);
    node.setAttribute('aria-hidden', String(i !== current));
  });
  $('#slide-counter').textContent = `${current + 1} / ${deck.slides.length}`;
  $('#previous-slide').disabled = current === 0;
  $('#next-slide').disabled = current === deck.slides.length - 1;
  $('#progress').setAttribute('aria-valuemax', deck.slides.length);
  $('#progress').setAttribute('aria-valuenow', current + 1);
  $('#progress span').style.width = `${(current + 1) / deck.slides.length * 100}%`;
  $('#notes-title').textContent = `${String(current + 1).padStart(2,'0')}  ${slide.title}`;
  $('#notes-text').textContent = slide.notes || '本页暂无讲稿。';
  const seconds = Number(slide.seconds);
  $('#slide-time').textContent = Number.isFinite(seconds) && seconds > 0 ? `建议时长 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : '';
  $('#sources-list').replaceChildren(...(slide.sources || []).map(source => {
    const item = element('li'); item.append(sourceNode(source)); return item;
  }));
  document.querySelectorAll('[data-slide-index]').forEach(button => {
    if (Number(button.dataset.slideIndex) === current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  document.title = `${current + 1}. ${slide.title} · Superagent`;
  if (updateHash) history.replaceState(null,'',`#slide-${current + 1}`);
  $('#announcement').textContent = `第 ${current + 1} 页，共 ${deck.slides.length} 页。${slide.title}`;
}
function toggleNotes() {
  const show = $('#speaker-notes').hidden;
  $('#speaker-notes').hidden = !show;
  $('#notes-button').setAttribute('aria-pressed', String(show));
}
$('#previous-slide').addEventListener('click', () => go(current - 1));
$('#next-slide').addEventListener('click', () => go(current + 1));
$('#notes-button').addEventListener('click', toggleNotes);
$('#outline-button').addEventListener('click', () => $('#outline-dialog').showModal());
$('#close-outline').addEventListener('click', () => $('#outline-dialog').close());
$('#print-button').addEventListener('click', () => window.print());
$('#fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { $('#announcement').textContent = '浏览器未允许全屏，可使用浏览器的全屏菜单。'; }
});
document.addEventListener('fullscreenchange', () => {
  $('#fullscreen-button').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});
window.addEventListener('hashchange', () => { if (deck) go(hashIndex(), false); });
document.addEventListener('keydown', event => {
  if (!deck || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || $('#outline-dialog').open) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
  if (event.key === ' ' && target instanceof Element && target.closest('button, a')) return;
  if (['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)) { event.preventDefault(); go(current + 1); }
  else if (['ArrowLeft','ArrowUp','PageUp'].includes(event.key)) { event.preventDefault(); go(current - 1); }
  else if (event.key === 'Home') { event.preventDefault(); go(0); }
  else if (event.key === 'End') { event.preventDefault(); go(deck.slides.length - 1); }
  else if (event.key.toLowerCase() === 'n') { event.preventDefault(); toggleNotes(); }
});
try {
  const response = await fetch('./slides.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  deck = await response.json();
  if (!Array.isArray(deck.slides) || !deck.slides.length) throw new Error('没有可用幻灯片');
  $('#deck').replaceChildren(...deck.slides.map(createSlide));
  $('#outline-title').textContent = deck.title || '内部技术分享';
  deck.slides.forEach((slide, index) => {
    const li = element('li');
    const button = element('button'); button.type = 'button'; button.dataset.slideIndex = index;
    button.append(element('span','outline-index',String(index + 1).padStart(2,'0')),element('span','',slide.title));
    button.addEventListener('click', () => { go(index); $('#outline-dialog').close(); });
    li.append(button); $('#outline-list').append(li);
  });
  go(hashIndex());
} catch (error) {
  const message = element('div','loading');
  message.append(element('h1','','分享资料尚未载入'));
  message.append(element('p','',location.protocol === 'file:' ? '请在项目目录运行 npm start，再打开 http://127.0.0.1:4317/share/index.html。浏览器直接打开本地 HTML 时会限制读取资料。' : '请确认 slides.json 已生成，并刷新页面重试。'));
  message.append(element('p','',`详情：${error.message}`));
  $('#deck').replaceChildren(message);
  for (const selector of ['#previous-slide','#next-slide','#notes-button','#outline-button','#print-button']) $(selector).disabled = true;
}
