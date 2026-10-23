import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, freshDB} from '../core.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
let moduleId = 0;
async function harness(initial = {}, shared = {}) {
  const local = clone(initial), session = {}, sync = clone(shared), calls = [], storageListeners = [];
  let listener, launch;
  const area = data => ({
    setAccessLevel: async () => {},
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, clone(data[k])])),
    set: async patch => Object.assign(data, clone(patch)),
    remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(k => delete data[k])
  });
  globalThis.chrome = {
    storage: {local: area(local), session: area(session), sync: area(sync), onChanged: {addListener(fn) { storageListeners.push(fn); }}},
    identity: {getRedirectURL: path => 'https://testextension.chromiumapp.org/' + path,
      launchWebAuthFlow: async value => { launch = new URL(value.url); return h.login(launch); }},
    sidePanel: {setPanelBehavior: async () => {}},
    runtime: {id: 'testextension', getURL: path => 'chrome-extension://testextension/' + path,
      onInstalled: {addListener() {}}, onMessage: {addListener(fn) { listener = fn; }}, sendMessage: async () => {}}
  };
  globalThis.fetch = async (url, init) => { calls.push({url: new URL(url), init}); return h.fetch(new URL(url), init); };
  const h = {local, session, sync, storageChanged: changes => Promise.all(storageListeners.map(fn => fn(changes, 'sync'))), calls, get launch() { return launch; },
    login: u => chrome.identity.getRedirectURL('oauth2') + '?code=abc&state=' + u.searchParams.get('state'),
    fetch: () => { throw new Error('Unexpected network request'); },
    send: (type, extra = {}, sender) => new Promise(resolve => {
      const accepted = listener({type, ...extra}, sender || {id: 'testextension', url: 'chrome-extension://testextension/sidepanel.html'}, resolve);
      if (!accepted) resolve({rejected: true});
    })};
  await import('../background.js?test=' + moduleId++);
  return h;
}
const ok = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers});
const auth = () => ({accessToken: 'access-original', refreshToken: 'refresh-original', expiresAt: Date.now() + 1e7,
  tokenType: 'bearer', scopes: ['tweet.read', 'users.read', 'offline.access'], user: {id: '99', username: 'JungkwanDean', name: '옥토'}});
// Preserve the original xAI regression baseline while testing OpenAI separately.
const initial = () => ({settings: {...DEFAULTS, provider: 'xai', model: 'grok-4.7', inputRate: 2, outputRate: 6, cachedInputRate: .5, clientId: 'client', apiKey: 'xai-test'}, auth: auth(), db: freshDB()});
const page = (id, next) => ({data: [{id, author_id: '2', lang: 'ko', text: 'AI 자동화'}], includes: {users: [{id: '2', name: '민', username: 'min', verified: true}]}, meta: {next_token: next}});
const draft = () => ({status: 'completed', usage: {input_tokens: 100, output_tokens: 30}, output: [{type: 'message', content: [{type: 'output_text', text: '{"summary":"AI 자동화 글","reply":"와우 꿀팁이네요 ㅋㅋㅋ"}'}]}]});

