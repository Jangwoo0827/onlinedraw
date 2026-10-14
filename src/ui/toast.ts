let timer = 0;

/** 화면 아래쪽에 잠깐 떴다 사라지는 안내 */
export function showToast(message: string, ms = 2400) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(timer);
  timer = window.setTimeout(() => el!.classList.remove('show'), ms);
}
