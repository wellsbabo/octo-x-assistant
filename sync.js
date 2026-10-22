// Only these non-credential settings may enter Chrome Sync.
import {DEFAULTS, cleanKeywords, cleanExcludeKeywords, cleanExcludedAuthors, searchQueries} from './core.js';
export const SHARED_KEYS = ['replyPrompt', 'keywords', 'excludeKeywords', 'excludedAuthors'];
const HEAD = 'octoSharedHead', PART = 'octoSharedPart', MAX_PARTS = 16;
export function sharedSettings(settings) {
  const replyPrompt = String(settings.replyPrompt ?? DEFAULTS.replyPrompt).trim();
  if (!replyPrompt || replyPrompt.length > 10000) throw new Error('댓글 작성 지침은 1~10,000자로 입력해주세요.');
  if (!Array.isArray(settings.keywords)) throw new Error('키워드 목록 형식이 올바르지 않습니다.');
  const keywords = cleanKeywords(settings.keywords);
  if (!keywords.length) throw new Error('키워드가 비어 있습니다.');
  // Payloads from older versions have no exclusions; fall back to the defaults.
  const excludeKeywords = cleanExcludeKeywords(Array.isArray(settings.excludeKeywords) ? settings.excludeKeywords : DEFAULTS.excludeKeywords);
  searchQueries(keywords, excludeKeywords);
  return {replyPrompt, keywords, excludeKeywords, excludedAuthors: cleanExcludedAuthors(settings.excludedAuthors || [])};
}
async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function writeShared(area, settings) {
  const payload = JSON.stringify(sharedSettings(settings));
  const parts = []; let chunk = '';
  // Bound the encoded JSON size (Korean characters and escapes included), not character count.
  for (const char of payload) {
    if (new TextEncoder().encode(JSON.stringify(chunk + char)).length > 6000) { parts.push(chunk); chunk = ''; }
    chunk += char;
  }
  parts.push(chunk);
  if (parts.length > MAX_PARTS) throw new Error('동기화 설정이 너무 큽니다. 키워드나 제외 계정 목록을 줄여주세요.');
  const head = {version: 1, count: parts.length, hash: await digest(payload), at: Date.now()};
  await area.set(Object.fromEntries([[HEAD, head], ...parts.map((value, i) => [PART + i, value])]));
  return head;
}
export async function readShared(area) {
  const data = await area.get([HEAD, ...Array.from({length: MAX_PARTS}, (_, i) => PART + i)]);
  const head = data[HEAD];
  if (!head) return null;
  if (head.version !== 1 || !Number.isInteger(head.count) || head.count < 1 || head.count > MAX_PARTS) throw new Error('동기화 데이터 형식을 확인할 수 없습니다.');
  const parts = Array.from({length: head.count}, (_, i) => data[PART + i]);
  if (parts.some(p => typeof p !== 'string')) throw new Error('동기화 내용을 받는 중입니다. 잠시 후 다시 받아주세요.');
  const payload = parts.join('');
  if (await digest(payload) !== head.hash) throw new Error('동기화 내용을 받는 중이거나 다른 기기 변경과 충돌했습니다. 다시 받거나 이 기기 설정을 보내주세요.');
  return {settings: sharedSettings(JSON.parse(payload)), head};
}
export function isSyncChange(changes) { return Object.keys(changes).some(k => k === HEAD || k.startsWith(PART)); }