test('unauthenticated collection explains setup; no request is issued', async () => {
  const h = await harness(); const r = await h.send('COLLECT');
  assert.equal(r.ok, false); assert.match(r.error, /X 계정/); assert.equal(h.calls.length, 0);
});
test('demo supports edit/copy/next without APIs, charges, or touching real queue', async () => {
  const data = initial(); data.db.queue = [{id: '123', text: '실제 글', draft: '보존'}];
  const h = await harness(data); let r = await h.send('TOGGLE_DEMO');
  assert.equal(r.value.remaining, 3);
  const id = r.value.current.id;
  await h.send('SAVE_DRAFT', {id, draft: '수정한 댓글'});
  r = await h.send('COPIED', {id}); assert.equal(r.value.current.copied, true);
  assert.equal(r.value.current.draft, '수정한 댓글');
  r = await h.send('NEXT', {id}); assert.equal(r.value.remaining, 2);
  r = await h.send('TOGGLE_DEMO'); assert.equal(r.value.current.id, '123');
  assert.equal(r.value.today.read, 0); assert.equal(h.calls.length, 0);
});
test('OAuth PKCE S256 validates state, stores refresh token, and reads actual account', async () => {
  const h = await harness({settings: {...DEFAULTS, clientId: 'client'}});
  h.fetch = (url, init) => url.pathname.endsWith('/token') ? ok({access_token: 'a', refresh_token: 'r', expires_in: 7200}) : ok({data: {id: '99', username: 'JungkwanDean'}});
  const r = await h.send('CONNECT'); assert.equal(r.ok, true);
  assert.equal(h.launch.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(h.launch.searchParams.get('scope'), 'tweet.read users.read offline.access');
  const tokenBody = new URLSearchParams(h.calls[0].init.body);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenBody.get('code_verifier'))));
  const challenge = Buffer.from(bytes).toString('base64url');
  assert.equal(h.launch.searchParams.get('code_challenge'), challenge);
  assert.equal(h.local.auth.refreshToken, 'r'); assert.equal(h.session.oauthPending, undefined);
  assert.equal(r.value.account.username, 'JungkwanDean');
  assert.equal(JSON.stringify(r.value).includes('accessToken'), false);
});
test('OAuth callback state mismatch is rejected before token exchange', async () => {
  const h = await harness({settings: {...DEFAULTS, clientId: 'client'}});
  h.login = () => chrome.identity.getRedirectURL('oauth2') + '?code=abc&state=wrong';
  const r = await h.send('CONNECT'); assert.equal(r.ok, false); assert.match(r.error, /검증/);
  assert.equal(h.calls.length, 0); assert.equal(h.session.oauthPending, undefined);
});
test('collection paginates both sources, deduplicates and generates only the visible post', async () => {
  const h = await harness(initial());
  h.fetch = url => url.host === 'api.x.ai' ? ok(draft()) : ok(page(url.pathname.includes('timelines') ? '1' : '2', 'page2'));
  let r = await h.send('COLLECT'); assert.equal(r.ok, true); assert.equal(r.value.remaining, 2);
  assert.equal(r.value.current.generated, true); assert.equal(h.local.db.queue[1].generated, false);
  const payload = JSON.parse(h.calls.find(c => c.url.host === 'api.x.ai').init.body);
  assert.equal(payload.store, false); assert.equal(payload.reasoning.effort, 'low');
  assert.equal(payload.text.format.strict, true); assert.equal(payload.tools, undefined);
  assert.equal(r.value.today.postUnits, 2); assert.equal(r.value.today.userUnits, 0);
  r = await h.send('COLLECT'); assert.equal(r.value.remaining, 2); assert.equal(r.value.today.read, 4);
  assert.equal(r.value.today.postUnits, 2);
  const timeline = h.calls.filter(c => c.url.pathname.includes('timelines'));
  const search = h.calls.filter(c => c.url.pathname.includes('search/recent'));
  assert.equal(timeline[1].url.searchParams.get('pagination_token'), 'page2');
  assert.equal(search[1].url.searchParams.get('next_token'), 'page2');
  assert.equal(h.calls.filter(c => c.url.host === 'api.x.ai').length, 1);
});
test('partial source failure retains successfully ingested data and estimated costs', async () => {
  const h = await harness(initial());
  h.fetch = url => url.host === 'api.x.ai' ? ok(draft()) : url.pathname.includes('timelines') ? ok(page('1')) : ok({}, 403);
  const r = await h.send('COLLECT');
  assert.equal(r.ok, true); assert.equal(r.value.remaining, 1);
  assert.match(r.value.lastReport, /검색:.*접근 권한/); assert.equal(r.value.today.postUnits, 1);
});
test('refresh token rotation is persisted and requests use the new access token', async () => {
  const data = initial(); data.auth.expiresAt = 1;
  const h = await harness(data);
  h.fetch = (url, init) => {
    if (url.pathname.endsWith('/token')) return ok({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200});
    if (url.host === 'api.x.ai') return ok(draft());
    assert.equal(init.headers.Authorization, 'Bearer new-access');
    return ok(page('1'));
  };
  const r = await h.send('COLLECT'); assert.equal(r.ok, true);
  assert.equal(h.local.auth.refreshToken, 'new-refresh');
  assert.equal(h.calls.filter(c => c.url.pathname.endsWith('/token')).length, 1);
});
test('401 gets exactly one token refresh; 429 is persisted without automatic retry', async () => {
  const h = await harness(initial()); let timelineCalls = 0;
  h.fetch = url => {
    if (url.pathname.endsWith('/token')) return ok({access_token: 'new', refresh_token: 'new-r'});
    if (url.host === 'api.x.ai') return ok(draft());
    if (url.pathname.includes('timelines')) return ++timelineCalls === 1 ? ok({}, 401) : ok(page('1'));
    return ok({}, 429, {'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900)});
  };
  let r = await h.send('COLLECT'); assert.equal(timelineCalls, 2); assert.match(r.value.lastReport, /한도/);
  const searchCalls = h.calls.filter(c => c.url.pathname.includes('search')).length;
  r = await h.send('COLLECT');
  assert.match(r.value.lastReport, /대기 중/);
  assert.equal(h.calls.filter(c => c.url.pathname.includes('search')).length, searchCalls);
});
test('malformed Grok output keeps the post and accounts returned token usage', async () => {
  const h = await harness(initial());
  h.fetch = url => url.host === 'api.x.ai' ? ok({...draft(), status: 'incomplete'}) : ok(page('1'));
  const r = await h.send('COLLECT'); assert.equal(r.ok, true);
  assert.equal(r.value.current.generated, false); assert.equal(r.value.today.generations, 1);
  assert.ok(r.value.today.grokCost > 0); assert.match(r.value.lastReport, /완료되지/);
});
test('NEXT is persisted before a generation error and stale post edits cannot corrupt it', async () => {
  const data = initial(); data.db.queue = [{id: '1', generated: true, draft: 'one'}, {id: '2', generated: false, text: 'AI'}];
  const h = await harness(data); h.fetch = () => ok({}, 402);
  const r = await h.send('NEXT', {id: '1'}); assert.equal(r.value.current.id, '2');
  assert.ok(h.local.db.processed['1']); assert.match(r.value.lastReport, /잔액/);
  const stale = await h.send('SAVE_DRAFT', {id: '1', draft: 'wrong'}); assert.equal(stale.ok, false);
});
test('changing client ID drops old credentials; untrusted web messages are rejected', async () => {
  const h = await harness(initial());
  let r = await h.send('SAVE_SETTINGS', {settings: {...DEFAULTS, clientId: 'new-client'}});
  assert.equal(r.value.connected, false); assert.equal(h.local.auth, null);
  r = await h.send('GET_STATUS', {}, {id: 'testextension', url: 'https://x.com/'});
  assert.equal(r.rejected, true);
});

test('post-approval account failure is distinguished from OAuth token exchange failure', async () => {
  const h = await harness({settings: {...DEFAULTS, clientId: 'client'}});
  h.fetch = url => url.pathname.endsWith('/token') ? ok({access_token: 'secret-access', refresh_token: 'secret-refresh'}) : ok({errors: [{code: 32, message: 'Do not expose secret-access'}]}, 401);
  const r = await h.send('CONNECT');
  assert.equal(r.ok, false); assert.match(r.error, /토큰 발급은 완료/);
  assert.match(r.error, /GET \/2\/users\/me · HTTP 401 · code 32/);
  assert.equal(r.error.includes('secret-access'), false); assert.equal(r.error.includes('secret-refresh'), false);
});
test('invalid_client gives public-client instructions without disclosing raw server errors', async () => {
  const h = await harness({settings: {...DEFAULTS, clientId: 'client'}});
  h.fetch = () => ok({error: 'invalid_client', error_description: 'secret-value'}, 401);
  const r = await h.send('CONNECT');
  assert.equal(r.ok, false); assert.match(r.error, /Native App/);
  assert.match(r.error, /POST \/2\/oauth2\/token · HTTP 401 · invalid_client/);
  assert.equal(r.error.includes('secret-value'), false);
});
test('API enrollment problems show a separate hint with only allowlisted identifiers', async () => {
  const h = await harness({settings: {...DEFAULTS, clientId: 'client'}});
  h.fetch = url => url.pathname.endsWith('/token') ? ok({access_token: 'access'}) : ok({type: 'https://api.x.com/2/problems/client-forbidden', detail: 'private-detail'}, 403);
  const r = await h.send('CONNECT');
  assert.equal(r.ok, false); assert.match(r.error, /이용 상품/); assert.match(r.error, /client-forbidden/);
  assert.equal(r.error.includes('private-detail'), false);
});
test('diagnostic isolates me failure from successful username lookup without binding wrong identity', async () => {
  const data = initial(); data.auth.user = null;
  const h = await harness(data);
  h.fetch = (url, init) => {
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer access-original');
    return url.pathname.endsWith('/me') ? ok({title: 'Unauthorized', detail: 'secret-text'}, 401) : ok({data: {id: '99', username: 'JungkwanDean'}});
  };
  const r = await h.send('CHECK_CONNECTION');
  assert.equal(r.ok, true); assert.equal(h.calls.length, 2); assert.equal(r.value.account, null);
  assert.match(r.value.diagnostic, /내 계정 조회만 실패/);
  assert.equal(r.value.diagnostic.includes('access-original'), false);
  assert.equal(r.value.diagnostic.includes('secret-text'), false);
  assert.equal(r.value.today.userUnits, 1);
});
test('diagnostic preserves token and reports both 401 responses without refresh loops', async () => {
  const h = await harness(initial());
  h.fetch = () => ok({title: 'Unauthorized'}, 401, {'www-authenticate': 'Bearer error="invalid_token"'});
  const r = await h.send('CHECK_CONNECTION');
  assert.equal(r.ok, true); assert.equal(h.calls.length, 2);
  assert.match(r.value.diagnostic, /두 조회 모두 실패/); assert.match(r.value.diagnostic, /invalid_token/);
  assert.equal(h.local.auth.refreshToken, 'refresh-original');
});
test('diagnostic can restore a verified account through a successful bare me lookup', async () => {
  const data = initial(); data.auth.user = null;
  const h = await harness(data);
  h.fetch = () => ok({data: {id: '99', username: 'JungkwanDean', name: '옥토'}});
  const r = await h.send('CHECK_CONNECTION');
  assert.equal(r.ok, true); assert.equal(r.value.account.username, 'JungkwanDean');
  assert.match(r.value.diagnostic, /연결을 복구/); assert.equal(r.value.today.userUnits, 1);
  assert.ok(h.calls.every(c => !c.url.search));
});
test('diagnostic without a saved token makes no request', async () => {
  const h = await harness(); const r = await h.send('CHECK_CONNECTION');
  assert.equal(r.ok, false); assert.match(r.error, /토큰이 없습니다/); assert.equal(h.calls.length, 0);
});
test('older saved tokens get one silent refresh to recover granted scope metadata', async () => {
  const data = initial(); delete data.auth.scopes; delete data.auth.tokenType;
  const h = await harness(data);
  h.fetch = url => url.pathname.endsWith('/token')
    ? ok({access_token: 'new-private', refresh_token: 'rotated-private', scope: 'tweet.read users.read offline.access', token_type: 'bearer'})
    : ok({title: 'Unauthorized'}, 401);
  const r = await h.send('CHECK_CONNECTION');
  assert.equal(r.ok, true); assert.equal(h.calls.length, 3);
  assert.match(r.value.diagnostic, /승인 scope: tweet.read users.read offline.access/);
  assert.equal(r.value.diagnostic.includes('new-private'), false);
  assert.equal(h.local.auth.refreshToken, 'rotated-private');
});
test('v1.0 settings migrate to OpenAI without changing X login, posts, drafts, history or past costs', async () => {
  const data = initial(); delete data.settings.provider; delete data.settings.openaiApiKey;
  data.db.queue = [{id: '1', text: 'AI', draft: '직접 고친 댓글', generated: true}];
  data.db.processed = {'2': '2026-10-17'};
  data.db.stats = {'2026-10-17': {grokCost: .25, xCost: .05}};
  const h = await harness(data); const r = await h.send('GET_STATUS');
  assert.equal(r.value.settings.provider, 'openai'); assert.equal(r.value.settings.model, 'gpt-6-luna');
  assert.equal(r.value.settings.openaiApiKey, ''); assert.equal(r.value.settings.apiKey, 'xai-test');
  assert.equal(r.value.current.draft, '직접 고친 댓글'); assert.equal(r.value.processedCount, 1);
  assert.equal(r.value.today.aiCost, .25); assert.equal(r.value.account.username, 'JungkwanDean');
  assert.deepEqual(h.local.auth, data.auth); assert.deepEqual(h.local.db, data.db);
  assert.equal(h.local.legacyXaiSettings.model, 'grok-4.7');
  assert.equal(JSON.stringify(h.local.legacyXaiSettings).includes('xai-test'), false);
  assert.equal(h.calls.length, 0);
});
function openaiInitial() {
  const data = initial(); data.settings = {...DEFAULTS, clientId: 'client', openaiApiKey: 'openai-private', apiKey: 'xai-private'};
  data.db.queue = [{id: '1', text: 'AI 생산성 도구', name: '민', generated: false, draft: ''}];
  return data;
}
test('OpenAI generation uses only its own key, strict JSON, none reasoning and no hosted tools', async () => {
  const h = await harness(openaiInitial());
  h.fetch = (url, init) => {
    assert.equal(url.host, 'api.openai.com'); assert.equal(url.pathname, '/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer openai-private');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(body.tools, undefined);
    return ok(draft());
  };
  const r = await h.send('GENERATE'); assert.equal(r.ok, true);
  assert.equal(r.value.current.generatedModel, 'gpt-6-luna'); assert.equal(r.value.current.generatedProvider, 'openai');
  assert.ok(r.value.today.openaiCost > 0); assert.equal(r.value.today.grokCost, 0);
  assert.equal(h.calls.length, 1);
});
test('missing OpenAI key never falls back to or transmits the saved xAI key', async () => {
  const data = openaiInitial(); data.settings.openaiApiKey = '';
  const h = await harness(data); const r = await h.send('GENERATE');
  assert.equal(r.ok, false); assert.match(r.error, /OpenAI API Key/); assert.equal(h.calls.length, 0);
});
test('OpenAI quota failures preserve an edited draft and do not retry or expose server free text', async () => {
  const data = openaiInitial(); data.db.queue[0].draft = '사용자가 고친 댓글'; data.db.queue[0].generated = true;
  const h = await harness(data);
  h.fetch = () => ok({error: {code: 'insufficient_quota', message: 'openai-private'}}, 429);
  const r = await h.send('GENERATE'); assert.equal(r.ok, false); assert.match(r.error, /프로젝트 예산/);
  assert.equal(r.error.includes('openai-private'), false); assert.equal(h.calls.length, 1);
  assert.equal(h.local.db.queue[0].draft, '사용자가 고친 댓글');
});
test('OpenAI model access failures do not auto-upgrade to a more expensive model', async () => {
  const h = await harness(openaiInitial());
  h.fetch = () => ok({error: {code: 'model_not_found'}}, 404);
  const r = await h.send('GENERATE'); assert.equal(r.ok, false); assert.match(r.error, /모델 이용 권한/);
  assert.equal(h.calls.length, 1);
});
test('OpenAI refusal is explicit, retains existing draft and records returned usage', async () => {
  const data = openaiInitial(); data.db.queue[0].draft = '내 초안';
  const h = await harness(data);
  h.fetch = () => ok({status: 'completed', usage: {input_tokens: 100, output_tokens: 10},
    output: [{type: 'message', content: [{type: 'refusal', refusal: 'refused'}]}]});
  const r = await h.send('GENERATE'); assert.equal(r.ok, false); assert.match(r.error, /거절/);
  assert.equal(h.local.db.queue[0].draft, '내 초안');
  assert.ok(Object.values(h.local.db.stats)[0].openaiCost > 0);
});
test('changing providers preserves X credentials and keeps the two keys separate', async () => {
  const data = openaiInitial(); const h = await harness(data);
  const r = await h.send('SAVE_SETTINGS', {settings: {...data.settings, provider: 'xai', model: 'grok-4.3', inputRate: 1.25, outputRate: 2.5}});
  assert.equal(r.ok, true); assert.equal(r.value.account.username, 'JungkwanDean');
  assert.equal(h.local.settings.openaiApiKey, 'openai-private'); assert.equal(h.local.settings.apiKey, 'xai-private');
});
test('OpenAI optional models get compatible reasoning settings', async () => {
  for (const [model, effort] of [['gpt-4.1-mini', undefined], ['gpt-6.1-sol', 'low']]) {
    const data = openaiInitial(); data.settings.model = model;
    const h = await harness(data);
    h.fetch = (url, init) => { assert.equal(JSON.parse(init.body).reasoning?.effort, effort); return ok(draft()); };
    assert.equal((await h.send('GENERATE')).ok, true);
  }
});
test('upgrading old accounting marks the old estimate for review while preserving login and drafts', async () => {
  const data = openaiInitial(); delete data.db.xAccountingVersion;
  const day = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul'}).format(new Date());
  data.db.stats[day] = {read: 25, xCost: .375, postUnits: 25, userUnits: 25, openaiCost: .0002};
  const h = await harness(data); let r = await h.send('GET_STATUS');
  assert.equal(r.value.today.unverifiedXEstimate, .375);
  assert.equal(r.value.current.id, '1'); assert.equal(r.value.account.username, 'JungkwanDean');
  r = await h.send('SET_X_BASELINE', {amount: .14});
  assert.equal(r.value.today.unverifiedXEstimate, 0); assert.equal(r.value.today.xCost, .14);
  assert.equal(r.value.xBaseline.amount, .14); assert.equal(h.calls.length, 0);
});

test('collection excludes replies at both API sources and rejects a reply that leaks through', async () => {
  const h = await harness(initial());
  h.fetch = url => {
    if (url.host === 'api.x.ai') return ok(draft());
    assert.ok(url.searchParams.get('post.fields').includes('conversation_id'));
    if (url.pathname.includes('timelines')) assert.equal(url.searchParams.get('exclude'), 'retweets,replies');
    else assert.ok(url.searchParams.get('query').endsWith('-is:reply is:verified'));
    return ok({data: [{id: '1', conversation_id: '1', author_id: '2', lang: 'ko', text: 'AI 원글'},
      {id: '2', conversation_id: '1', author_id: '2', lang: 'ko', text: 'AI 답글'}], includes: {users: [{id: '2', verified: true}]}});
  };
  const result = await h.send('COLLECT');
  assert.equal(result.ok, true); assert.equal(result.value.remaining, 1);
  assert.equal(result.value.current.id, '1');
  assert.ok(!JSON.parse(h.calls.find(c => c.url.host === 'api.x.ai').init.body).input[1].content.includes('AI 답글'));
});
test('startup archives old unknown candidates without network; export contains drafts but no credentials', async () => {
  const data = initial(); delete data.db.originalPostsVersion;
  data.db.queue = [{id: '1', text: '기존 글', draft: '직접 수정한 초안'}];
  const h = await harness(data);
  const result = await h.send('GET_STATUS');
  assert.equal(result.value.remaining, 0); assert.equal(result.value.archivedCandidateCount, 1);
  const exported = await h.send('EXPORT_ARCHIVED_CANDIDATES');
  assert.equal(exported.value.posts[0].draft, '직접 수정한 초안');
  assert.ok(!JSON.stringify(exported).includes('access-original'));
  assert.equal(h.local.auth.accessToken, 'access-original'); assert.equal(h.calls.length, 0);
});

test('original link updates exactly the active tab and rejects stale or untrusted IDs', async () => {
  const data = initial(); data.db.queue = [{id: '123', draft: '수정 보존'}];
  const h = await harness(data); const tabUpdates = [];
  chrome.tabs = {query: async query => {assert.deepEqual(query, {active: true, currentWindow: true}); return [{id: 42}];},
    update: async (id, details) => tabUpdates.push({id, ...details})};
  let result = await h.send('OPEN_ORIGINAL', {id: '123'});
  assert.equal(result.ok, true); assert.deepEqual(tabUpdates, [{id: 42, url: 'https://x.com/i/status/123'}]);
  result = await h.send('OPEN_ORIGINAL', {id: '999'}); assert.equal(result.ok, false);
  assert.equal(tabUpdates.length, 1); assert.equal(h.calls.length, 0);
});
test('custom reply prompt is stored and sent to AI, with no leftover old style examples', async () => {
  const h = await harness(initial());
  const custom = '문장 하나로 담백하게 질문만 하세요. 감탄사는 생략하세요.';
  let result = await h.send('SAVE_SETTINGS', {settings: {...h.local.settings, replyPrompt: custom}});
  assert.equal(result.ok, true);
  h.fetch = url => url.host === 'api.x.ai' ? ok(draft()) : ok(page('1'));
  await h.send('COLLECT');
  const system = JSON.parse(h.calls.find(c => c.url.host === 'api.x.ai').init.body).input[0].content;
  assert.ok(system.includes(custom)); assert.ok(!system.includes('와우 이거 진짜 꿀팁'));
});
test('exclude author removes all their queued posts, preserves drafts, makes no API calls and filters future results', async () => {
  const data = initial(); data.db.queue = [{id: '1', authorId: '2', username: 'min', draft: '수정'},
    {id: '2', authorId: '2', username: 'min'}, {id: '3', authorId: '3', username: 'other'}];
  const h = await harness(data);
  const result = await h.send('EXCLUDE_AUTHOR', {id: '1'});
  assert.equal(result.ok, true); assert.equal(result.value.current.id, '3');
  assert.deepEqual(h.local.settings.excludedAuthors, ['id:2']);
  assert.equal(h.local.db.archivedCandidates[0].draft, '수정'); assert.equal(h.calls.length, 0);
  assert.equal(result.value.today.reviewed, 0);
  h.fetch = url => url.host === 'api.x.ai' ? ok(draft()) : ok(page('4'));
  await h.send('COLLECT'); assert.deepEqual(h.local.db.queue.map(p => p.id), ['3']);
});
test('exclude post suppresses only that post and saving excluded accounts prunes queued candidates', async () => {
  const data = initial(); data.db.queue = [{id: '1', authorId: '2', username: 'min', draft: '보존'},
    {id: '2', authorId: '3', username: 'other'}];
  const h = await harness(data);
  let result = await h.send('EXCLUDE_POST', {id: '1'});
  assert.equal(result.value.current.id, '2'); assert.deepEqual(h.local.db.excludedPosts, ['1']);
  result = await h.send('SAVE_SETTINGS', {settings: {...h.local.settings, excludedAuthors: ['@other']}});
  assert.equal(result.value.remaining, 0); assert.equal(h.calls.length, 0);
});

test('shared settings initialize a second device and leave its API keys/login/data local', async () => {
  const first = await harness(initial()); await first.send('SAVE_SETTINGS', {settings: {...first.local.settings,
    replyPrompt: '집에서 저장한 지침', keywords: ['공유키워드'], excludedAuthors: ['@hidden']}});
  const secondData = initial(); secondData.settings.apiKey = 'company-private';
  const second = await harness(secondData, first.sync);
  let result = await second.send('GET_STATUS');
  assert.equal(result.value.settings.replyPrompt, '집에서 저장한 지침');
  assert.deepEqual(result.value.settings.keywords, ['공유키워드']);
  assert.deepEqual(result.value.settings.excludedAuthors, ['hidden']);
  assert.equal(second.local.settings.apiKey, 'company-private'); assert.equal(second.local.auth.accessToken, 'access-original');
  assert.equal(second.calls.length, 0);
});
test('a new device never uploads default settings before the shared settings arrive', async () => {
  const h = await harness(); await h.send('GET_STATUS'); assert.deepEqual(h.sync, {});
  assert.equal(h.calls.length, 0);
});
test('remote sync event updates settings, resets changed search cursors and prunes excluded queue authors', async () => {
  const data = initial(); data.db.queue = [{id: '1', authorId: '2', username: 'min', draft: '보존'}];
  data.db.cursors = {timeline: 'old'};
  const h = await harness(data); await h.send('GET_STATUS');
  const {writeShared} = await import('../sync.js');
  await writeShared(chrome.storage.sync, {...DEFAULTS, keywords: ['새키워드'], excludedAuthors: ['id:2']});
  await h.storageChanged({octoSharedHead: {newValue: h.sync.octoSharedHead}});
  const result = await h.send('GET_STATUS');
  assert.equal(result.value.remaining, 0); assert.deepEqual(h.local.db.cursors, {});
  assert.equal(h.local.db.archivedCandidates[0].draft, '보존'); assert.equal(h.calls.length, 0);
});
test('sync quota failures retain saved local settings and surface the failure without losing authentication', async () => {
  const h = await harness(initial()); await h.send('GET_STATUS');
  chrome.storage.sync.set = async () => {throw new Error('QUOTA_BYTES');};
  const result = await h.send('SAVE_SETTINGS', {settings: {...h.local.settings, replyPrompt: '로컬 저장 유지'}});
  assert.equal(result.ok, true); assert.equal(result.value.settings.replyPrompt, '로컬 저장 유지');
  assert.match(result.value.sync.error, /QUOTA_BYTES/); assert.equal(h.local.auth.accessToken, 'access-original');
});

test('unsent local settings survive a worker restart and are retried before older shared data can overwrite them', async () => {
  const first = await harness(initial()); await first.send('GET_STATUS');
  chrome.storage.sync.set = async () => {throw new Error('quota');};
  await first.send('SAVE_SETTINGS', {settings: {...first.local.settings, replyPrompt: '아직 보내지 못한 새 지침'}});
  assert.equal(first.local.sharedSyncPending, true);
  const restarted = await harness(first.local, first.sync);
  const result = await restarted.send('GET_STATUS');
  assert.equal(result.value.settings.replyPrompt, '아직 보내지 못한 새 지침');
  assert.equal(restarted.local.sharedSyncPending, undefined);
  assert.equal(result.value.sync.error, '');
});
test('portable records restore counts while keeping this device API keys and requiring reconnect after client change', async () => {
  const data = initial();
  const h = await harness(data);
  const {exportRecords} = await import('../backup.js');
  const db = freshDB(); db.stats = {'2026-10-17': {matched: 12, reviewed: 4, xCost: .14}};
  const backup = exportRecords({...DEFAULTS, clientId: 'old-app'}, db);
  const result = await h.send('IMPORT_RECORDS', {backup});
  assert.equal(result.ok, true); assert.equal(h.local.db.stats['2026-10-17'].reviewed, 4);
  assert.equal(h.local.settings.apiKey, 'xai-test'); assert.equal(h.local.auth, null);
  assert.equal(h.calls.length, 0);
});
test('clear queue archives leftovers with drafts, resets cursors, and makes no API calls', async () => {
  const data = initial();
  data.db.queue = [{id: '1', text: '어제 글', draft: '초안'}, {id: '2', text: '어제 글2', draft: ''}];
  data.db.cursors = {timeline: 'old', searchIndex: 1}; data.db.processed = {5: '2026-10-22'};
  const h = await harness(data);
  let r = await h.send('CLEAR_QUEUE');
  assert.equal(r.ok, true); assert.equal(r.value.current, null); assert.equal(r.value.remaining, 0);
  assert.equal(r.value.archivedCandidateCount, 2); assert.equal(r.value.processedCount, 1);
  assert.deepEqual(h.local.db.cursors, {}); assert.equal(h.calls.length, 0);
  r = await h.send('EXPORT_ARCHIVED_CANDIDATES');
  assert.equal(r.value.posts[0].draft, '초안');
  await h.send('TOGGLE_DEMO'); r = await h.send('CLEAR_QUEUE');
  assert.equal(r.ok, false); assert.match(r.error, /체험 모드/);
});
