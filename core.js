// Pure helpers shared by the service worker, UI, and offline tests.
export const AI_PRESETS = {
  openai: {model: 'gpt-6-luna', inputRate: 0.10, outputRate: 0.50, cachedInputRate: 0.01, cacheWriteRate: 0.125},
  xai: {model: 'grok-4.3', inputRate: 1.25, outputRate: 2.50, cachedInputRate: 0.20, cacheWriteRate: 1.25}
};
export const DEFAULT_REPLY_PROMPT = `한국어로 짧고 자연스럽게 대화하는 댓글을 작성하세요.
원문의 구체적인 내용 한 가지에 반응하고, 친근한 존댓말로 1~2문장 이내로 쓰세요.
‘와우’, ‘와우,’, ‘대단하십니다’, ‘정말 유익한 정보네요’ 같은 상투적인 감탄과 과장된 칭찬은 쓰지 마세요.
문장 앞에 감탄사나 불필요한 쉼표를 붙이지 마세요. ㅋㅋ, 느낌표, 물결표도 억지로 넣지 마세요.
번호 목록, 광고 문구, 긴 설명은 피하세요. 원문의 분위기에 맞춰 담백하게 반응하세요.`;
export const DEFAULTS = {
  replyPrompt: DEFAULT_REPLY_PROMPT, excludedAuthors: [],
  clientId: '', provider: 'openai', openaiApiKey: '', apiKey: '', batchSize: 25,
  keywords: ['AI', '인공지능', '자동화', '꿀팁', '생산성', '수익화', '부업', '스타트업', '도구', '팁', '효율', 'ChatGPT', 'Grok', 'Claude', '시간절약', '빌더'],
  excludeKeywords: ['주식', '코인', '종목', '증시', '매수', '코스피', '나스닥', '에어드랍', 'has:cashtags'],
  postRate: 0.005, userRate: 0.01, ...AI_PRESETS.openai
};
export const utcDay = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
export const localDay = (time = Date.now()) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(time));
export const money = n => '$' + Number(n || 0).toFixed(4);
export function cleanKeywords(values) {
  return [...new Map(values.map(v => String(v).normalize('NFKC').trim()).filter(Boolean)
    .map(v => [v.toLocaleLowerCase(), v])).values()];
}
// Exclusions are entered without the leading '-'; a typed '-' is tolerated and stripped.
const EXCLUDE_OPERATORS = new Set(['has:cashtags', 'has:links', 'has:media', 'has:images', 'has:videos', 'has:hashtags', 'has:mentions', 'is:quote']);
const CASHTAG = /(^|[^\w$])\$[a-z][a-z0-9_.]{0,9}\b/i;
export function cleanExcludeKeywords(values) {
  return cleanKeywords(values.map(v => String(v).normalize('NFKC').trim().replace(/^-+/, '')))
    .map(v => EXCLUDE_OPERATORS.has(v.toLowerCase()) ? v.toLowerCase() : v);
}
export function matches(post, keywords, excludeKeywords = []) {
  const text = String(post.text || '').normalize('NFKC').toLocaleLowerCase();
  if (post.lang !== 'ko' || !keywords.some(k => text.includes(k.normalize('NFKC').toLocaleLowerCase()))) return false;
  // Mirror the search exclusions locally so timeline posts are filtered the same way.
  return !cleanExcludeKeywords(excludeKeywords).some(k =>
    k === 'has:cashtags' ? CASHTAG.test(text) : EXCLUDE_OPERATORS.has(k) ? false : text.includes(k.toLocaleLowerCase()));
}
// Support both the current post vocabulary and older tweet API responses.
export function isReply(post) {
  return !!post.in_reply_to_user_id ||
    [...(post.referenced_posts || []), ...(post.referenced_tweets || [])].some(r => r.type === 'replied_to') ||
    !!(post.conversation_id && String(post.conversation_id) !== String(post.id));
}
export function isRepost(post) {
  return [...(post.referenced_posts || []), ...(post.referenced_tweets || [])].some(r => r.type === 'retweeted');
}
export function migrateOriginalPosts(db) {
  if (db.originalPostsVersion === 1) return false;
  const keep = [], archived = [];
  for (const post of db.queue || []) {
    if (post.originalVerified && !isReply(post) && !isRepost(post)) keep.push(post);
    else archived.push(post);
  }
  db.queue = keep;
  db.archivedCandidates = [...(db.archivedCandidates || []), ...archived];
  db.originalPostsVersion = 1;
  db.cursors = {};
  if (archived.length) db.lastReport = `답글 제외 적용: 기존 대기 글 ${archived.length}개는 유형 정보가 없어 백업으로 옮겼습니다. 설정에서 글·초안을 내려받을 수 있습니다. ‘더 가져오기’로 원글을 수집하세요.`;
  return true;
}
export function verifiedAuthor(author) {
  return author?.verified === true || ['blue', 'business', 'government'].includes(author?.verified_type);
}
export function migrateVerifiedPosts(db) {
  if (db.verifiedPostsVersion === 1) return false;
  const removed = db.queue.filter(p => p.authorVerified !== true);
  if (removed.length) {
    db.archivedCandidates = [...(db.archivedCandidates || []), ...removed];
    db.queue = db.queue.filter(p => p.authorVerified === true);
    db.lastReport = `인증 계정 전용 적용: 인증 정보를 확인할 수 없는 기존 글 ${removed.length}개를 백업했습니다. ‘더 가져오기’로 새 글을 수집하세요.`;
  }
  db.cursors = {}; db.verifiedPostsVersion = 1;
  return true;
}
export function cleanExcludedAuthors(values) {
  if (!Array.isArray(values)) throw new Error('제외 계정 목록은 한 줄에 하나씩 입력해주세요.');
  const tokens = values.map(v => String(v).trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (tokens.some(v => !/^(?:[a-z0-9_]{1,15}|id:[0-9]{1,20})$/.test(v))) throw new Error('제외 계정은 @아이디 또는 id:숫자로 입력해주세요.');
  return [...new Set(tokens)];
}
export function excludedAuthor(post, author, settings) {
  const entries = settings.excludedAuthors || [];
  return entries.includes('id:' + (post.author_id || post.authorId)) ||
    !!(author?.username && entries.includes(author.username.toLowerCase()));
}
export function unavailablePost(post, author) {
  // Visibility and reply permissions are different; reply_settings is not a visibility flag.
  return author?.protected === true || !!post.withheld || !!author?.withheld ||
    author?.connection_status?.includes('blocking') === true || post.scopes?.followers === true;
}
export function pruneExcluded(db, settings) {
  const removed = db.queue.filter(p => (db.excludedPosts || []).includes(p.id) ||
    excludedAuthor(p, {username: p.username}, settings) || unavailablePost(p, p.author));
  if (removed.length) {
    db.archivedCandidates = [...(db.archivedCandidates || []), ...removed];
    const ids = new Set(removed.map(p => p.id));
    db.queue = db.queue.filter(p => !ids.has(p.id));
  }
  return removed.length;
}
// Quote every term: user-entered strings are keywords, never raw search operators.
// Only whitelisted operators (has:cashtags etc.) pass through unquoted.
export function searchQueries(keywords, excludeKeywords = []) {
  const quote = k => '"' + k.replace(/["\\\r\n]/g, ' ').trim() + '"';
  const terms = cleanKeywords(keywords).map(quote);
  const excludes = cleanExcludeKeywords(excludeKeywords).map(k => '-' + (EXCLUDE_OPERATORS.has(k) ? k : quote(k)));
  const suffix = ' lang:ko -is:retweet -is:reply is:verified' + excludes.map(e => ' ' + e).join('');
  if (suffix.length > 300) throw new Error('제외 키워드가 너무 깁니다. 개수를 줄여주세요.');
  const queries = []; let chunk = [];
  const build = c => '(' + c.join(' OR ') + ')' + suffix;
  for (const term of terms) {
    if (build([term]).length > 500) throw new Error('키워드 하나는 450자 이내로 입력해주세요.');
    if (build([...chunk, term]).length > 500) { queries.push(build(chunk)); chunk = []; }
    chunk.push(term);
  }
  if (chunk.length) queries.push(build(chunk));
  return queries;
}
export function freshDB() {
  return {queue: [], processed: {}, stats: {}, billable: {day: '', posts: [], users: []},
    cursors: {}, demo: false, demoQueue: [], lastReport: '', accountId: '', xAccountingVersion: 2, costLedger: [], originalPostsVersion: 1, archivedCandidates: [], verifiedPostsVersion: 1};
}
export function migrateXAccounting(db) {
  if (db.xAccountingVersion === 2) return false;
  // Old totals mixed primary user lookups with users embedded in post responses.
  // There is no per-request history from which to reconstruct that split exactly.
  db.legacyXAccounting = {stats: structuredClone(db.stats), billableUsers: [...(db.billable?.users || [])]};
  for (const stat of Object.values(db.stats)) {
    stat.legacyXEstimate = stat.xCost || 0;
    stat.legacyPostUnits = stat.postUnits || 0; stat.legacyUserUnits = stat.userUnits || 0;
    stat.xCost = 0; stat.postUnits = 0; stat.userUnits = 0;
  }
  if (db.billable) db.billable.users = [];
  db.xAccountingVersion = 2; db.costLedger = [];
  return true;
}
function ledger(db, entry) {
  db.costLedger ||= []; db.costLedger.push(entry);
  if (db.costLedger.length > 200) db.costLedger.splice(0, db.costLedger.length - 200);
}
function dayStat(db, time) {
  const day = localDay(time);
  return db.stats[day] ||= {read: 0, matched: 0, reviewed: 0, postUnits: 0, userUnits: 0,
    xCost: 0, grokCost: 0, openaiCost: 0, generations: 0, inputTokens: 0, outputTokens: 0};
}
export function recordReads(db, posts, users, settings, time = Date.now(), context = {}) {
  const day = utcDay(time);
  // X deduplicates by UTC day; the UI groups estimates by Korea day of the request.
  if (db.billable.day !== day) db.billable = {day, posts: [], users: []};
  const seenPosts = new Set(db.billable.posts), seenUsers = new Set(db.billable.users);
  const stat = dayStat(db, time); stat.read += posts.length;
  const before = {cost: stat.xCost, posts: stat.postUnits, users: stat.userUnits};
  for (const p of posts) if (!seenPosts.has(p.id)) {
    seenPosts.add(p.id); stat.postUnits++; stat.xCost += settings.postRate;
  }
  for (const u of users) if (!seenUsers.has(u.id)) {
    seenUsers.add(u.id); stat.userUnits++; stat.xCost += settings.userRate;
  }
  db.billable.posts = [...seenPosts]; db.billable.users = [...seenUsers];
  if (context.endpoint) ledger(db, {at: new Date(time).toISOString(), kind: 'x', endpoint: context.endpoint,
    posts: stat.postUnits - before.posts, users: stat.userUnits - before.users,
    expandedUsers: context.expandedUsers || 0, cost: stat.xCost - before.cost});
}
export function ingest(db, response, source, settings, ownId, time = Date.now()) {
  const posts = response.data || [], users = response.includes?.users || [];
  // Expanded author objects are not independent calls to a user lookup endpoint.
  // Do not assume a separate User:Read charge for every includes.users object.
  recordReads(db, posts, [], settings, time, {endpoint: source, expandedUsers: users.length});
  const authors = new Map(users.map(u => [u.id, u]));
  const removed = db.queue.filter(p => unavailablePost(p, authors.get(p.authorId)));
  if (removed.length) {
    db.archivedCandidates = [...(db.archivedCandidates || []), ...removed];
    const ids = new Set(removed.map(p => p.id));
    db.queue = db.queue.filter(p => !ids.has(p.id));
  }
  const queued = new Set(db.queue.map(p => p.id)); let count = 0;
  for (const p of posts) {
    if (isReply(p) || isRepost(p) || !/^\d+$/.test(p.id) || p.author_id === ownId || queued.has(p.id) || db.processed[p.id]) continue;
    const text = p.note_tweet?.text || p.note_post?.text || p.text || '';
    if (!matches({...p, text}, settings.keywords, settings.excludeKeywords)) continue;
    const a = authors.get(p.author_id);
    if (!verifiedAuthor(a) || (db.excludedPosts || []).includes(p.id) || excludedAuthor(p, a, settings) || unavailablePost(p, a)) continue;
    db.queue.push({id: p.id, text, authorId: p.author_id, name: a?.name || '작성자',
      username: a?.username || '', authorVerified: true, verifiedType: a?.verified_type || '', createdAt: p.created_at || '', source,
      summary: '', draft: '', generated: false, copied: false, originalVerified: true,
      conversation_id: p.conversation_id || p.id});
    queued.add(p.id); count++;
  }
  dayStat(db, time).matched += count;
  return count;
}
export function recordGeneration(db, usage, settings, time = Date.now()) {
  const stat = dayStat(db, time);
  const input = Number(usage?.input_tokens || 0), output = Number(usage?.output_tokens || 0);
  stat.generations++; stat.inputTokens += input; stat.outputTokens += output;
  const cached = Math.min(input, Math.max(0, Number(usage?.input_tokens_details?.cached_tokens || 0)));
  const writes = settings.provider === 'openai'
    ? Math.min(input - cached, Math.max(0, Number(usage?.input_tokens_details?.cache_write_tokens || 0))) : 0;
  const cost = ((input - cached - writes) * settings.inputRate + cached * settings.cachedInputRate +
    writes * settings.cacheWriteRate + output * settings.outputRate) / 1e6;
  const key = settings.provider === 'openai' ? 'openaiCost' : 'grokCost';
  stat[key] = (stat[key] || 0) + cost;
  ledger(db, {at: new Date(time).toISOString(), kind: settings.provider || 'xai', endpoint: settings.model,
    input, output, cached, writes, cost});
}
export function markReviewed(db, time = Date.now()) {
  const p = db.queue.shift();
  if (p) { db.processed[p.id] = localDay(time); dayStat(db, time).reviewed++; }
}
export function aggregate(db, prefix) {
  const result = {read: 0, matched: 0, reviewed: 0, postUnits: 0, userUnits: 0, xCost: 0,
    grokCost: 0, openaiCost: 0, generations: 0, inputTokens: 0, outputTokens: 0,
    legacyXEstimate: 0, unverifiedXEstimate: 0};
  for (const [day, stat] of Object.entries(db.stats)) if (day.startsWith(prefix)) {
    for (const k of Object.keys(result)) result[k] += stat[k] || 0;
    if (!stat.legacyXReviewed) result.unverifiedXEstimate += stat.legacyXEstimate || 0;
  }
  return {...result, aiCost: result.grokCost + result.openaiCost};
}
export function setXBaseline(db, amount, time = Date.now()) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('콘솔 확인 금액은 0 이상의 숫자로 입력해주세요.');
  const stat = dayStat(db, time);
  const previous = stat.xCost;
  stat.xBaseline = {at: new Date(time).toISOString(), amount, previous};
  stat.xCost = amount; stat.legacyXReviewed = true;
  ledger(db, {at: new Date(time).toISOString(), kind: 'manual', endpoint: '오늘 X 콘솔 금액 반영', cost: amount});
}
export function validateSettings(value) {
  const s = {...DEFAULTS, ...value};
  s.clientId = String(s.clientId || '').trim(); s.apiKey = String(s.apiKey || '').trim();
  s.openaiApiKey = String(s.openaiApiKey || '').trim();
  s.replyPrompt = String(s.replyPrompt || '').trim();
  if (!s.replyPrompt || s.replyPrompt.length > 10000) throw new Error('댓글 작성 지침은 1~10,000자로 입력해주세요.');
  s.excludedAuthors = cleanExcludedAuthors(s.excludedAuthors);
  if (!['openai', 'xai'].includes(s.provider)) throw new Error('AI 제공사를 확인해주세요.');
  s.model = String(s.model || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(s.model)) throw new Error('AI 모델 ID를 확인해주세요.');
  if (s.provider === 'openai' && s.model.startsWith('grok-')) throw new Error('OpenAI 모델 ID를 입력해주세요. 예: gpt-6-luna');
  if (s.provider === 'xai' && !s.model.startsWith('grok-')) throw new Error('xAI 모델 ID를 입력해주세요. 예: grok-4.3');
  s.keywords = cleanKeywords(s.keywords || []);
  if (!s.keywords.length) throw new Error('키워드를 하나 이상 입력해주세요.');
  s.excludeKeywords = cleanExcludeKeywords(s.excludeKeywords || []);
  searchQueries(s.keywords, s.excludeKeywords);
  s.batchSize = Number(s.batchSize);
  if (!Number.isInteger(s.batchSize) || s.batchSize < 10 || s.batchSize > 100) throw new Error('소스당 수집량은 10~100 사이의 정수입니다.');
  for (const k of ['postRate', 'userRate', 'inputRate', 'outputRate', 'cachedInputRate', 'cacheWriteRate']) {
    s[k] = Number(s[k]);
    if (!Number.isFinite(s[k]) || s[k] < 0) throw new Error('단가는 0 이상의 숫자여야 합니다.');
  }
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, s[k]]));
}
export function parseDraft(response) {
  if (response.status && response.status !== 'completed') throw new Error('AI 응답이 완료되지 않았습니다. 다시 생성해주세요.');
  if ((response.output || []).some(o => (o.content || []).some(c => c.type === 'refusal'))) throw new Error('AI가 이 글의 댓글 생성을 거절했습니다. 다른 글로 이동하거나 직접 작성해주세요.');
  const text = (response.output || []).filter(o => o.type === 'message')
    .flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('AI 응답 형식이 올바르지 않습니다. 다시 생성해주세요.'); }
  if (typeof result.summary !== 'string' || typeof result.reply !== 'string' ||
    !result.summary.trim() || !result.reply.trim() || result.summary.length > 2000 || result.reply.length > 2000) {
    throw new Error('AI의 요약 또는 댓글이 비어 있거나 너무 깁니다. 다시 생성해주세요.');
  }
  return {summary: result.summary.trim(), draft: result.reply.trim()};
}
export function samples() {
  return [
    {name: '빌더 민', username: 'sample_builder', text: '반복하는 자료 정리를 AI로 자동화했더니 매일 30분이 생겼어요. 작은 도구라도 직접 만들어보는 게 진짜 공부가 되네요.', summary: '자료 정리 자동화로 하루 30분을 아낀 경험을 공유한 글입니다.', draft: '매일 30분씩 아끼면 꽤 크겠네요. 작은 도구부터 만드는 게 좋은 시작인 것 같아요.'},
    {name: '하루의 도구', username: 'sample_tools', text: '생산성 꿀팁: 할 일을 더 추가하기 전에 안 해도 되는 일부터 지워보세요. 도구 바꾸는 것보다 효과가 컸습니다.', summary: '새 도구보다 불필요한 일을 줄이는 것이 생산성에 도움이 됐다는 글입니다.', draft: '할 일을 줄이는 것도 능력이네요. 도구부터 바꾸려던 제 습관도 돌아보게 돼요.'},
    {name: '오늘도 만드는 중', username: 'sample_maker', text: '드디어 첫 AI 도구를 공개했습니다! 아직 서툴지만 피드백 받으면서 계속 개선해보려고요. 사이드프로젝트 하시는 분들 화이팅!', summary: '첫 AI 도구를 공개하고 피드백을 받아 개선하겠다는 글입니다.', draft: '첫 공개 축하드려요. 피드백 받으면서 어떻게 달라질지 궁금하네요.'}
  ].map((p, i) => ({...p, id: 'demo-' + i, source: i ? 'search' : 'timeline', generated: true, copied: false, createdAt: '', demo: true}));
}

