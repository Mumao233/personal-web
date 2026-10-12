import { GestureEngine, CameraSession } from './gesture-engine.js';

const shell = document.createElement('section');
shell.className = 'gesture-control';
shell.setAttribute('aria-label', '摄像头手势控制');
shell.innerHTML = `
  <button class="gesture-trigger" type="button" aria-expanded="false" aria-controls="gesture-panel"><span aria-hidden="true">✧</span> 手势控制 <span class="gesture-badge">关闭</span></button>
  <div id="gesture-panel" class="gesture-panel" hidden>
    <div class="gesture-heading"><div><p>用双手探索</p><span>HAND CONTROL</span></div><button class="gesture-collapse" type="button" aria-label="收起手势面板">−</button></div>
    <label class="gesture-switch"><span>摄像头手势</span><input id="gesture-enabled" type="checkbox" role="switch" aria-describedby="gesture-privacy"><span class="gesture-switch-track" aria-hidden="true"></span></label>
    <p id="gesture-status" class="gesture-status" role="status" aria-live="polite">默认关闭。开启后才会请求摄像头。</p>
    <div class="gesture-preview" hidden><video muted playsinline aria-label="仅在此设备处理的摄像头预览"></video><span>本机识别 · 不上传画面</span></div>
    <div class="gesture-modes" role="group" aria-label="单手操作方式"><button type="button" data-mode="rotate" aria-pressed="true">旋转</button><button type="button" data-mode="pan" aria-pressed="false">平移</button><button type="button" data-mode="select" aria-pressed="false">选择</button></div>
    <p class="gesture-guide">拇指与食指捏合并移动，可旋转视角；松开即停。双手同时捏合，拉开／靠拢可缩放。</p>
    <p id="gesture-privacy" class="gesture-privacy">画面仅在浏览器本机处理，不保存、不上传。关闭或离开页面即停止摄像头。按 Esc 也可关闭。</p>
  </div>`;
document.body.append(shell);
const cursor = document.createElement('div'); cursor.className = 'gesture-cursor'; cursor.hidden = true; cursor.setAttribute('aria-hidden', 'true'); document.body.append(cursor);
const trigger = shell.querySelector('.gesture-trigger'), panel = shell.querySelector('.gesture-panel');
const toggle = shell.querySelector('#gesture-enabled'), video = shell.querySelector('video');
const status = shell.querySelector('.gesture-status'), preview = shell.querySelector('.gesture-preview');
const badge = shell.querySelector('.gesture-badge'), guide = shell.querySelector('.gesture-guide');
const engine = new GestureEngine();
const dispatch = detail => window.dispatchEvent(new CustomEvent('atlas-gesture', { detail }));
const supported = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
const stateText = { off: '默认关闭。开启后才会请求摄像头。', requesting: '请在浏览器中允许摄像头；也可随时关闭开关。', loading: '正在本机加载手部模型，首次开启可能需要片刻…', ready: '已开启。将手放入镜头，保持光线充足。', paused: '页面已离开前台，摄像头已关闭。需要时可手动重新开启。' };
let previousStatus = '', selectedUntil = 0;
function setStatus(text) { if (text !== previousStatus) { status.textContent = text; previousStatus = text; } }

function createTracker() {
  const worker = new Worker(new URL('./gesture-worker.js', import.meta.url));
  let closed = false, pending = null, initResolve, initReject, initTimer;
  const ready = new Promise((resolve, reject) => { initResolve = resolve; initReject = reject; });
  const fail = error => { clearTimeout(initTimer); initReject(error); if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { clearTimeout(initTimer); initResolve(); }
    else if (data.type === 'result' && pending) { clearTimeout(pending.timer); pending.resolve(data); pending = null; }
    else if (data.type === 'error') fail(new Error(data.message));
  };
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message)); };
  initTimer = setTimeout(() => fail(new Error('Model initialization timeout')), 45000);
  worker.postMessage({ type: 'init' });
  return {
    ready,
    async detect(source, timestamp) {
      const bitmap = await createImageBitmap(source);
      if (closed) { bitmap.close(); throw new Error('Stopped'); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(new Error('Hand tracker frame timeout')); }, 5000);
        pending = { resolve, reject, timer };
        worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
      });
    },
    close() { closed = true; fail(new Error('Stopped')); worker.terminate(); },
  };
}

