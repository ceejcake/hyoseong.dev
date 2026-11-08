// Canvas renderer for osu!standard hit objects using skin sprites.
import { pathAt } from './curves.js';

const HIT_FADE = 240;   // ms explosion after an object is hit
const FP_SPACING = 32;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const easeOut = k => 1 - (1 - k) * (1 - k);

export class Renderer {
  constructor(canvas, skin) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.skin = skin;
    this.bodyCache = new Map();
    this.settings = { followPoints: true, hitAnimations: true, sliderTicks: true, beatmapColours: true };
    this.resize();
  }

  setMap(map, beatmap) {
    this.map = map;
    this.beatmap = beatmap;
    this.bodyCache.clear();
    const objs = map.objects;
    this.maxDur = 0;
    for (const o of objs) this.maxDur = Math.max(this.maxDur, o.endTime - o.time);
    // follow point connections
    this.fpPairs = [];
    for (let i = 1; i < objs.length; i++) {
      const a = objs[i - 1], b = objs[i];
      if (b.newCombo || a.kind === 'spinner' || b.kind === 'spinner') continue;
      this.fpPairs.push({ a, b });
    }
    this.updateColours();
  }

  updateColours() {
    const bmCols = this.beatmap?.colours?.map(c => c.c) || [];
    const next = this.settings.beatmapColours && bmCols.length ? bmCols : this.skin.ini.combos;
    if (JSON.stringify(next) !== JSON.stringify(this.colours)) {
      this.colours = next;
      this.bodyCache.clear();
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.dpr = dpr;
    this.scale = Math.min(r.width / 640, r.height / 480);
    this.offX = (r.width - 512 * this.scale) / 2;
    this.offY = (r.height - 384 * this.scale) / 2;
    this.bodyCache.clear();
  }

  // css px -> osu!px
  toOsu(cx, cy) { return { x: (cx - this.offX) / this.scale, y: (cy - this.offY) / this.scale }; }

  colourOf(o) { const c = this.colours; return c[((o.colorIndex % c.length) + c.length) % c.length]; }

  draw(t) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map) return;
    const s = this.dpr * this.scale;
    ctx.setTransform(s, 0, 0, s, this.dpr * this.offX, this.dpr * this.offY);

    const { objects, diff } = this.map;
    if (this.settings.showPlayfield) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeRect(0, 0, 512, 384);
    }
    if (this.settings.followPoints) this.drawFollowPoints(t);

    // last object that has started appearing
    let lo = 0, hi = objects.length - 1, upper = -1;
    const limit = t + diff.preempt;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objects[mid].time <= limit) { upper = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const earliest = t - this.maxDur - HIT_FADE - 50;
    for (let i = upper; i >= 0; i--) {
      const o = objects[i];
      if (o.time < earliest) break;
      if (o.endTime + HIT_FADE < t) continue;
      if (o.kind === 'circle') this.drawCircle(o, t, o.sx, o.sy, true);
      else if (o.kind === 'slider') this.drawSlider(o, t);
      else this.drawSpinner(o, t);
    }
  }

  sprite(sp, x, y, w, h, alpha, rot = 0) {
    if (!sp || alpha <= 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, alpha);
    if (rot) {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rot);
      ctx.drawImage(sp.img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else ctx.drawImage(sp.img, x - w / 2, y - h / 2, w, h);
    ctx.globalAlpha = 1;
  }

  fadeInAlpha(o, t) {
    const { preempt, fadeIn } = this.map.diff;
    return clamp01((t - (o.time - preempt)) / fadeIn);
  }

  drawCircle(o, t, x, y, isCircle) {
    const { preempt, fadeIn, radius } = this.map.diff;
    const appear = o.time - preempt;
    if (t < appear) return;
    const col = this.colourOf(o);
    const cscale = (radius * 2) / 128;
    let alpha = clamp01((t - appear) / fadeIn), scale = 1;
    const hit = t > o.time;
    if (hit) {
      if (!this.settings.hitAnimations) return;
      const k = (t - o.time) / HIT_FADE;
      if (k >= 1) return;
      alpha = 1 - k; scale = 1 + 0.4 * easeOut(k);
    }
    const base = this.skin.tinted('hitcircle', col);
    const overlay = (!isCircle && this.skin.get('sliderstartcircleoverlay')) || this.skin.get('hitcircleoverlay');
    const sz = cscale * scale;
    if (base) this.sprite(base, x, y, base.w * sz, base.h * sz, alpha);
    if (overlay) this.sprite(overlay, x, y, overlay.w * sz, overlay.h * sz, alpha);
    if (!hit) {
      this.drawNumber(o.comboNumber, x, y, cscale * 0.8, alpha);
      const ap = this.skin.tinted('approachcircle', col);
      if (ap) {
        const k = clamp01((t - appear) / preempt);
        const as = cscale * (4 - 3 * k);
        const aa = clamp01((t - appear) / Math.min(fadeIn * 2, preempt)) * 0.9;
        this.sprite(ap, x, y, ap.w * as, ap.h * as, aa);
      }
    }
  }

  drawNumber(n, x, y, scale, alpha) {
    const digits = String(n).split('').map(d => this.skin.get('default-' + d));
    if (digits.some(d => !d)) return;
    const overlap = this.skin.ini.hitCircleOverlap * scale;
    let total = digits.reduce((s, d) => s + d.w * scale, 0) - overlap * (digits.length - 1);
    let cx = x - total / 2;
    for (const d of digits) {
      const w = d.w * scale, h = d.h * scale;
      this.sprite(d, cx + w / 2, y, w, h, alpha);
      cx += w - overlap;
    }
  }

  drawSlider(o, t) {
    const { preempt, radius } = this.map.diff;
    const appear = o.time - preempt;
    if (t < appear) return;
    const col = this.colourOf(o);
    const cscale = (radius * 2) / 128;
    let alpha = this.fadeInAlpha(o, t);
    if (t > o.endTime) {
      if (!this.settings.hitAnimations) return;
      alpha *= 1 - clamp01((t - o.endTime) / HIT_FADE);
    }
    const ox = o.stackOff, oy = o.stackOff;

    // body
    if (alpha > 0) {
      const body = this.getBody(o);
      if (body) {
        this.ctx.globalAlpha = alpha;
        this.ctx.drawImage(body.canvas, body.x0 + ox, body.y0 + oy, body.w, body.h);
        this.ctx.globalAlpha = 1;
      }
    }
    const active = t >= o.time && t <= o.endTime;
    const span = t < o.time ? 0 : Math.min(o.spans - 1, Math.floor((t - o.time) / o.spanDuration));

    // ticks
    if (this.settings.sliderTicks && t <= o.endTime) {
      const tick = this.skin.get('sliderscorepoint');
      if (tick) for (const tk of o.ticks) {
        if (tk.span !== span || tk.time <= t) continue;
        this.sprite(tick, tk.x + ox, tk.y + oy, tick.w * cscale, tick.h * cscale, alpha);
      }
    }

    // reverse arrows
    if (o.spans > 1 && t <= o.endTime) {
      const arrow = this.skin.get('reversearrow');
      const pts = o.path.points;
      for (let s = span; s < Math.min(o.spans - 1, span + 2); s++) {
        const atEnd = s % 2 === 0;
        const p = atEnd ? pts[pts.length - 1] : pts[0];
        const q = atEnd ? pathAt(o.path, o.path.length - 3) : pathAt(o.path, 3);
        const rot = Math.atan2(q.y - p.y, q.x - p.x);
        const a = s === span ? alpha : alpha * 0.6;
        const pulse = 1 + 0.08 * (1 - ((t % 300) / 300));
        if (arrow) this.sprite(arrow, p.x + ox, p.y + oy, arrow.w * cscale * pulse, arrow.h * cscale * pulse, a, rot);
      }
    }

    // ball
    if (active) {
      const el = t - o.time;
      const sp = Math.min(o.spans - 1, Math.floor(el / o.spanDuration));
      let f = (el - sp * o.spanDuration) / o.spanDuration;
      if (sp % 2) f = 1 - f;
      const d = f * o.path.length;
      const p = pathAt(o.path, d);
      const q = pathAt(o.path, d + (sp % 2 ? -2 : 2));
      const rot = Math.atan2(q.y - p.y, q.x - p.x);
      const ball = this.skin.ini.allowSliderBallTint ? this.skin.tinted('sliderb0', col) : this.skin.get('sliderb0');
      if (ball) this.sprite(ball, p.x + ox, p.y + oy, ball.w * cscale, ball.h * cscale, 1, rot);
    }

    // head circle (drawn last so it sits on top of the body)
    this.drawCircle(o, t, o.sx, o.sy, false);
  }

  getBody(o) {
    let b = this.bodyCache.get(o);
    if (b) return b;
    const { radius } = this.map.diff;
    const pts = o.path.points;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    const pad = radius + 2;
    const x0 = minX - pad, y0 = minY - pad;
    const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
    const res = Math.min(this.dpr * this.scale, 4096 / Math.max(w, h));
    const cw = Math.max(1, Math.ceil(w * res)), ch = Math.max(1, Math.ceil(h * res));
    const mk = () => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; return c; };
    const A = mk(), B = mk();
    const trace = (ctx) => {
      ctx.beginPath();
      ctx.moveTo((pts[0].x - x0) * res, (pts[0].y - y0) * res);
      for (let i = 1; i < pts.length; i++) ctx.lineTo((pts[i].x - x0) * res, (pts[i].y - y0) * res);
      if (pts.length === 1 || (pts.length === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y))
        ctx.lineTo((pts[0].x - x0) * res + 0.01, (pts[0].y - y0) * res);
    };
    const R = radius * res;
    const shadowP = 0.078, borderP = 0.128 * 0.77;
    const ini = this.skin.ini;
    const track = ini.sliderTrack || this.colourOf(o);
    const border = ini.sliderBorder;

    const a = A.getContext('2d');
    a.lineCap = 'round'; a.lineJoin = 'round';
    trace(a);
    a.strokeStyle = 'rgba(0,0,0,0.25)'; a.lineWidth = 2 * R; a.stroke();
    a.globalCompositeOperation = 'source-over';
    a.strokeStyle = `rgb(${border})`; a.lineWidth = 2 * R * (1 - shadowP); a.stroke();
    const g = 1 - shadowP - borderP;
    a.globalCompositeOperation = 'destination-out';
    a.lineWidth = 2 * R * g; a.stroke();

    // track gradient: outer (darkened) -> inner (lightened)
    const outer = track.map(c => c / 1.1);
    const inner = track.map(c => Math.min(255, c * 1.125 + 255 * 0.25));
    const bctx = B.getContext('2d');
    bctx.lineCap = 'round'; bctx.lineJoin = 'round';
    trace(bctx);
    const N = 14;
    for (let k = 0; k < N; k++) {
      const f = k / (N - 1);
      const e = f * f * (3 - 2 * f) * 0.5 + f * 0.5;
      const c = outer.map((v, i) => Math.round(v + (inner[i] - v) * e));
      bctx.strokeStyle = `rgb(${c})`;
      bctx.lineWidth = Math.max(0.5, 2 * R * g * (1 - k / N));
      bctx.stroke();
    }
    a.globalCompositeOperation = 'source-over';
    a.globalAlpha = 0.7;
    a.drawImage(B, 0, 0);

    b = { canvas: A, x0, y0, w: cw / res, h: ch / res };
    if (this.bodyCache.size > 200) this.bodyCache.clear();
    this.bodyCache.set(o, b);
    return b;
  }

  drawSpinner(o, t) {
    const { preempt } = this.map.diff;
    const appear = o.time - Math.min(preempt, 600);
    if (t < appear || t > o.endTime + HIT_FADE) return;
    let alpha = clamp01((t - appear) / 300);
    if (t > o.endTime) alpha *= 1 - clamp01((t - o.endTime) / HIT_FADE);
    const k = 480 / 768;
    const circle = this.skin.get('spinner-circle');
    const ap = this.skin.get('spinner-approachcircle');
    const el = Math.max(0, t - o.time);
    if (circle) this.sprite(circle, 256, 192, circle.w * k, circle.h * k, alpha, el * 0.008);
    const prog = clamp01((t - o.time) / Math.max(1, o.endTime - o.time));
    if (ap && t <= o.endTime) {
      const size = (circle ? circle.w * k : 430) * (1 - prog);
      this.sprite(ap, 256, 192, size, size, alpha);
    }
  }

  drawFollowPoints(t) {
    const fp = this.skin.get('followpoint-4');
    if (!fp) return;
    const { preempt } = this.map.diff;
    const fpPreempt = 800 * Math.min(1, preempt / 450);
    const fade = 400 * Math.min(1, preempt / 450);
    // pairs are time-ordered; scan the relevant window
    const pairs = this.fpPairs;
    let lo = 0, hi = pairs.length - 1, first = pairs.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid].b.time + fade >= t) { first = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let i = first; i < pairs.length; i++) {
      const { a, b } = pairs[i];
      const startTime = a.endTime;
      if (startTime - fpPreempt > t) break;
      const sx = a.sEndX, sy = a.sEndY, ex = b.sx, ey = b.sy;
      const dx = ex - sx, dy = ey - sy;
      const distance = Math.floor(Math.hypot(dx, dy));
      if (distance < FP_SPACING * 2.5) continue;
      const rot = Math.atan2(dy, dx);
      const duration = b.time - startTime;
      for (let d = Math.floor(FP_SPACING * 1.5); d < distance - FP_SPACING; d += FP_SPACING) {
        const f = d / distance;
        const fadeOutTime = startTime + f * duration;
        const fadeInTime = fadeOutTime - fpPreempt;
        if (t < fadeInTime || t > fadeOutTime + fade) continue;
        let alpha, k = 0;
        if (t < fadeOutTime) { k = clamp01((t - fadeInTime) / fade); alpha = k; }
        else { alpha = 1 - (t - fadeOutTime) / fade; k = 1; }
        const e = easeOut(k);
        const pf = f - 0.1 * (1 - e);
        const sc = 1.5 - 0.5 * e;
        this.sprite(fp, sx + dx * pf, sy + dy * pf, fp.w * sc, fp.h * sc, alpha, rot);
      }
    }
  }
}
