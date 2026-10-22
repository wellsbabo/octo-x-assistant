export const $ = id => document.getElementById(id);
export async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type, ...extra});
  if (!result?.ok) throw new Error(result?.error || '확장 프로그램에 연결하지 못했습니다. 사이드바를 다시 열어주세요.');
  return result.value;
}
export function showError(error) { $('error').textContent = error?.message || String(error); $('error').hidden = false; }
export function clearError() { $('error').hidden = true; }