const session = new CameraSession({
  video, getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints), createTracker,
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  onState(state, message) {
    const enabled = ['requesting', 'loading', 'ready'].includes(state);
    toggle.checked = enabled; badge.textContent = enabled ? '开启' : '关闭';
    shell.dataset.enabled = String(enabled); preview.hidden = !enabled || state === 'requesting';
    if (!enabled) { cursor.hidden = true; engine.reset(); dispatch({ action: 'release' }); }
    if (state === 'ready') dispatch({ action: 'activate' });
    setStatus(message || stateText[state] || stateText.off);
  },
  onResult(result, time) {
    const output = engine.update(result.landmarks, time);
    cursor.hidden = !output.cursor;
    if (output.cursor) {
      cursor.style.left = `${output.cursor.x * 100}%`; cursor.style.top = `${output.cursor.y * 100}%`;
      cursor.style.setProperty('--progress', `${Math.round(output.progress * 360)}deg`);
      cursor.dataset.active = String(['rotate', 'pan', 'select'].includes(output.kind));
    }
    for (const command of output.commands) {
      if (command.action === 'select') {
        const x = command.x * innerWidth, y = command.y * innerHeight;
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('button, input, a, .gesture-panel, .archive, .mobilemenu, .hall')) {
          setStatus('请将光点移到星体上；面板按钮仍用鼠标或触屏操作。'); selectedUntil = performance.now() + 1800;
        } else window.dispatchEvent(new CustomEvent('atlas-gesture-select', { detail: { x, y } }));
      } else dispatch(command);
    }
    if (performance.now() < selectedUntil) return;
    const messages = { lost: '未识别到手。请把手放回镜头，当前视角已停止。', zoom: '双手缩放中 · 松开捏合即可停止', rotate: '旋转中 · 松开捏合即可停止', pan: '平移中 · 松开捏合即可停止', select: '保持捏合片刻确认目标；松开后可重新选择。', point: engine.mode === 'select' ? '将光点对准星体，捏合并保持约 0.7 秒进行选择。' : '已识别到手。捏合拇指与食指，再移动手来操作。' };
    setStatus(messages[output.kind]);
  },
});
trigger.addEventListener('click', () => { panel.hidden = !panel.hidden; trigger.setAttribute('aria-expanded', String(!panel.hidden)); });
shell.querySelector('.gesture-collapse').addEventListener('click', () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); });
toggle.addEventListener('change', () => {
  if (!toggle.checked) { session.stop(); return; }
  if (!supported()) { session.stop('error', window.isSecureContext ? '当前浏览器不支持本机手势识别，请使用最新版 Chrome 或 Edge。' : '摄像头需要 HTTPS 或 localhost。普通 HTTP 网址无法开启。'); return; }
  session.start();
});
shell.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  engine.setMode(button.dataset.mode); dispatch({ action: 'release' });
  shell.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  guide.textContent = { rotate: '拇指与食指捏合并移动，可旋转视角；松开即停。双手同时捏合，拉开／靠拢可缩放。', pan: '单手捏合并移动，可平移画面；松开即停。双手同时捏合，拉开／靠拢可缩放。', select: '移动食指控制光点，对准星体后捏合并保持约 0.7 秒确认。松开后才能再次选择；双手捏合可缩放。' }[button.dataset.mode];
}));
window.addEventListener('atlas-gesture-result', ({ detail }) => { if (!session.active) return; setStatus(detail.selected ? '已选择目标。松开捏合可继续探索。' : '此处没有可选目标，请对准星体或轨道标记。'); selectedUntil = performance.now() + 1800; });
document.addEventListener('visibilitychange', () => { if (document.hidden && session.active) session.stop('paused'); });
window.addEventListener('pagehide', () => session.stop());
window.addEventListener('beforeunload', () => session.stop());
window.addEventListener('keydown', event => { if (event.key === 'Escape' && session.active) session.stop(); });

// No restore from storage: every page load deliberately starts with the switch OFF.
toggle.checked = false;