// Diagnostics use a fixed allowlist; remote free text may contain credentials.
export function safeErrorInfo(body, authenticateHeader = '') {
  const value = body && typeof body === 'object' ? body : {};
  const identifiers = new Set(['invalid_client', 'unauthorized_client', 'invalid_grant', 'invalid_request',
    'invalid_scope', 'insufficient_scope', 'invalid_token', 'unsupported-authentication', 'client-forbidden',
    'client-not-enrolled', 'not-authorized-for-resource', 'usage-capped', 'credits-depleted',
    'insufficient_quota', 'invalid_api_key', 'model_not_found', 'permission_denied', 'rate_limit_exceeded']);
  const errors = Array.isArray(value.errors) ? value.errors.filter(e => e && typeof e === 'object') : [];
  const headerError = /(?:^|[,\s])error\s*=\s*"([a-z_]+)"/.exec(authenticateHeader)?.[1];
  const candidates = [value.error, value.error?.code, value.error?.type, String(value.type || '').split('/').pop(), headerError,
    ...errors.map(e => e.reason || String(e.type || '').split('/').pop())];
  const reason = candidates.find(v => typeof v === 'string' && identifiers.has(v)) || '';
  const code = [value.code, ...errors.map(e => e.code)].find(v => [32, 89, 99, 215, 220, 326].includes(v)) || null;
  const titles = new Set(['Unauthorized', 'Forbidden', 'Bad Request', 'Too Many Requests',
    'CreditsDepleted', 'UsageCapExceeded', 'Client Forbidden', 'Client Not Enrolled', 'Not Found']);
  const title = titles.has(value.title) ? value.title : '';
  return {reason, code, title};
}
