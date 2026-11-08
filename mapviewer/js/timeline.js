// Overview scrubber (whole map) and an editor-style zoomed rhythm strip.

const SNAP_COLOURS = {
  1: '#ffffff', 2: '#ff4d6a', 3: '#b46cff', 4: '#4da3ff', 6: '#c48bff', 8: '#ffd84d', 12: '#9a7dff', 16: '#8a8a8a',
};

function snapColour(i, divisor) {
  // Which fraction of the beat does tick i land on?
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16]) {
    if (divisor % d === 0 && (i * d) % divisor === 0) return { col: SNAP_COLOURS[d], d };
  }
  return { col: '#888', d: divisor };
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

export class Overview {
  constructor(canvas, onSeek) {
    this.cv = canvas;
    this.onSeek = onSeek;
    this.hover = null;
    this.bg = document.createElement('canvas');
    let dragging = false;
    const timeAt = e => {
      const r = this.cv.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      return this.min + f * (this.max - this.min);
    };
    canvas.addEventListener('pointerdown', e => { if (!this.map) return; dragging = true; canvas.setPointerCapture(e.pointerId); this.onSeek(timeAt(e), true); });
    canvas.addEventListener('pointermove', e => {
      if (!this.map) return;
      this.hover = { t: timeAt(e), x: e.clientX - canvas.getBoundingClientRect().left };
      if (dragging) this.onSeek(this.hover.t, true);
    });
    canvas.addEventListener('pointerup', e => { if (dragging) { dragging = false; this.onSeek(timeAt(e), false); } });
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
  }

  setMap(map, beatmap, min, max, colours) {
    this.map = map; this.beatmap = beatmap; this.min = min; this.max = max; this.colours = colours;
    this.render();
  }

  render() {
    if (!this.map) return;
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.bg.width = Math.max(1, Math.round(r.width * dpr));
    this.bg.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = this.bg.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height;
    const X = t => (t - this.min) / (this.max - this.min) * w;
    ctx.clearRect(0, 0, w, h);
    // kiai
    ctx.fillStyle = 'rgba(255, 170, 60, 0.16)';
    for (const k of this.map.timing.kiai) ctx.fillRect(X(k.start), 0, Math.max(1, X(Math.min(k.end, this.max)) - X(k.start)), h);
    // breaks
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (const b of this.beatmap.breaks) ctx.fillRect(X(b.start), 0, X(b.end) - X(b.start), h);
    // density histogram
    const bins = Math.max(1, Math.floor(w / 2));
    const counts = new Float32Array(bins);
    for (const o of this.map.objects) {
      const i = Math.min(bins - 1, Math.max(0, Math.floor((o.time - this.min) / (this.max - this.min) * bins)));
      counts[i] += 1;
    }
    let maxC = 1;
    for (const c of counts) maxC = Math.max(maxC, c);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let i = 0; i < bins; i++) {
      if (!counts[i]) continue;
      const bh = Math.max(1.5, Math.sqrt(counts[i] / maxC) * (h - 6));
      ctx.fillRect(i * (w / bins), h - bh, Math.max(1, w / bins - 0.5), bh);
    }
    // timing changes (red ticks)
    ctx.fillStyle = 'rgba(255,77,106,0.8)';
    for (const p of this.map.timing.red) ctx.fillRect(X(p.time), 0, 1, 4);
    // bookmarks
    const bms = (this.beatmap.editor.Bookmarks || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
    ctx.fillStyle = 'rgba(77,163,255,0.9)';
    for (const b of bms) ctx.fillRect(X(b), 0, 1.5, h);
  }

  draw(t) {
    const { ctx, w, h } = this._ctx && this._w === this.cv.clientWidth ? this._ctx : (this._ctx = setupCanvas(this.cv), this._w = this.cv.clientWidth, this._ctx);
    ctx.clearRect(0, 0, w, h);
    if (!this.map) return;
    ctx.drawImage(this.bg, 0, 0, w, h);
    const x = (t - this.min) / (this.max - this.min) * w;
    ctx.fillStyle = 'rgba(255,102,170,0.18)';
    ctx.fillRect(0, 0, x, h);
    ctx.fillStyle = '#ff66aa';
    ctx.fillRect(x - 1, 0, 2, h);
    if (this.hover) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(this.hover.x, 0, 1, h);
    }
  }

  invalidate() { this._ctx = null; this.render(); }
}

