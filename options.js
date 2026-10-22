import {$, send, showError, clearError} from './ui.js';
import {money, localDay, AI_PRESETS, DEFAULT_REPLY_PROMPT} from './core.js';
let state, busy = false, modified = false;
let activeProvider = 'openai', profiles = structuredClone(AI_PRESETS);
const keys = ['replyPrompt', 'clientId', 'provider', 'openaiApiKey', 'apiKey', 'model', 'batchSize', 'postRate', 'userRate', 'inputRate', 'outputRate', 'cachedInputRate', 'cacheWriteRate'];
function providerUI() {
  $('openai-key-group').hidden = $('provider').value !== 'openai';
  $('xai-key-group').hidden = $('provider').value !== 'xai';
  $('model-help').textContent = $('provider').value === 'openai'
    ? '기본 gpt-6-luna는 추론 none으로 호출합니다. gpt-4.1-mini는 추론 설정 없이, gpt-6.1-sol은 low로 호출합니다. 모델 변경 시 아래 단가도 변경해주세요.'
    : '기본 grok-4.3은 추론 none으로 호출합니다. grok-4.7은 low입니다. 모델 변경 시 아래 단가도 변경해주세요.';
}
function render(value, fillForm = false) {
  state = value;
  $('sync-state').textContent = value.sync?.error ? value.sync.error : value.sync?.at ? `Chrome 동기화 저장소 반영: ${new Date(value.sync.at).toLocaleString('ko-KR')} · 다른 기기 도착 여부는 이 화면에서 확인할 수 없습니다.` : '공유 설정을 기다리는 중입니다. 처음 사용하는 기기는 설정 저장으로 시작하세요.';
  $('extension-id').textContent = `확장 ID: ${value.sync?.extensionId || ''} · ${value.sync?.stableId ? '고정 ID 버전' : '이전용 버전: 백업 후 고정 ID 버전으로 전환하세요.'}`;
  if (fillForm) {
    for (const key of keys) $(key).value = value.settings[key];
    $('excludedAuthors').value = (value.settings.excludedAuthors || []).join('\n');
    $('excludeKeywords').value = (value.settings.excludeKeywords || []).join('\n');
    $('keywords').value = value.settings.keywords.join('\n'); modified = false;
    activeProvider = value.settings.provider;
    for (const key of Object.keys(AI_PRESETS.openai)) profiles[activeProvider][key] = value.settings[key];
    providerUI();
  }
  $('redirectUri').value = value.redirectUri;
  $('account').textContent = value.account ? '@' + value.account.username : value.connected ? '계정 확인 필요' : '연결 안 됨';
  $('disconnect').disabled = !value.connected || busy;
  $('check-connection').disabled = !value.connected || busy;
  $('diagnostic-section').hidden = !value.diagnostic;
  $('diagnostic').value = value.diagnostic || '';
  $('archive-section').hidden = !value.archivedCandidateCount;
  $('archive-state').textContent = `대기열에서 옮겼거나 수집에서 제외한 글 ${value.archivedCandidateCount || 0}개의 원문·초안을 백업했습니다.`;
  $('month-label').textContent = localDay().slice(0, 7) + ' · 한국시간 기준';
  $('month-matched').textContent = value.month.matched.toLocaleString();
  $('month-reviewed').textContent = value.month.reviewed.toLocaleString();
  $('month-cost').textContent = money(value.month.xCost + value.month.aiCost);
  $('month-cost-label').textContent = value.month.unverifiedXEstimate > 0 ? '예상 비용 · 이전 X 제외' : '예상 비용';
  $('month-details').textContent = `비용 계산용 API 조회: 게시물 ${value.month.postUnits}개 · 단독 사용자 조회 ${value.month.userUnits}개 / X ${money(value.month.xCost)} · OpenAI ${money(value.month.openaiCost)} · Grok ${money(value.month.grokCost)} (${value.month.generations}회 생성)`;
  $('billing-review').hidden = !value.month.unverifiedXEstimate;
  $('billing-review').textContent = `이전 버전 X 추정 ${money(value.month.unverifiedXEstimate)}는 작성자 부가 정보를 독립 조회로 가산했을 수 있어 검증 대기 상태입니다. 과거에는 요청별 기록이 없어 정확한 소급 계산을 할 수 없습니다. 원본은 보존했고 위 예상 비용에서는 제외했습니다. 따라서 위 숫자는 전체 기간의 총액이 아닙니다. 같은 날짜·사용 범위의 X 콘솔 확인액을 아래에 입력하면 오늘 기준액을 보정할 수 있습니다.`;
  $('baseline-state').textContent = value.xBaseline ? `오늘 X 콘솔 기준액 ${money(value.xBaseline.amount)} 반영됨 · 이후 신규 요청은 추가 계산합니다.` : 'X 콘솔 확인액을 입력하지 않았습니다.';
  $('daily').replaceChildren();
  for (const [day, stat] of value.days) {
    const tr = document.createElement('tr');
    const xText = stat.legacyXEstimate && !stat.legacyXReviewed ? '이전 추정 검증 필요' : money(stat.xCost);
    for (const v of [day, stat.matched || 0, stat.reviewed || 0, xText, money((stat.grokCost || 0) + (stat.openaiCost || 0))]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    $('daily').append(tr);
  }
  $('no-stats').hidden = !!value.days.length;
  $('cost-ledger').replaceChildren();
  for (const item of value.costLedger || []) {
    const tr = document.createElement('tr');
    const details = item.kind === 'x' ? `게시물 ${item.posts} · 단독 사용자 ${item.users} · 부가 작성자 ${item.expandedUsers} (가산 안 함)`
      : item.kind === 'manual' ? '사용자가 콘솔 확인액 반영' : `입력 ${item.input} · 출력 ${item.output} · 캐시 읽기 ${item.cached} · 쓰기 ${item.writes}`;
    for (const v of [new Date(item.at).toLocaleTimeString('ko-KR'), item.endpoint, details, money(item.cost)]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    $('cost-ledger').append(tr);
  }
}
async function save() {
  const settings = {};
  for (const key of keys) settings[key] = $(key).value;
  settings.excludedAuthors = $('excludedAuthors').value.split('\n');
  settings.keywords = $('keywords').value.split('\n');
  settings.excludeKeywords = $('excludeKeywords').value.split('\n');
  render(await send('SAVE_SETTINGS', {settings}), true);
  $('save-state').textContent = '설정을 저장했습니다.';
}
async function run(fn) {
  if (busy) return; busy = true; clearError();
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  $('notice').textContent = '요청을 처리하고 있습니다.'; $('notice').hidden = false;
  try { await fn(); } catch (e) { showError(e); }
  finally {
    busy = false; $('notice').hidden = true;
    document.querySelectorAll('button').forEach(b => b.disabled = false);
    if (state) { $('disconnect').disabled = !state.connected; $('check-connection').disabled = !state.connected; }
  }
}
$('form').onsubmit = e => { e.preventDefault(); if ($('form').reportValidity()) run(save); };
$('form').addEventListener('input', () => { modified = true; $('save-state').textContent = '저장하지 않은 변경사항이 있습니다.'; });
$('provider').addEventListener('change', () => {
  for (const key of Object.keys(AI_PRESETS.openai)) profiles[activeProvider][key] = $(key).value;
  activeProvider = $('provider').value;
  for (const [key, value] of Object.entries(profiles[activeProvider])) $(key).value = value;
  providerUI(); modified = true;
});
$('connect').onclick = () => { if ($('form').reportValidity()) run(async () => { await save(); render(await send('CONNECT')); $('save-state').textContent = 'X 계정을 연결했습니다.'; }); };
$('disconnect').onclick = () => run(async () => { render(await send('DISCONNECT')); $('save-state').textContent = '이 기기의 X 토큰을 삭제했습니다.'; });
$('check-connection').onclick = () => run(async () => {
  if (modified) throw new Error('먼저 변경한 설정을 저장한 뒤 연결 진단을 눌러주세요.');
  render(await send('CHECK_CONNECTION'));
  $('diagnostic-section').scrollIntoView({block: 'center', behavior: 'smooth'});
});
$('copy-diagnostic').onclick = () => navigator.clipboard.writeText($('diagnostic').value).then(() => { $('copy-diagnostic').textContent = '진단 결과 복사됨'; }, showError);
function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('sync-pull').onclick = () => run(async () => render(await send('SYNC_PULL'), true));
$('sync-push').onclick = () => run(async () => {
  if (modified) throw new Error('먼저 변경한 설정을 저장해주세요.');
  render(await send('SYNC_PUSH'));
});
$('export-records').onclick = () => run(async () => downloadJSON(await send('EXPORT_RECORDS'), 'octo-records-backup.json'));
$('import-records').onclick = () => $('records-file').click();
$('records-file').onchange = () => run(async () => {
  const file = $('records-file').files[0];
  if (!file) return;
  try {
    if (file.size > 20000000) throw new Error('백업 파일은 20MB 이내로 선택해주세요.');
    const backup = JSON.parse(await file.text());
    render(await send('IMPORT_RECORDS', {backup}), true);
    $('save-state').textContent = '기록을 복원했습니다. API 키를 입력하고 새 Callback URL로 X를 연결해주세요.';
  } finally { $('records-file').value = ''; }
});
$('export-archive').onclick = () => run(async () => {
  const archive = await send('EXPORT_ARCHIVED_CANDIDATES');
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'octo-previous-candidates.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('apply-baseline').onclick = () => run(async () => {
  if (!$('x-baseline').value.trim()) throw new Error('X 콘솔에서 확인한 오늘 금액을 입력해주세요.');
  render(await send('SET_X_BASELINE', {amount: Number($('x-baseline').value)}));
});
$('reset-prompt').onclick = () => { $('replyPrompt').value = DEFAULT_REPLY_PROMPT; modified = true; $('save-state').textContent = '기본 지침으로 되돌렸습니다. 설정 저장을 눌러주세요.'; };
$('copy-redirect').onclick = () => navigator.clipboard.writeText($('redirectUri').value).then(() => { $('copy-redirect').textContent = '복사됨'; }, showError);
$('show-key').onclick = () => { const show = $('apiKey').type === 'password'; $('apiKey').type = show ? 'text' : 'password'; $('show-key').textContent = show ? '숨기기' : '보기'; $('show-key').setAttribute('aria-pressed', String(show)); };
$('show-openai-key').onclick = () => { const show = $('openaiApiKey').type === 'password'; $('openaiApiKey').type = show ? 'text' : 'password'; $('show-openai-key').textContent = show ? '숨기기' : '보기'; $('show-openai-key').setAttribute('aria-pressed', String(show)); };
function tab(name) {
  for (const n of ['settings', 'stats']) { $(n + '-view').hidden = n !== name; $(n + '-tab').classList.toggle('active', n === name); $(n + '-tab').setAttribute('aria-pressed', String(n === name)); }
}
$('settings-tab').onclick = () => tab('settings'); $('stats-tab').onclick = () => tab('stats');
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !busy && (changes.db || changes.auth || changes.settings)) send('GET_STATUS').then(s => render(s, !modified)).catch(showError);
});
send('GET_STATUS').then(s => render(s, true)).catch(showError);
