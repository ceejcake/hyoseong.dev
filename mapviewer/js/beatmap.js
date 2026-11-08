// .osu parsing and hit object processing (combos, slider paths, ticks, stacking, hitsounds)
import { buildPath, pathAt } from './curves.js';

const unquote = s => s.replace(/^"(.*)"$/, '$1');

export function parseOsu(text) {
  const bm = {
    formatVersion: 14,
    general: {}, metadata: {}, difficulty: {}, editor: {},
    background: null, breaks: [], timingPoints: [], colours: [], rawObjects: [],
  };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const fv = /osu file format v(\d+)/.exec(lines[0] || '');
  if (fv) bm.formatVersion = +fv[1];
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line[0] === '[' && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    switch (section) {
      case 'General': case 'Metadata': case 'Difficulty': case 'Editor': {
        const i = line.indexOf(':');
        if (i < 0) break;
        bm[section.toLowerCase()][line.slice(0, i).trim()] = line.slice(i + 1).trim();
        break;
      }
      case 'Colours': {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).split(',').map(s => +s.trim());
        if (/^Combo\d+$/.test(k) && v.length >= 3) bm.colours.push({ i: +k.slice(5), c: v.slice(0, 3) });
        break;
      }
      case 'Events': {
        const p = line.split(',');
        if (p[0] === '0' && p.length >= 3 && !bm.background) bm.background = unquote(p[2].trim());
        else if ((p[0] === '2' || p[0] === 'Break') && p.length >= 3) bm.breaks.push({ start: +p[1], end: +p[2] });
        break;
      }
      case 'TimingPoints': {
        const p = line.split(',');
        const tp = {
          time: +p[0], beatLength: +p[1],
          meter: +(p[2] || 4) || 4,
          sampleSet: +(p[3] || 0), sampleIndex: +(p[4] || 0),
          volume: p[5] !== undefined ? +p[5] : 100,
          uninherited: p[6] === undefined ? true : p[6].trim() === '1',
          effects: +(p[7] || 0),
        };
        if (!isNaN(tp.time) && !isNaN(tp.beatLength)) bm.timingPoints.push(tp);
        break;
      }
      case 'HitObjects':
        bm.rawObjects.push(line);
        break;
    }
  }
  // stable sort by time (keeps red-before-green ordering at equal times)
  bm.timingPoints = bm.timingPoints.map((tp, i) => ({ tp, i }))
    .sort((a, b) => a.tp.time - b.tp.time || a.i - b.i).map(o => o.tp);
  bm.colours.sort((a, b) => a.i - b.i);
  bm.mode = +(bm.general.Mode || 0);
  return bm;
}

// ---- timing helpers ----
function lastAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

export class Timing {
  constructor(points) {
    this.all = points.length ? points : [{ time: 0, beatLength: 500, meter: 4, sampleSet: 1, sampleIndex: 0, volume: 100, uninherited: true, effects: 0 }];
    this.red = this.all.filter(p => p.uninherited && p.beatLength > 0);
    if (!this.red.length) this.red = [{ ...this.all[0], beatLength: 500, uninherited: true }];
    // kiai sections
    this.kiai = [];
    let open = null;
    for (const p of this.all) {
      const on = (p.effects & 1) === 1;
      if (on && open === null) open = p.time;
      else if (!on && open !== null) { this.kiai.push({ start: open, end: p.time }); open = null; }
    }
    if (open !== null) this.kiai.push({ start: open, end: Infinity });
  }
  redAt(t) { const i = lastAtOrBefore(this.red, t); return this.red[Math.max(0, i)]; }
  pointAt(t) { const i = lastAtOrBefore(this.all, t); return this.all[Math.max(0, i)]; }
  beatLengthAt(t) { return this.redAt(t).beatLength; }
  svAt(t) {
    const p = this.pointAt(t);
    if (p.uninherited || !(p.beatLength < 0)) return 1;
    return Math.min(10, Math.max(0.1, -100 / p.beatLength));
  }
  bpmAt(t) { return 60000 / this.beatLengthAt(t); }
}

export function difficultyFor(bm, mods) {
  const d = bm.difficulty;
  let cs = +(d.CircleSize ?? 5);
  let od = +(d.OverallDifficulty ?? 5);
  let ar = d.ApproachRate !== undefined ? +d.ApproachRate : od;
  let hp = +(d.HPDrainRate ?? 5);
  if (mods.hr) { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); hp = Math.min(10, hp * 1.4); }
  if (mods.ez) { cs *= 0.5; ar *= 0.5; od *= 0.5; hp *= 0.5; }
  const preempt = ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
  const fadeIn = ar < 5 ? 800 + 400 * (5 - ar) / 5 : 800 - 500 * (ar - 5) / 5;
  const radius = 54.4 - 4.48 * cs;
  return { cs, ar, od, hp, preempt, fadeIn, radius };
}

