import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, freshDB, localDay, utcDay, cleanKeywords, matches, searchQueries, ingest,
  recordReads, recordGeneration, aggregate, markReviewed, validateSettings, parseDraft, safeErrorInfo, migrateXAccounting, setXBaseline, isReply, migrateOriginalPosts, unavailablePost, cleanExcludedAuthors, cleanExcludeKeywords, clearQueue} from '../core.js';

test('Korean filter, case folding, full-width text, and keyword deduplication', () => {
  assert.equal(matches({lang: 'ko', text: 'ＣｈａｔＧＰＴ 자동화'}, ['chatgpt']), true);
  assert.equal(matches({lang: 'en', text: 'AI'}, ['AI']), false);
  assert.equal(matches({lang: 'ko', text: '다른 이야기'}, ['AI']), false);
  assert.deepEqual(cleanKeywords(['AI', ' ai ', '', '자동화']), ['ai', '자동화']);
});
test('queries split without truncating keywords or admitting raw search operators', () => {
  const keywords = Array.from({length: 100}, (_, i) => '자동화' + i);
  const queries = searchQueries(keywords);
  assert.ok(queries.length > 1);
  assert.ok(queries.every(q => q.length <= 500 && q.endsWith('lang:ko -is:retweet -is:reply is:verified')));
  assert.ok(queries.join(' ').includes('자동화99'));
  assert.ok(searchQueries(['hello" OR from:abc'])[0].startsWith('("hello  OR from:abc")'));
});
test('exclude keywords: quoted negation, whitelisted operators, and local filtering', () => {
  assert.deepEqual(cleanExcludeKeywords(['-주식', ' 코인 ', 'HAS:CASHTAGS', '', '주식']), ['주식', '코인', 'has:cashtags']);
  const [q] = searchQueries(['AI'], ['주식', 'has:cashtags', 'from:abc']);
  assert.equal(q, '("AI") lang:ko -is:retweet -is:reply is:verified -"주식" -has:cashtags -"from:abc"');
  const queries = searchQueries(Array.from({length: 100}, (_, i) => '자동화' + i), DEFAULTS.excludeKeywords);
  assert.ok(queries.every(q => q.length <= 500 && q.endsWith('-"에어드랍" -has:cashtags')));
  assert.throws(() => searchQueries(['AI'], Array.from({length: 60}, (_, i) => '제외어' + i)), /제외 키워드/);
  const ex = DEFAULTS.excludeKeywords;
  assert.equal(matches({lang: 'ko', text: 'AI 관련 주식 추천'}, ['AI'], ex), false);
  assert.equal(matches({lang: 'ko', text: 'AI 랠리 $NVDA 간다'}, ['AI'], ex), false);
  assert.equal(matches({lang: 'ko', text: 'AI 구독료 $20 아끼는 법'}, ['AI'], ex), true);
  assert.equal(matches({lang: 'ko', text: 'AI 자동화 꿀팁'}, ['AI'], ex), true);
  assert.equal(validateSettings({}).excludeKeywords.length, ex.length);
});
test('ingestion counts pre-filter reads, authors, long text, and queue/processed deduplication', () => {
  const db = freshDB();
  const response = {data: [
    {id: '1', author_id: '2', lang: 'ko', text: 'AI 도구'},
    {id: '2', author_id: '2', lang: 'en', text: 'AI'},
    {id: '3', author_id: '9', lang: 'ko', text: 'AI 나의 글'},
    {id: '4', author_id: '2', lang: 'ko', text: '짧음', note_post: {text: '긴 본문 AI 도구'}}
  ], includes: {users: [{id: '2', name: '민', username: 'min', verified: true}]}};
  assert.equal(ingest(db, response, 'search', DEFAULTS, '9'), 2);
  assert.equal(db.queue[1].text, '긴 본문 AI 도구');
  assert.equal(ingest(db, response, 'timeline', DEFAULTS, '9'), 0);
  assert.equal(aggregate(db, localDay()).read, 8);
  assert.equal(aggregate(db, localDay()).postUnits, 4);
  assert.equal(aggregate(db, localDay()).userUnits, 0);
  assert.equal(db.queue[0].name, '민');
  markReviewed(db);
  assert.equal(ingest(db, response, 'search', DEFAULTS, '9'), 0);
  assert.equal(aggregate(db, localDay()).reviewed, 1);
});
test('UTC billing dedup crosses Korean midnight; UTC midnight bills again', () => {
  const db = freshDB(), p = [{id: '1'}], u = [{id: '2'}];
  const t1 = Date.parse('2026-10-17T14:59:00Z'), t2 = Date.parse('2026-10-17T15:01:00Z'), t3 = Date.parse('2026-10-18T00:01:00Z');
  assert.notEqual(localDay(t1), localDay(t2)); assert.equal(utcDay(t1), utcDay(t2));
  recordReads(db, p, u, DEFAULTS, t1); recordReads(db, p, u, DEFAULTS, t2);
  assert.equal(aggregate(db, '2026-10').postUnits, 1);
  recordReads(db, p, u, DEFAULTS, t3);
  assert.equal(aggregate(db, '2026-10').postUnits, 2);
  assert.ok(Math.abs(aggregate(db, '2026-10').xCost - .03) < 1e-12);
});
test('Grok token cost records usage even across months', () => {
  const db = freshDB(); recordGeneration(db, {input_tokens: 1000, output_tokens: 100}, {...DEFAULTS, provider: 'xai', inputRate: 2, outputRate: 6}, Date.parse('2026-09-30T16:00:00Z'));
  assert.equal(aggregate(db, '2026-10').grokCost, .0026);
  assert.equal(aggregate(db, '2026-09').generations, 0);
});
test('OpenAI token billing splits normal input, cached input and cache writes; old Grok history survives', () => {
  const db = freshDB(), now = Date.parse('2026-10-17T01:00:00Z');
  db.stats['2026-10-17'] = {grokCost: .25, generations: 1, inputTokens: 0, outputTokens: 0};
  recordGeneration(db, {input_tokens: 1000, output_tokens: 200,
    input_tokens_details: {cached_tokens: 400, cache_write_tokens: 100}}, DEFAULTS, now);
  const stat = aggregate(db, '2026-10');
  assert.ok(Math.abs(stat.openaiCost - .0001665) < 1e-12);
  assert.equal(stat.grokCost, .25); assert.equal(stat.generations, 2);
  assert.ok(Math.abs(stat.aiCost - .2501665) < 1e-12);
});
test('settings reject accidental model/provider mismatches', () => {
  assert.throws(() => validateSettings({...DEFAULTS, provider: 'openai', model: 'grok-4.3'}));
  assert.throws(() => validateSettings({...DEFAULTS, provider: 'xai', model: 'gpt-6-luna'}));
  assert.throws(() => validateSettings({...DEFAULTS, provider: 'unknown'}));
});
test('settings reject invalid models, rates, sizes, and empty keyword lists', () => {
  for (const value of [{model: '../bad'}, {postRate: -1}, {inputRate: NaN}, {batchSize: 1}, {batchSize: 25.5}, {keywords: []}]) {
    assert.throws(() => validateSettings({...DEFAULTS, ...value}));
  }
  assert.equal(validateSettings({...DEFAULTS, apiKey: ' key '}).apiKey, 'key');
});
test('structured draft rejects incomplete, refused, malformed, or empty responses', () => {
  const response = value => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: value}]}]});
  assert.deepEqual(parseDraft(response('{"summary":"요약","reply":"댓글"}')), {summary: '요약', draft: '댓글'});
  for (const data of [{status: 'incomplete'}, response('bad'), response('{"summary":"","reply":"test"}'), {output: []}]) assert.throws(() => parseDraft(data));
});
test('error diagnostics accept known header/title/codes and redact all remote free text', () => {
  assert.deepEqual(safeErrorInfo({title: 'Unauthorized', detail: 'secret-token', code: 32}, 'Bearer error="invalid_token", error_description="secret-token"'),
    {title: 'Unauthorized', reason: 'invalid_token', code: 32});
  assert.deepEqual(safeErrorInfo({title: 'secret-token', error: 'secret-token', errors: [null, {code: 'secret-token'}]}),
    {title: '', reason: '', code: null});
  assert.deepEqual(safeErrorInfo(null), {title: '', reason: '', code: null});
});
test('regression: 25 expanded authors are not added as 25 independent paid user lookups', () => {
  const db = freshDB(), time = Date.parse('2026-10-17T01:00:00Z');
  const response = {data: Array.from({length: 25}, (_, i) => ({id: String(100 + i), author_id: String(200 + i), lang: 'ko', text: 'AI'})),
    includes: {users: Array.from({length: 25}, (_, i) => ({id: String(200 + i), name: '작성자' + i, verified: true}))}};
  ingest(db, response, 'search', DEFAULTS, '99', time);
  assert.ok(Math.abs(aggregate(db, '2026-10').xCost - .125) < 1e-12);
  assert.equal(aggregate(db, '2026-10').userUnits, 0);
  recordReads(db, [], [{id: '99'}], DEFAULTS, time, {endpoint: '/2/users/me'});
  recordGeneration(db, {input_tokens: 1000, output_tokens: 200}, DEFAULTS, time);
  const totals = aggregate(db, '2026-10');
  assert.ok(Math.abs(totals.xCost + totals.aiCost - .1352) < 1e-12);
  assert.equal(db.costLedger[0].expandedUsers, 25); assert.equal(db.costLedger[0].users, 0);
});
test('one small model request costs token fractions, never a whole million-token price', () => {
  const db = freshDB(); recordGeneration(db, {input_tokens: 1, output_tokens: 2}, DEFAULTS);
  assert.ok(Math.abs(aggregate(db, localDay()).openaiCost - .0000011) < 1e-15);
});
test('legacy X totals are quarantined with an exact backup, without inventing historical lookup counts', () => {
  const db = freshDB(); delete db.xAccountingVersion;
  db.queue = [{id: '1', draft: '수정한 댓글'}]; db.processed = {'2': '2026-10-17'};
  db.stats['2026-10-17'] = {read: 25, postUnits: 25, userUnits: 25, xCost: .375, openaiCost: .0002};
  db.billable = {day: '2026-10-17', posts: ['1'], users: ['9', '10']};
  const old = structuredClone(db.stats);
  assert.equal(migrateXAccounting(db), true);
  assert.deepEqual(db.legacyXAccounting.stats, old);
  assert.equal(db.queue[0].draft, '수정한 댓글'); assert.equal(db.processed['2'], '2026-10-17');
  assert.equal(aggregate(db, '2026-10').unverifiedXEstimate, .375);
  assert.equal(aggregate(db, '2026-10').aiCost, .0002);
  assert.equal(aggregate(db, '2026-10').xCost, 0);
  assert.equal(migrateXAccounting(db), false);
});
test('manual console baseline resolves old uncertainty and adds only subsequent new estimates', () => {
  const db = freshDB(), time = Date.parse('2026-10-17T01:00:00Z');
  db.stats['2026-10-17'] = {read: 25, matched: 25, reviewed: 1, postUnits: 0, userUnits: 0, xCost: 0, legacyXEstimate: .375, openaiCost: .0002};
  setXBaseline(db, .14, time);
  recordReads(db, [{id: 'new'}], [], DEFAULTS, time, {endpoint: 'search'});
  const totals = aggregate(db, '2026-10');
  assert.equal(totals.unverifiedXEstimate, 0); assert.equal(totals.legacyXEstimate, .375);
  assert.ok(Math.abs(totals.xCost + totals.aiCost - .1452) < 1e-12);
  assert.equal(db.stats['2026-10-17'].xBaseline.amount, .14);
  for (const amount of [-1, NaN, Infinity, '0.14']) assert.throws(() => setXBaseline(db, amount, time));
});