export class RhythmStrip {
  constructor(canvas, onSeek) {
    this.cv = canvas;
    this.onSeek = onSeek;
    this.window = 2500; // ms visible across the strip
    this.divisor = 4;
    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      if (!this.map) return;
      drag = { x: e.clientX, t: this.t };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const w = canvas.clientWidth;
      this.onSeek(drag.t - (e.clientX - drag.x) / w * this.window, true);
    });
    canvas.addEventListener('pointerup', () => { if (drag) { drag = null; this.onSeek(this.t, false); } });
    canvas.addEventListener('wheel', e => {
      if (!this.map || !e.ctrlKey) return;
      e.preventDefault();
      this.window = Math.max(500, Math.min(12000, this.window * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
  }

  setMap(map, colours) { this.map = map; this.colours = colours; }

  draw(t) {
    this.t = t;
    const { ctx, w, h } = this._ctx && this._w === this.cv.clientWidth ? this._ctx : (this._ctx = setupCanvas(this.cv), this._w = this.cv.clientWidth, this._ctx);
    ctx.clearRect(0, 0, w, h);
    if (!this.map) return;
    const half = this.window / 2;
    const t0 = t - half, t1 = t + half;
    const X = tt => (tt - t0) / this.window * w;
    const { timing, objects } = this.map;

    // kiai shading
    ctx.fillStyle = 'rgba(255,170,60,0.10)';
    for (const k of timing.kiai) if (k.end > t0 && k.start < t1) ctx.fillRect(X(k.start), 0, X(Math.min(k.end, t1 + 1)) - X(k.start), h);

    // beat snap ticks
    const red = timing.red;
    for (let i = 0; i < red.length; i++) {
      const p = red[i];
      const segEnd = i + 1 < red.length ? red[i + 1].time : Infinity;
      if (segEnd < t0 || p.time > t1) continue;
      const step = p.beatLength / this.divisor;
      if (step * w / this.window < 2) continue;
      let k = Math.max(0, Math.ceil((t0 - p.time) / step));
      for (;; k++) {
        const tt = p.time + k * step;
        if (tt > t1 || tt >= segEnd - 1) break;
        const { col, d } = snapColour(k % this.divisor, this.divisor);
        const beatIdx = Math.floor(k / this.divisor);
        const downbeat = k % this.divisor === 0 && beatIdx % (p.meter || 4) === 0;
        const th = downbeat ? h : d === 1 ? h * 0.62 : d <= 2 ? h * 0.45 : h * 0.3;
        ctx.globalAlpha = downbeat ? 0.9 : 0.6;
        ctx.fillStyle = col;
        ctx.fillRect(Math.round(X(tt)) - 0.5, h - th, downbeat ? 2 : 1, th);
      }
      ctx.globalAlpha = 1;
      // red line marker
      if (p.time >= t0 && p.time <= t1) { ctx.fillStyle = '#ff4d6a'; ctx.fillRect(X(p.time) - 1, 0, 2, 5); }
    }

    // objects
    const cy = h * 0.42, r = Math.min(h * 0.24, 9);
    const cols = this.colours;
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.endTime < t0 - 50 || o.time > t1 + 50) continue;
      const col = cols[((o.colorIndex % cols.length) + cols.length) % cols.length];
      const x = X(o.time);
      if (o.kind === 'spinner') {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x, cy - r * 0.6, X(o.endTime) - x, r * 1.2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      if (o.kind === 'slider') {
        const xe = X(o.endTime);
        ctx.strokeStyle = rgb(col);
        ctx.globalAlpha = 0.45;
        ctx.lineCap = 'round';
        ctx.lineWidth = r * 2;
        ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(xe, cy); ctx.stroke();
        ctx.globalAlpha = 1;
        for (let s = 1; s <= o.spans; s++) {
          const xs = X(o.time + s * o.spanDuration);
          ctx.fillStyle = s === o.spans ? 'rgba(255,255,255,0.85)' : '#fff';
          ctx.beginPath(); ctx.arc(xs, cy, s === o.spans ? r * 0.55 : r * 0.4, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.fillStyle = rgb(col);
      ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = o.newCombo ? '#fff' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = o.newCombo ? 2 : 1;
      ctx.stroke();
    }

    // playhead
    ctx.fillStyle = '#ff66aa';
    ctx.fillRect(w / 2 - 1, 0, 2, h);
  }

  invalidate() { this._ctx = null; }
}