function parseHitSample(s) {
  const p = (s || '').split(':');
  return { normalSet: +(p[0] || 0), additionSet: +(p[1] || 0), index: +(p[2] || 0), volume: +(p[3] || 0), filename: p[4] || '' };
}

// Build processed hit objects for the given mods.
export function buildObjects(bm, mods) {
  const timing = new Timing(bm.timingPoints);
  const diff = difficultyFor(bm, mods);
  const SM = +(bm.difficulty.SliderMultiplier || 1.4);
  const TR = +(bm.difficulty.SliderTickRate || 1);
  const flip = !!mods.hr;
  const objects = [];

  for (const line of bm.rawObjects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = +p[0], y0 = +p[1];
    const y = flip ? 384 - y0 : y0;
    const time = +p[2], type = +p[3], hitSound = +(p[4] || 0);
    if (isNaN(time)) continue;
    const o = {
      x, y, time, endTime: time, hitSound,
      newCombo: (type & 4) !== 0, comboSkip: (type >> 4) & 7,
      stackHeight: 0,
    };
    if (type & 2) {
      o.kind = 'slider';
      const parts = (p[5] || 'L').split('|');
      const ctype = parts[0];
      const pts = [{ x, y }];
      for (const s of parts.slice(1)) {
        const [a, b] = s.split(':');
        if (a === undefined || b === undefined) continue;
        pts.push({ x: +a, y: flip ? 384 - +b : +b });
      }
      o.spans = Math.max(1, +(p[6] || 1));
      const expected = +(p[7] || 0);
      o.path = buildPath(ctype, pts, expected);
      const beatLen = timing.beatLengthAt(time);
      const sv = timing.svAt(time);
      const scoringDist = 100 * SM * sv;
      o.velocity = scoringDist / beatLen; // osu!px per ms
      o.spanDuration = o.path.length / o.velocity;
      o.endTime = time + o.spans * o.spanDuration;
      o.edgeSounds = p[8] ? p[8].split('|').map(Number) : [];
      o.edgeSets = p[9] ? p[9].split('|').map(s => s.split(':').map(Number)) : [];
      o.sample = parseHitSample(p[10]);
      // ticks
      o.ticks = [];
      const tickDist = scoringDist / TR;
      const minFromEnd = o.velocity * 10;
      if (tickDist > 0 && o.path.length / tickDist < 2000) {
        for (let s = 0; s < o.spans; s++) {
          const spanStart = time + s * o.spanDuration;
          for (let d = tickDist; d <= o.path.length; d += tickDist) {
            if (d >= o.path.length - minFromEnd) break;
            const f = d / o.path.length;
            const pos = pathAt(o.path, d);
            o.ticks.push({ span: s, time: spanStart + (s % 2 ? 1 - f : f) * o.spanDuration, x: pos.x, y: pos.y });
          }
        }
      }
      const end = o.spans % 2 ? o.path.points[o.path.points.length - 1] : o.path.points[0];
      o.endX = end.x; o.endY = end.y;
    } else if (type & 8) {
      o.kind = 'spinner';
      o.endTime = Math.max(time, +(p[5] || time));
      o.x = 256; o.y = 192;
      o.sample = parseHitSample(p[6]);
    } else if (type & 1) {
      o.kind = 'circle';
      o.sample = parseHitSample(p[5]);
    } else {
      continue; // mania hold notes etc.
    }
    if (o.kind !== 'slider') { o.endX = o.x; o.endY = o.y; }
    objects.push(o);
  }
  objects.sort((a, b) => a.time - b.time);

  // combos
  let colorIndex = -1, comboNumber = 0, forceNew = true;
  for (const o of objects) {
    if (o.kind === 'spinner') { o.colorIndex = Math.max(0, colorIndex); o.comboNumber = 0; forceNew = true; continue; }
    if (o.newCombo || forceNew) {
      colorIndex += 1 + o.comboSkip;
      comboNumber = 1;
      o.newCombo = true;
    } else comboNumber++;
    forceNew = false;
    o.colorIndex = colorIndex;
    o.comboNumber = comboNumber;
  }

  applyStacking(objects, diff, +(bm.general.StackLeniency ?? 0.7));

  const stackOffset = diff.radius / 10; // osu!px per stack level
  for (const o of objects) {
    const off = o.kind === 'spinner' ? 0 : -o.stackHeight * stackOffset;
    o.sx = o.x + off; o.sy = o.y + off;
    o.sEndX = o.endX + off; o.sEndY = o.endY + off;
    o.stackOff = off;
  }

  const hitsounds = buildHitsounds(objects, timing);
  return { objects, timing, diff, hitsounds };
}

