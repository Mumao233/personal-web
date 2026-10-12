// A small integration layer leaves the archived application and its navigation
// intact. The personal homepage is an ordinary same-tab link.
const makeReturn = () => {
  const link = document.createElement('a');
  link.className = 'personal-return';
  link.href = '/';
  link.textContent = '← 个人主页';
  link.setAttribute('aria-label', '返回林珈诚的个人主页');
  return link;
};
const fallback = makeReturn();
fallback.classList.add('personal-return--fallback');
document.body.append(fallback);
function connect() {
  const navs = [...document.querySelectorAll('.topbar__left, .mobilebar')];
  for (const nav of navs) {
    if (!nav.querySelector(':scope > .personal-return')) nav.prepend(makeReturn());
  }
  const visible = navs.some(nav => nav.getBoundingClientRect().height > 0 && getComputedStyle(nav).display !== 'none');
  fallback.hidden = visible;
}
const observer = new MutationObserver(connect);
observer.observe(document.getElementById('root'), { childList: true, subtree: true });
window.addEventListener('resize', connect, { passive: true });
window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
connect();
