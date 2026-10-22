// Portable local records. API keys and OAuth credentials are never exported.
import {DEFAULTS, freshDB, validateSettings} from './core.js';
export function exportRecords(settings, db) {
  const safe = Object.fromEntries(Object.keys(DEFAULTS).filter(k => !['apiKey', 'openaiApiKey'].includes(k)).map(k => [k, settings[k]]));
  return {format: 'octo-records', version: 1, exportedAt: new Date().toISOString(), settings: safe, db: structuredClone(db)};
}
export function importRecords(value, currentSettings, currentDB) {
  if (value?.format !== 'octo-records' || value.version !== 1) throw new Error('옥토 기록 백업 파일을 선택해주세요.');
  if (currentDB.queue.length || Object.keys(currentDB.stats).length || Object.keys(currentDB.processed).length || currentDB.archivedCandidates?.length) throw new Error('기록 덮어쓰기를 막기 위해 새 설치의 빈 저장소에서만 복원할 수 있습니다.');
  const source = value.db;
  if (!source || !Array.isArray(source.queue) || !source.stats || typeof source.stats !== 'object' || Array.isArray(source.stats) || !source.processed || typeof source.processed !== 'object') throw new Error('백업의 기록 형식이 올바르지 않습니다.');
  for (const p of [...source.queue, ...(source.archivedCandidates || [])]) if (typeof p?.id !== 'string' || (p.draft != null && typeof p.draft !== 'string')) throw new Error('백업 게시물 형식이 올바르지 않습니다.');
  const allowed = new Set([...Object.keys(freshDB()), 'excludedPosts', 'legacyXAccounting', 'diagnostic']);
  const db = {...freshDB(), ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key)))};
  for (const key of ['xAccountingVersion', 'originalPostsVersion', 'verifiedPostsVersion']) db[key] = source[key];
  const settings = validateSettings({...DEFAULTS, ...value.settings, openaiApiKey: currentSettings.openaiApiKey, apiKey: currentSettings.apiKey});
  return {settings, db};
}