function applyStacking(objects, diff, leniency) {
  const STACK_DIST = 3;
  const n = objects.length;
  if (!n) return;
  const d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const threshold = diff.preempt * leniency;
  // osu!stable stacking (format v6+), processing the whole map at once.
  const startIndex = 0;
  let extendedStartIndex = startIndex;
  for (let i = n - 1; i > startIndex; i--) {
    let k = i;
    let oi = objects[i];
    if (oi.stackHeight !== 0 || oi.kind === 'spinner') continue;
    if (oi.kind === 'circle') {
      while (--k >= 0) {
        const on = objects[k];
        if (on.kind === 'spinner') continue;
        if (oi.time - on.endTime > threshold) break;
        if (k < extendedStartIndex) { on.stackHeight = 0; extendedStartIndex = k; }
        if (on.kind === 'slider' && d(on.endX, on.endY, oi.x, oi.y) < STACK_DIST) {
          const offset = oi.stackHeight - on.stackHeight + 1;
          for (let j = k + 1; j <= i; j++) {
            const oj = objects[j];
            if (d(on.endX, on.endY, oj.x, oj.y) < STACK_DIST) oj.stackHeight -= offset;
          }
          break;
        }
        if (d(on.x, on.y, oi.x, oi.y) < STACK_DIST) {
          on.stackHeight = oi.stackHeight + 1;
          oi = on;
        }
      }
    } else if (oi.kind === 'slider') {
      while (--k >= startIndex) {
        const on = objects[k];
        if (on.kind === 'spinner') continue;
        if (oi.time - on.time > threshold) break;
        if (d(on.endX, on.endY, oi.x, oi.y) < STACK_DIST) {
          on.stackHeight = oi.stackHeight + 1;
          oi = on;
        }
      }
    }
  }
}

// ---- hitsounds ----
const SETS = { 1: 'normal', 2: 'soft', 3: 'drum' };

function samplesFor(timing, time, hitSound, normalSet, additionSet, index, volume, filename) {
  const tp = timing.pointAt(time + 5);
  const ns = normalSet || tp.sampleSet || 1;
  const as = additionSet || ns;
  const idx = index || tp.sampleIndex || 0;
  const vol = (volume || tp.volume || 100) / 100;
  if (filename) return [{ file: filename, vol }];
  const out = [{ set: SETS[ns] || 'normal', name: 'hitnormal', index: idx, vol }];
  if (hitSound & 2) out.push({ set: SETS[as] || 'normal', name: 'hitwhistle', index: idx, vol });
  if (hitSound & 4) out.push({ set: SETS[as] || 'normal', name: 'hitfinish', index: idx, vol });
  if (hitSound & 8) out.push({ set: SETS[as] || 'normal', name: 'hitclap', index: idx, vol });
  return out;
}

function buildHitsounds(objects, timing) {
  const events = [];
  for (const o of objects) {
    const s = o.sample || {};
    if (o.kind === 'circle') {
      events.push({ time: o.time, samples: samplesFor(timing, o.time, o.hitSound, s.normalSet, s.additionSet, s.index, s.volume, s.filename) });
    } else if (o.kind === 'spinner') {
      events.push({ time: o.endTime, samples: samplesFor(timing, o.endTime, o.hitSound, s.normalSet, s.additionSet, s.index, s.volume, s.filename) });
    } else if (o.kind === 'slider') {
      for (let e = 0; e <= o.spans; e++) {
        const t = o.time + e * o.spanDuration;
        const hs = o.edgeSounds[e] ?? o.hitSound;
        const es = o.edgeSets[e] || [];
        events.push({ time: t, samples: samplesFor(timing, t, hs, es[0] || s.normalSet, es[1] || s.additionSet, s.index, s.volume, '') });
      }
      for (const tk of o.ticks) {
        const tp = timing.pointAt(tk.time + 5);
        const ns = s.normalSet || tp.sampleSet || 1;
        events.push({ time: tk.time, tick: true, samples: [{ set: SETS[ns] || 'normal', name: 'slidertick', index: s.index || tp.sampleIndex || 0, vol: (s.volume || tp.volume || 100) / 100 }] });
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

export function mapLength(objects) {
  let end = 0;
  for (const o of objects) end = Math.max(end, o.endTime);
  return end;
}