test('reply detection handles current/legacy references, reply target and thread conversation ID', () => {
  for (const post of [
    {id: '2', referenced_posts: [{type: 'replied_to', id: '1'}]},
    {id: '2', referenced_tweets: [{type: 'replied_to', id: '1'}]},
    {id: '2', in_reply_to_user_id: '3'},
    {id: '2', conversation_id: '1'}
  ]) assert.equal(isReply(post), true);
  assert.equal(isReply({id: '1', conversation_id: '1'}), false);
  assert.equal(isReply({id: '2', referenced_posts: [{type: 'quoted', id: '1'}]}), false);
});
test('ingestion rejects replies/self-thread continuations/reposts but retains originals and quotes', () => {
  const db = freshDB();
  const data = [
    {id: '1', conversation_id: '1'},
    {id: '2', referenced_tweets: [{type: 'replied_to', id: '1'}]},
    {id: '3', conversation_id: '1'},
    {id: '4', in_reply_to_user_id: '2'},
    {id: '5', referenced_posts: [{type: 'retweeted', id: '1'}]},
    {id: '6', conversation_id: '6', referenced_posts: [{type: 'quoted', id: '1'}]}
  ].map(p => ({lang: 'ko', text: 'AI 도구', author_id: '2', ...p}));
  assert.equal(ingest(db, {data, includes: {users: [{id: '2', verified: true}]}}, 'search', DEFAULTS, '99'), 2);
  assert.deepEqual(db.queue.map(p => p.id), ['1', '6']);
  assert.ok(db.queue.every(p => p.originalVerified));
  assert.equal(aggregate(db, localDay()).postUnits, 6); // returned resources still counted
});
test('original-only upgrade archives unknown candidates with edited drafts and resets old cursors once', () => {
  const db = freshDB(); delete db.originalPostsVersion;
  db.queue = [{id: '1', draft: '수정한 초안'}, {id: '2', originalVerified: true},
    {id: '3', originalVerified: true, conversation_id: '1'}];
  db.cursors = {timeline: 'old'}; db.processed = {'9': '2026-10-17'};
  assert.equal(migrateOriginalPosts(db), true);
  assert.deepEqual(db.queue.map(p => p.id), ['2']);
  assert.equal(db.archivedCandidates[0].draft, '수정한 초안');
  assert.deepEqual(db.cursors, {}); assert.ok(db.processed['9']);
  assert.equal(migrateOriginalPosts(db), false); assert.equal(db.archivedCandidates.length, 2);
});

