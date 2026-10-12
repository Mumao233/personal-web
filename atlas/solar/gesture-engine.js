// Camera-independent gesture interpretation. All distances are normalized by palm width.
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class GestureEngine {
  constructor() { this.mode = 'rotate'; this.reset(); }
  reset() {
    this.last = null;
    this.pinched = false;
    this.zoomDistance = null;
    this.selection = null;
    this.selectionFired = false;
  }
  setMode(mode) {
    if (!['rotate', 'pan', 'select'].includes(mode)) return;
    this.mode = mode;
    this.reset();
  }
  update(hands, now) {
    const valid = (hands || []).filter(h => h?.length === 21 && h.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    if (!valid.length) { this.reset(); return { kind: 'lost', commands: [{ action: 'release' }] }; }
    const measures = valid.map(h => {
      const palm = Math.max(distance(h[5], h[17]), distance(h[0], h[9]) * .65, .025);
      return { position: { x: 1 - h[8].x, y: h[8].y }, ratio: distance(h[4], h[8]) / palm };
    });
    if (measures.length >= 2 && measures.every(h => h.ratio < .45)) {
      const spread = distance(measures[0].position, measures[1].position);
      const commands = [{ action: 'release' }];
      if (this.zoomDistance && spread > .05) {
        const scale = clamp(spread / this.zoomDistance, .92, 1.08);
        if (Math.abs(scale - 1) > .006) commands.push({ action: 'zoom', scale });
      }
      this.zoomDistance = spread;
      this.last = null; this.selection = null; this.selectionFired = false; this.pinched = false;
      return { kind: 'zoom', commands };
    }
    if (this.zoomDistance !== null) this.reset();
    const hand = measures[0];
    const pinch = hand.ratio < (this.pinched ? .45 : .3);
    const cursor = this.last ? {
      x: this.last.x + (hand.position.x - this.last.x) * .38,
      y: this.last.y + (hand.position.y - this.last.y) * .38,
    } : hand.position;
    cursor.x = clamp(cursor.x, .015, .985); cursor.y = clamp(cursor.y, .015, .985);
    const commands = [];
    if (!pinch) {
      commands.push({ action: 'release' }); this.selection = null; this.selectionFired = false;
    } else if (this.mode === 'select') {
      if (!this.selection || distance(this.selection.position, cursor) > .035) this.selection = { position: { ...cursor }, since: now };
      if (!this.selectionFired && now - this.selection.since >= 650) {
        commands.push({ action: 'select', x: cursor.x, y: cursor.y }); this.selectionFired = true;
      }
    } else if (this.pinched && this.last) {
      let dx = cursor.x - this.last.x, dy = cursor.y - this.last.y;
      // Tracking jumps re-anchor instead of flinging the scene. Small jitter is ignored.
      if (Math.hypot(dx, dy) < .09) {
        dx = Math.abs(dx) < .0012 ? 0 : clamp(dx, -.035, .035);
        dy = Math.abs(dy) < .0012 ? 0 : clamp(dy, -.035, .035);
        if (dx || dy) commands.push({ action: this.mode, dx, dy });
      }
    }
    this.last = cursor; this.pinched = pinch;
    return { kind: pinch ? this.mode : 'point', cursor, commands,
      progress: this.selection && !this.selectionFired ? clamp((now - this.selection.since) / 650, 0, 1) : 0 };
  }
}

export function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return '摄像头权限未允许。可在浏览器地址栏修改权限，再手动开启。';
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return '没有找到摄像头。连接摄像头后可再次开启。';
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return '摄像头暂时不可用，可能正被其他应用占用。';
  if (error?.name === 'SecurityError') return '浏览器阻止了摄像头。请通过 HTTPS 或 localhost 打开。';
  return '手势识别未能启动或已中断。请关闭后重试；鼠标和触屏仍可使用。';
}

// Explicit lifecycle owner: even a permission result arriving after OFF is stopped.
export class CameraSession {
  constructor({ video, getUserMedia, createTracker, onState, onResult, requestFrame, cancelFrame }) {
    Object.assign(this, { video, getUserMedia, createTracker, onState, onResult, requestFrame, cancelFrame });
    this.generation = 0; this.active = false; this.stream = null; this.tracker = null; this.frame = null;
  }
  async start() {
    this.stop();
    const generation = ++this.generation;
    this.active = true; this.lastFrame = -Infinity; this.lastVideoTime = -1;
    this.onState('requesting');
    try {
      const stream = await this.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } });
      if (!this.active || generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener?.('ended', () => {
        if (this.active && generation === this.generation) this.stop('error', '摄像头连接已断开。请检查设备后重新开启。');
      }, { once: true });
      this.video.srcObject = stream;
      await this.video.play();
      if (!this.active || generation !== this.generation) return;
      this.onState('loading');
      const tracker = this.createTracker(); this.tracker = tracker;
      await tracker.ready;
      if (!this.active || generation !== this.generation) return;
      this.onState('ready');
      this.frame = this.requestFrame(time => this.tick(time, generation));
    } catch (error) {
      if (this.active && generation === this.generation) this.stop('error', cameraErrorMessage(error));
    }
  }
  async tick(time, generation) {
    if (!this.active || generation !== this.generation) return;
    try {
      if (time - this.lastFrame >= 1000 / 24 && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
        this.lastFrame = time; this.lastVideoTime = this.video.currentTime;
        const result = await this.tracker.detect(this.video, time);
        if (!this.active || generation !== this.generation) return;
        this.onResult(result, time);
      }
      if (this.active && generation === this.generation) this.frame = this.requestFrame(next => this.tick(next, generation));
    } catch (error) {
      if (this.active && generation === this.generation) this.stop('error', cameraErrorMessage(error));
    }
  }
  stop(state = 'off', message) {
    this.active = false; ++this.generation;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.pause?.(); this.video.srcObject = null;
    this.tracker?.close(); this.tracker = null;
    this.onState(state, message);
  }
}
