import test from 'node:test';
import assert from 'node:assert/strict';
import {readShared, writeShared} from '../sync.js';
import {DEFAULTS, freshDB, ingest, migrateVerifiedPosts, aggregate, localDay} from '../core.js';
import {exportRecords, importRecords} from '../backup.js';
const area = () => {
  const data = {};
  return {data, get: async keys => Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])),
    set: async patch => {for (const [key, value] of Object.entries(patch)) assert.ok(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) <= 8192);
      Object.assign(data, structuredClone(patch)); assert.ok(Buffer.byteLength(JSON.stringify(data)) < 102400);}};
};
test('Chrome Sync contains exactly three allowed fields, never credentials, model, queue or statistics', async () => {
  const a = area();
  await writeShared(a, {...DEFAULTS, apiKey: 'private-xai', openaiApiKey: 'private-openai', clientId: 'private-client', model: 'gpt-other', auth: 'private-token'});
  const record = await readShared(a);
  assert.deepEqual(Object.keys(record.settings).sort(), ['excludeKeywords', 'excludedAuthors', 'keywords', 'replyPrompt']);
  assert.ok(!JSON.stringify(a.data).includes('private-')); assert.ok(!JSON.stringify(a.data).includes('gpt-other'));
});
test('long Korean instructions round trip under per-item quota; truncated or mixed sync snapshots never apply', async () => {
  const a = area(); await writeShared(a, {...DEFAULTS, replyPrompt: '가'.repeat(10000)});
  assert.equal((await readShared(a)).settings.replyPrompt.length, 10000);
  a.data.octoSharedPart0 = 'broken'; await assert.rejects(() => readShared(a), /동기화/);
  delete a.data.octoSharedPart0; await assert.rejects(() => readShared(a), /받는 중/);
});
test('unknown/nonverified authors are rejected, all verification types allowed, and billing still counts responses', () => {
  const db = freshDB();
  const data = Array.from({length: 6}, (_, i) => ({id: String(i + 1), author_id: String(i + 1), lang: 'ko', text: 'AI 원글'}));
  const users = [{id: '1', verified: true}, {id: '2', verified_type: 'blue'}, {id: '3', verified_type: 'business'},
    {id: '4', verified_type: 'government'}, {id: '5', verified: false}];
  assert.equal(ingest(db, {data, includes: {users}}, 'timeline', DEFAULTS, '99'), 4);
  assert.deepEqual(db.queue.map(p => p.id), ['1', '2', '3', '4']); assert.ok(db.queue.every(p => p.authorVerified));
  assert.equal(aggregate(db, localDay()).postUnits, 6);
});
test('verified-only upgrade backs up old unverified queues once without touching stats or edited drafts', () => {
  const db = freshDB(); delete db.verifiedPostsVersion;
  db.queue = [{id: '1', draft: '직접 수정'}, {id: '2', authorVerified: true}];
  db.stats = {'2026-10-17': {reviewed: 4}};
  assert.equal(migrateVerifiedPosts(db), true); assert.deepEqual(db.queue.map(p => p.id), ['2']);
  assert.equal(db.archivedCandidates[0].draft, '직접 수정'); assert.equal(db.stats['2026-10-17'].reviewed, 4);
  assert.equal(migrateVerifiedPosts(db), false);
});
test('portable records omit secrets and restore into empty storage without replacing this device keys', () => {
  const db = freshDB(); db.queue = [{id: '1', draft: '보존'}]; db.stats = {'2026-10-17': {reviewed: 4}};
  const backup = exportRecords({...DEFAULTS, openaiApiKey: 'old-openai', apiKey: 'old-xai', unknownSecret: 'never'}, db);
  assert.ok(!JSON.stringify(backup).includes('old-openai')); assert.ok(!JSON.stringify(backup).includes('unknownSecret'));
  const restored = importRecords(backup, {...DEFAULTS, openaiApiKey: 'device-key'}, freshDB());
  assert.equal(restored.settings.openaiApiKey, 'device-key'); assert.equal(restored.db.queue[0].draft, '보존');
  assert.throws(() => importRecords(backup, DEFAULTS, db), /空|빈 저장소/);
});