test('visibility filters reject known restrictions but do not confuse reply permission with viewing permission', () => {
  assert.equal(unavailablePost({scopes: {followers: true}}, {}), true);
  assert.equal(unavailablePost({withheld: {country_codes: ['KR']}}, {}), true);
  assert.equal(unavailablePost({}, {protected: true}), true);
  assert.equal(unavailablePost({}, {connection_status: ['blocking']}), true);
  assert.equal(unavailablePost({reply_settings: 'mentioned_users'}, {protected: false}), false);
  assert.equal(unavailablePost({}, undefined), false); // missing metadata is not proof of access
});
test('excluded authors, blocked/protected users and excluded posts never enter the candidate queue', () => {
  const db = freshDB(); db.excludedPosts = ['5'];
  const settings = {...DEFAULTS, excludedAuthors: ['id:2', 'hidden']};
  const response = {data: Array.from({length: 7}, (_, i) => ({id: String(i + 1), author_id: String(i + 2), text: 'AI 글', lang: 'ko'})),
    includes: {users: [{id: '2', username: 'first'}, {id: '3', username: 'Hidden'},
      {id: '4', protected: true}, {id: '5', connection_status: ['blocking']}, {id: '7', username: 'public', verified: true}, {id: '8', username: 'another', verified: true}]}};
  assert.equal(ingest(db, response, 'search', settings, '99'), 2);
  assert.deepEqual(db.queue.map(p => p.id), ['6', '7']);
  assert.equal(aggregate(db, localDay()).read, 7);
  assert.deepEqual(cleanExcludedAuthors(['@Hidden', ' hidden ', 'id:123']), ['hidden', 'id:123']);
  assert.throws(() => cleanExcludedAuthors(['https://x.com/a']));
});
test('new author restriction information also removes already queued posts and preserves their drafts', () => {
  const db = freshDB(); db.queue = [{id: '100', authorId: '2', draft: '수정한 초안'}];
  ingest(db, {data: [], includes: {users: [{id: '2', protected: true}]}}, 'timeline', DEFAULTS, '99');
  assert.equal(db.queue.length, 0); assert.equal(db.archivedCandidates[0].draft, '수정한 초안');
});
test('editable reply instructions validate length and preserve user text', () => {
  assert.equal(validateSettings({...DEFAULTS, replyPrompt: '담백하게 질문 하나만 쓰세요.'}).replyPrompt, '담백하게 질문 하나만 쓰세요.');
  assert.throws(() => validateSettings({...DEFAULTS, replyPrompt: ''}));
  assert.throws(() => validateSettings({...DEFAULTS, replyPrompt: 'x'.repeat(10001)}));
});
test('clearing the queue archives leftover drafts, restarts from newest, and keeps history', () => {
  const db = freshDB();
  db.queue = [{id: '1', draft: '어제 초안'}, {id: '2', draft: ''}];
  db.archivedCandidates = [{id: '0'}]; db.processed = {9: '2026-10-22'}; db.cursors = {timeline: 'abc', searchIndex: 2};
  db.stats = {'2026-10-22': {reviewed: 1}};
  assert.equal(clearQueue(db), 2);
  assert.deepEqual(db.queue, []); assert.deepEqual(db.cursors, {});
  assert.deepEqual(db.archivedCandidates.map(p => p.id), ['0', '1', '2']);
  assert.equal(db.archivedCandidates[1].draft, '어제 초안');
  assert.deepEqual(db.processed, {9: '2026-10-22'}); assert.deepEqual(db.stats, {'2026-10-22': {reviewed: 1}});
  assert.match(db.lastReport, /2개/);
  // Cleared posts are not marked processed, so they can be collected again.
  ingest(db, {data: [{id: '1', author_id: '2', lang: 'ko', text: 'AI 자동화'}], includes: {users: [{id: '2', name: '민', username: 'min', verified: true}]}}, 'search', DEFAULTS, '99');
  assert.deepEqual(db.queue.map(p => p.id), ['1']);
});
