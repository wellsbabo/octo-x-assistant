// Optional real-Chromium smoke test. npm install --no-save playwright, then run this file.
// Uses a disposable profile; X/xAI credentials and live network calls are not needed.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'octo-ui-'));
let context;
const checks = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(), viewport: {width: 390, height: 980},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
  const id = new URL(worker.url()).host;
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  if (manifest.key) {
    const expectedId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
    assert.equal(id, expectedId);
    checks.push('Extension ID matches the fixed public manifest key');
  }
  assert.equal(await worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick), true);
  checks.push('Toolbar action is configured to open Side Panel');
  const page = await context.newPage(); const errors = [], externalRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  context.on('request', r => { if (/^https:\/\/api\.(x\.com|x\.ai|openai\.com)/.test(r.url())) externalRequests.push(r.url()); });
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.locator('#empty').waitFor({state: 'visible'});
  checks.push('Initial empty state');
  await page.locator('#demo').click();
  await page.waitForFunction(() => document.querySelector('#author').textContent === '빌더 민');
  assert.equal(await page.locator('#remaining').textContent(), '3개 대기 중');
  assert.match(await page.locator('#summary').textContent(), /30분/);
  checks.push('Demo loads through actual MV3 worker');
  // Intercept only the clipboard write; verify the exact payload from the user click.
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', {value: async text => { window.copiedText = text; }}); });
  await page.locator('#draft').fill('직접 수정했어요 ㅋㅋㅋ');
  await page.locator('#copy').click();
  await page.waitForFunction(() => document.querySelector('#copy-state').textContent.includes('복사했어요'));
  assert.equal(await page.evaluate(() => window.copiedText), '직접 수정했어요 ㅋㅋㅋ');
  checks.push('Immediate edit → copy persists exact edited text');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#draft').value === '직접 수정했어요 ㅋㅋㅋ');
  await page.locator('#next').click();
  await page.waitForFunction(() => document.querySelector('#author').textContent === '하루의 도구');
  checks.push('Draft persistence and next post');
  if (process.env.OCTO_SCREENSHOTS) {
    await fs.mkdir(process.env.OCTO_SCREENSHOTS, {recursive: true});
    await page.screenshot({path: path.join(process.env.OCTO_SCREENSHOTS, 'sidepanel-preview.png'), fullPage: true});
  }
  const metrics = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, width: innerWidth}));
  assert.ok(metrics.scroll <= metrics.width);
  checks.push('390px panel has no horizontal overflow');
  await page.locator('#demo').click();
  await page.locator('#empty').waitFor({state: 'visible'});
  await page.locator('#collect').click();
  await page.locator('#error').waitFor({state: 'visible'});
  assert.match(await page.locator('#error').textContent(), /X 계정/);
  checks.push('Unconfigured collection shows actionable error');

  const options = await context.newPage();
  options.on('pageerror', e => errors.push(e.message));
  await options.setViewportSize({width: 1000, height: 1000});
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#model').value.length > 0);
  assert.equal(await options.locator('#redirectUri').inputValue(), `https://${id}.chromiumapp.org/oauth2`);
  assert.equal(await options.locator('#provider').inputValue(), 'openai');
  assert.equal(await options.locator('#model').inputValue(), 'gpt-6-luna');
  await options.locator('#openaiApiKey').fill('sk-test-only');
  await options.locator('#provider').selectOption('xai');
  await options.locator('#xai-key-group').waitFor({state: 'visible'});
  assert.equal(await options.locator('#model').inputValue(), 'grok-4.3');
  await options.locator('#apiKey').fill('xai-ui-test');
  await options.locator('#provider').selectOption('openai');
  assert.equal(await options.locator('#model').inputValue(), 'gpt-6-luna');
  assert.equal(await options.locator('#inputRate').inputValue(), '0.1');
  assert.equal(await options.locator('#outputRate').inputValue(), '0.5');
  checks.push('Provider switch restores model presets and keeps OpenAI/xAI keys separate');
  await options.locator('#replyPrompt').fill('감탄사 없이 원문의 구체적인 내용에 한 문장으로 반응하세요.');
  await options.locator('#keywords').fill('자동화\nAI\n새로운 도구');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#save-state').textContent.includes('저장했습니다'));
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#keywords').value.includes('새로운 도구'));
  assert.equal(await options.locator('#openaiApiKey').inputValue(), 'sk-test-only');
  assert.equal(await options.locator('#apiKey').inputValue(), 'xai-ui-test');
  assert.equal(await options.locator('#replyPrompt').inputValue(), '감탄사 없이 원문의 구체적인 내용에 한 문장으로 반응하세요.');
  await options.waitForFunction(() => document.querySelector('#sync-state').textContent.includes('Chrome 동기화 저장소 반영'));
  const synced = await worker.evaluate(async () => {
    const data = await chrome.storage.sync.get(null); return JSON.stringify(data);
  });
  assert.ok(synced.includes('감탄사')); assert.ok(!synced.includes('sk-test-only')); assert.ok(!synced.includes('xai-ui-test'));
  checks.push('Shared instructions are stored in Chrome Sync without API keys');
  checks.push('Options save and reload through actual extension storage, including editable reply instructions');
  if (process.env.OCTO_SCREENSHOTS) await options.screenshot({path: path.join(process.env.OCTO_SCREENSHOTS, 'settings-preview.png'), fullPage: true});
  // Keywords are required; whitespace exercises worker validation rather than browser validation.
  await options.locator('#keywords').fill('  ');
  await options.locator('#save').click();
  await options.locator('#error').waitFor({state: 'visible'});
  assert.match(await options.locator('#error').textContent(), /키워드/);
  checks.push('Invalid settings show validation error');
  await options.locator('#stats-tab').click();
  await options.locator('#stats-view').waitFor({state: 'visible'});
  assert.equal(await options.locator('#month-matched').textContent(), '0');
  assert.equal(await options.locator('#month-reviewed').textContent(), '0');
  checks.push('Monthly stats exclude demo data');
  await options.setViewportSize({width: 360, height: 900});
  await options.locator('#settings-tab').click();
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  checks.push('360px options has no horizontal overflow');
  // Exercise diagnosis with dummy local credentials and mocked worker fetch only.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({auth: {accessToken: 'dummy-access', refreshToken: 'dummy-refresh',
      expiresAt: Date.now() + 3600000, user: null, tokenType: 'bearer', scopes: ['tweet.read', 'users.read', 'offline.access']}});
    globalThis.fetch = async () => new Response(JSON.stringify({title: 'Unauthorized', detail: 'dummy-access'}),
      {status: 401, headers: {'www-authenticate': 'Bearer error="invalid_token"'}});
  });
  await options.reload();
  await options.locator('#check-connection').waitFor();
  await options.waitForFunction(() => !document.querySelector('#check-connection').disabled);
  await options.locator('#check-connection').click();
  await options.locator('#diagnostic-section').waitFor({state: 'visible'});
  const report = await options.locator('#diagnostic').inputValue();
  assert.match(report, /HTTP 401/); assert.match(report, /invalid_token/); assert.ok(!report.includes('dummy-access'));
  checks.push('Connection diagnosis renders safe endpoint results through actual worker');
  await options.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {value: async text => { window.copiedDiagnostic = text; }}));
  await options.locator('#copy-diagnostic').click();
  assert.equal(await options.evaluate(() => window.copiedDiagnostic), report);
  checks.push('Safe diagnostic report can be copied');
  await worker.evaluate(async () => {
    const {db} = await chrome.storage.local.get('db');
    db.demo = false;
    db.queue = [{id: '123', name: '테스트 작성자', username: 'sample', text: 'AI 도구로 시간을 절약했어요.', generated: false, draft: '', source: 'search'}];
    await chrome.storage.local.set({db});
    globalThis.fetch = async (url, init) => {
      if (new URL(url).host !== 'api.openai.com') throw new Error('Unexpected provider');
      const body = JSON.parse(init.body);
      if (body.model !== 'gpt-6-luna' || body.reasoning.effort !== 'none' || !body.text.format.strict) throw new Error('Unexpected request');
      return new Response(JSON.stringify({status: 'completed', usage: {input_tokens: 100, output_tokens: 30},
        output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify({summary: 'AI 도구로 시간을 아낀 글입니다.', reply: '반복 작업이 줄면 다른 일에 집중하기 좋겠네요.'})}]}]}), {status: 200});
    };
  });
  await page.waitForFunction(() => document.querySelector('#author').textContent === '테스트 작성자');
  await page.locator('#regenerate').click();
  await page.waitForFunction(() => document.querySelector('#draft').value.includes('반복 작업이 줄면'));
  assert.match(await page.locator('#generation-model').textContent(), /gpt-6-luna/);
  assert.ok(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('db')).db.stats).some(s => s.openaiCost > 0)));
  checks.push('GPT generation uses the selected provider and renders summary, draft, model and costs');
  await options.evaluate(async () => {
    const {writeShared} = await import(chrome.runtime.getURL('sync.js'));
    const {settings} = await chrome.storage.local.get('settings');
    await writeShared(chrome.storage.sync, {...settings, replyPrompt: '다른 기기에서 받은 지침', keywords: ['공유키워드']});
  });
  await options.waitForFunction(() => document.querySelector('#replyPrompt').value === '다른 기기에서 받은 지침');
  assert.equal(await options.locator('#keywords').inputValue(), '공유키워드');
  assert.equal(await options.locator('#openaiApiKey').inputValue(), 'sk-test-only');
  checks.push('Chrome Sync change events update shared settings while preserving local credentials');
  const pageCount = context.pages().length;
  await worker.evaluate(() => {
    chrome.tabs.query = async () => [{id: 987}];
    chrome.tabs.update = async (tabId, details) => {globalThis.originalTarget = {tabId, ...details};};
  });
  await page.locator('#original').click();
  await page.waitForFunction(() => !document.querySelector('#next').disabled);
  assert.deepEqual(await worker.evaluate(() => globalThis.originalTarget), {tabId: 987, url: 'https://x.com/i/status/123'});
  assert.equal(context.pages().length, pageCount);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  checks.push('Dark panel opens the original in the active tab without creating a new tab');
  await options.evaluate(async () => {
    const {migrateXAccounting, localDay} = await import(chrome.runtime.getURL('core.js'));
    const {db} = await chrome.storage.local.get('db');
    Object.assign(db.stats[localDay()], {xCost: 0.375, postUnits: 25, userUnits: 25});
    delete db.xAccountingVersion;
    migrateXAccounting(db);
    await chrome.storage.local.set({db});
  });
  await page.waitForFunction(() => document.querySelector('#cost-label').textContent.includes('이전 X 제외'));
  assert.match(await page.locator('#cost').textContent(), /^\$/);
  assert.match(await page.locator('#cost-detail').textContent(), /전체 비용은 아직 미확정/);
  await options.reload();
  await options.locator('#stats-tab').click();
  await options.locator('#billing-review').waitFor({state: 'visible'});
  assert.match(await options.locator('#month-cost').textContent(), /^\$/);
  assert.match(await options.locator('#month-cost-label').textContent(), /이전 X 제외/);
  checks.push('Known cost subtotal remains visible while excluded legacy X costs are clearly disclosed');
  await options.locator('#x-baseline').fill('0.14');
  await options.locator('#apply-baseline').click();
  await options.locator('#billing-review').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#cost-label').textContent === '예상 비용');
  assert.match(await options.locator('#baseline-state').textContent(), /0.1400/);
  assert.match(await options.locator('#cost-ledger').textContent(), /오늘 X 콘솔 금액 반영/);
  assert.equal(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('db')).db.stats).find(s => s.xBaseline)?.xBaseline.amount), 0.14);
  await options.setViewportSize({width: 1000, height: 1000});
  if (process.env.OCTO_SCREENSHOTS) await options.screenshot({path: path.join(process.env.OCTO_SCREENSHOTS, 'billing-preview.png'), fullPage: true});
  checks.push('Manual console baseline updates totals and request ledger without an API call');
  await options.locator('#settings-tab').click();
  await options.locator('summary').filter({hasText: '기존 버전에서 한 번만'}).click();
  const recordsDownloadPromise = options.waitForEvent('download');
  await options.locator('#export-records').click();
  const recordsDownload = await recordsDownloadPromise;
  const records = JSON.parse(await fs.readFile(await recordsDownload.path(), 'utf8'));
  assert.equal(records.format, 'octo-records');
  assert.ok(!JSON.stringify(records).includes('sk-test-only')); assert.ok(!JSON.stringify(records).includes('dummy-access'));
  checks.push('Migration record backup downloads without API keys or OAuth credentials');
  await options.locator('#stats-tab').click();
  await worker.evaluate(async () => {
    const {db} = await chrome.storage.local.get('db');
    db.archivedCandidates = [{id: '321', text: '이전 대기 글', draft: '보존할 수정 초안'}];
    await chrome.storage.local.set({db});
  });
  await options.locator('#archive-section').waitFor({state: 'visible'});
  const downloadPromise = options.waitForEvent('download');
  await options.locator('#export-archive').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'octo-previous-candidates.json');
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(backup.posts[0].draft, '보존할 수정 초안');
  assert.ok(!JSON.stringify(backup).includes('dummy-access'));
  checks.push('Archived candidates can be downloaded with edited drafts and without auth credentials');
  await options.evaluate(async () => {
    const {localDay} = await import(chrome.runtime.getURL('core.js'));
    const {db} = await chrome.storage.local.get('db');
    Object.assign(db.stats[localDay()], {read: 200, matched: 12, reviewed: 4});
    db.stats['2000-01-01'] = {matched: 99, reviewed: 99, read: 999};
    await chrome.storage.local.set({db});
  });
  await page.waitForFunction(() => document.querySelector('#reviewed').textContent === '4');
  assert.equal(await page.locator('#matched').textContent(), '12');
  await options.waitForFunction(() => document.querySelector('#month-reviewed').textContent === '4');
  assert.equal(await options.locator('#month-matched').textContent(), '12');
  const dailyCells = await options.locator('#daily tr').first().locator('td').allTextContents();
  assert.equal(dailyCells[1], '12'); assert.equal(dailyCells[2], '4');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#reviewed').textContent === '4');
  assert.equal(await page.locator('#matched').textContent(), '12');
  if (process.env.OCTO_SCREENSHOTS) {
    await page.screenshot({path: path.join(process.env.OCTO_SCREENSHOTS, 'sidepanel-preview.png'), fullPage: true});
    await options.screenshot({path: path.join(process.env.OCTO_SCREENSHOTS, 'billing-preview.png'), fullPage: true});
  }
  checks.push('Today and month show collected and reviewed counts, exclude old dates, and survive page reload');
  await page.locator('#exclude-post').click();
  await page.locator('#empty').waitFor({state: 'visible'});
  assert.ok(await worker.evaluate(async () => (await chrome.storage.local.get('db')).db.excludedPosts.includes('123')));
  await worker.evaluate(async () => {
    const {db} = await chrome.storage.local.get('db');
    db.queue = [{id: '456', authorId: '22', username: 'exclude_me', name: '제외 대상', text: '테스트', draft: ''},
      {id: '457', authorId: '22', username: 'exclude_me', name: '제외 대상', text: '테스트2', draft: ''}];
    await chrome.storage.local.set({db});
  });
  await page.waitForFunction(() => document.querySelector('#author').textContent === '제외 대상');
  await page.locator('#exclude-author').click();
  await page.locator('#empty').waitFor({state: 'visible'});
  await options.waitForFunction(() => document.querySelector('#excludedAuthors').value.includes('id:22'));
  assert.ok(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.excludedAuthors.includes('id:22')));
  checks.push('Post and author exclusion buttons persist exclusions and remove matching queued posts');
  await worker.evaluate(async () => {await chrome.storage.local.remove('db');});
  await options.locator('#settings-tab').click();
  await options.locator('#records-file').setInputFiles({name: 'octo-records-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(records))});
  await options.waitForFunction(() => document.querySelector('#save-state').textContent.includes('기록을 복원했습니다'));
  const restoredRecord = await worker.evaluate(async () => (await chrome.storage.local.get('db')).db);
  assert.deepEqual(restoredRecord.stats, records.db.stats);
  assert.equal(await options.locator('#openaiApiKey').inputValue(), 'sk-test-only');
  checks.push('Migration backup imports into empty storage and preserves local API keys and historical statistics');
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  checks.push('No page errors and no paid API calls');
  console.log(JSON.stringify({passed: checks.length, checks}, null, 2));
} finally {
  await context?.close(); await fs.rm(profile, {recursive: true, force: true});
}
