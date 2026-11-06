export const normalizeText = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export function queryTokens(messages) {
  // Keep the original topic when a follow-up only says “expand that”.
  const context = messages.filter(x => x?.role === 'user').map(x => String(x.text || '')).join('\n');
  const words = context.toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]+/gu) || [];
  return [...new Set(words.flatMap(w => /\p{Script=Han}/u.test(w) ? [...w].slice(0, -1).map((_, i) => w.slice(i, i + 2)) : [w]))].filter(w => !['请问', '什么', '哪些', '根据', '进行', '如何', '一个', '我们', '可以', '需要', '说明', '生成', '来源'].includes(w));
}
