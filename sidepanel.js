import {$, send, showError, clearError} from './ui.js';
import {money, localDay} from './core.js';
let state, busy = false, dirty = false, saveTimer, pendingSave = Promise.resolve();
function render(value) {
  const previousId = state?.current?.id;
  state = value;
  $('date').textContent = localDay().replaceAll('-', '.');
  $('matched').textContent = value.today.matched.toLocaleString();
  $('reviewed').textContent = value.today.reviewed.toLocaleString();
  const review = value.today.unverifiedXEstimate > 0;
  $('cost').textContent = money(value.today.xCost + value.today.aiCost);
  $('cost-label').textContent = review ? '예상 비용 · 이전 X 제외' : '예상 비용';
  $('cost-detail').textContent = `X ${money(value.today.xCost)} · AI ${money(value.today.aiCost)} / 한국시간 기준` +
    (review ? `\n위 금액에는 과다 계산된 이전 X 기록이 빠져 있습니다. 전체 비용은 아직 미확정입니다. 설정 → 월간 통계에서 X 콘솔 확인액을 반영할 수 있습니다.` : value.xBaseline ? '\nX는 콘솔 확인액을 수동 반영한 뒤 신규 요청을 더한 추정치입니다.' : '');
  $('connection').textContent = value.demo ? '체험 모드 · API 호출 없음' : value.account ? '@' + value.account.username + ' 연결됨' : value.connected ? 'X 연결됨 · 계정 확인 필요' : 'X 계정을 연결해주세요';
  $('demo').textContent = value.demo ? '실제 모드로' : '체험 모드';
  $('report').textContent = value.lastReport;
  $('empty').hidden = !!value.current; $('post').hidden = !value.current;
  $('empty-text').textContent = value.demo ? '체험 글을 모두 살펴봤어요. 더 가져오기를 누르면 다시 볼 수 있습니다.' : value.connected ? '더 가져오기를 누르면 타임라인과 검색에서 글을 찾습니다. 조건에 맞지 않으면 키워드를 넓혀보세요.' : '설정에서 API를 연결하거나 체험 모드로 먼저 둘러보세요.';
  if (value.current) {
    const p = value.current;
    $('source').textContent = (p.demo ? '체험 · ' : '') + (p.source === 'timeline' ? '팔로우 타임라인' : '키워드 검색');
    $('remaining').textContent = `${value.remaining}개 대기 중`;
    $('author').textContent = p.name; $('handle').textContent = p.username ? '@' + p.username : '작성자 ID ' + (p.authorId || '');
    $('verified-info').hidden = !p.authorVerified;
    $('verified-info').textContent = '인증 계정' + ({blue: ' · 파란딱지', business: ' · 기업', government: ' · 정부'}[p.verifiedType] || '');
    $('avatar').textContent = [...p.name][0]; $('post-text').textContent = p.text;
    $('original').hidden = !!p.demo;
    // Only numeric IDs from X are ever used in a navigable URL.
    if (!p.demo && /^\d+$/.test(p.id)) $('original').href = 'https://x.com/i/status/' + p.id;
    $('post-date').textContent = p.createdAt ? new Date(p.createdAt).toLocaleString('ko-KR') : '';
    $('summary').textContent = p.summary || '댓글 생성 시 요약이 함께 표시됩니다.';
    $('generation-model').textContent = p.demo ? '체험용으로 준비된 초안입니다.' : p.generatedModel ? '생성 모델: ' + p.generatedModel : p.generated ? '이전 버전에서 만든 초안 · 수정 내용은 보존됩니다.' : '생성할 모델: ' + value.settings.model;
    if (!dirty || previousId !== p.id) { $('draft').value = p.draft; dirty = false; }
    $('copy-state').textContent = p.copied ? '복사했어요 · X에서 직접 게시하세요' : '자유롭게 고쳐도 좋아요';
    $('length').textContent = [...$('draft').value].length + '자';
    $('regenerate').textContent = p.generated ? '다시 생성 ↻' : '댓글 만들기 ✦';
  }
  updateButtons();
}
function updateButtons() {
  document.querySelectorAll('button').forEach(b => b.disabled = busy || !!state?.operation);
  $('settings').disabled = false;
  $('draft').disabled = busy || !!state?.operation;
  $('copy').disabled ||= !state?.current || !$('draft').value.trim();
  $('regenerate').disabled ||= !!state?.demo;
  $('clear-queue').disabled ||= !!state?.demo || !state?.remaining;
  $('regenerate').title = state?.demo ? '체험 모드는 준비된 초안을 사용합니다.' : '선택한 AI로 새 초안을 만듭니다. 비용이 발생합니다.';
  $('collect').textContent = busy ? '처리 중…' : '＋ 더 가져오기';
  $('notice').hidden = !(busy || state?.operation);
  $('notice').textContent = '처리 중입니다. 수집이나 댓글 생성에는 잠시 시간이 걸릴 수 있어요.';
}
async function persistDraft() {
  clearTimeout(saveTimer);
  await pendingSave;
  if (!dirty || !state?.current) return;
  const id = state.current.id, text = $('draft').value;
  pendingSave = send('SAVE_DRAFT', {id, draft: text});
  try {
    await pendingSave;
    if (state?.current?.id === id && $('draft').value === text) dirty = false;
  } finally { pendingSave = Promise.resolve(); }
}
async function run(fn) {
  if (busy) return;
  busy = true; clearError(); updateButtons();
  try { await fn(); } catch (e) { showError(e); }
  finally { busy = false; updateButtons(); }
}
$('original').onclick = event => {
  event.preventDefault();
  run(async () => { await persistDraft(); await send('OPEN_ORIGINAL', {id: state.current.id}); });
};
$('exclude-post').onclick = () => run(async () => { await persistDraft(); render(await send('EXCLUDE_POST', {id: state.current.id})); });
$('exclude-author').onclick = () => run(async () => { await persistDraft(); render(await send('EXCLUDE_AUTHOR', {id: state.current.id})); });
$('settings').onclick = $('empty-settings').onclick = () => chrome.runtime.openOptionsPage();
$('draft').addEventListener('input', () => {
  dirty = true; $('length').textContent = [...$('draft').value].length + '자';
  $('copy-state').textContent = '수정 중 · 잠시 후 저장'; updateButtons();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistDraft().then(() => { if (!dirty) $('copy-state').textContent = '수정 내용을 저장했어요'; }).catch(showError), 500);
});
$('copy').onclick = () => run(async () => {
  // Invoke the clipboard directly in the click handler, before waiting on worker messages.
  const text = $('draft').value, id = state.current.id;
  try { await navigator.clipboard.writeText(text); } catch { throw new Error('클립보드 복사를 허용해주세요. 또는 댓글을 선택해 직접 복사할 수 있습니다.'); }
  await persistDraft(); render(await send('COPIED', {id}));
});
$('collect').onclick = () => run(async () => { await persistDraft(); render(await send('COLLECT')); });
$('next').onclick = () => run(async () => { await persistDraft(); render(await send('NEXT', {id: state.current.id})); });
$('regenerate').onclick = () => run(async () => { await persistDraft(); render(await send('GENERATE')); });
$('demo').onclick = () => run(async () => { await persistDraft(); render(await send('TOGGLE_DEMO')); });
$('reset').onclick = () => run(async () => { await persistDraft(); render(await send('RESET_CURSORS')); $('report').textContent = '다음 수집은 최신 글부터 시작합니다. 처리 이력은 유지됩니다.'; });
$('clear-queue').onclick = () => run(async () => {
  if (!confirm(`대기 글 ${state.remaining}개를 비울까요?
글과 초안은 백업으로 옮겨지고, 다음 수집은 최신 글부터 시작합니다.`)) return;
  await persistDraft(); render(await send('CLEAR_QUEUE'));
});
// No polling or collection timer. Updates here only read local extension state.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !busy && (changes.db || changes.auth || changes.settings)) send('GET_STATUS').then(render).catch(showError);
});
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'OPERATION_CHANGED' && !busy) send('GET_STATUS').then(render).catch(showError);
});
send('GET_STATUS').then(render).catch(showError);
