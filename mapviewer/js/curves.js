// Slider path approximation (linear, perfect circle, bezier, catmull).
// Produces a polyline with cumulative lengths, fitted to the slider's expected length.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function linear(pts) {
  return pts.map(p => ({ x: p.x, y: p.y }));
}

function bezierSegment(pts) {
  if (pts.length === 1) return [{ ...pts[0] }];
  if (pts.length === 2) return [{ ...pts[0] }, { ...pts[1] }];
  let polyLen = 0;
  for (let i = 1; i < pts.length; i++) polyLen += dist(pts[i - 1], pts[i]);
  const n = Math.min(2000, Math.max(8, Math.ceil(polyLen / 2.5)));
  const out = [];
  const bx = new Float64Array(pts.length), by = new Float64Array(pts.length);
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    for (let i = 0; i < pts.length; i++) { bx[i] = pts[i].x; by[i] = pts[i].y; }
    for (let k = pts.length - 1; k > 0; k--) {
      for (let i = 0; i < k; i++) {
        bx[i] = bx[i] + (bx[i + 1] - bx[i]) * t;
        by[i] = by[i] + (by[i + 1] - by[i]) * t;
      }
    }
    out.push({ x: bx[0], y: by[0] });
  }
  return out;
}

function bezier(pts) {
  // Repeated control points mark segment boundaries ("red anchors").
  const out = [];
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    const boundary = i === pts.length || (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y);
    if (boundary) {
      const seg = pts.slice(start, i);
      const curve = bezierSegment(seg);
      if (out.length) curve.shift();
      out.push(...curve);
      start = i;
    }
  }
  return out;
}

function circular(pts) {
  const [a, b, c] = pts;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-3) return null; // collinear -> fallback
  const aSq = a.x * a.x + a.y * a.y, bSq = b.x * b.x + b.y * b.y, cSq = c.x * c.x + c.y * c.y;
  const cx = (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d;
  const cy = (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  if (!isFinite(r) || r > 1e6) return null;
  const thetaStart = Math.atan2(a.y - cy, a.x - cx);
  let thetaEnd = Math.atan2(c.y - cy, c.x - cx);
  while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;
  let dir = 1, range = thetaEnd - thetaStart;
  const ox = c.y - a.y, oy = -(c.x - a.x);
  if (ox * (b.x - a.x) + oy * (b.y - a.y) < 0) { dir = -1; range = 2 * Math.PI - range; }
  const n = 2 * r <= 0.1 ? 2 : Math.max(2, Math.ceil(range / (2 * Math.acos(Math.min(1, 1 - 0.1 / r)))));
  const out = [];
  for (let i = 0; i < n; i++) {
    const th = thetaStart + dir * (i / (n - 1)) * range;
    out.push({ x: cx + Math.cos(th) * r, y: cy + Math.sin(th) * r });
  }
  return out;
}

function catmull(pts) {
  const out = [];
  const n = pts.length;
  const at = (v1, v2, v3, v4, t) => {
    const t2 = t * t, t3 = t2 * t;
    const f = k => 0.5 * (2 * v2[k] + (-v1[k] + v3[k]) * t + (2 * v1[k] - 5 * v2[k] + 4 * v3[k] - v4[k]) * t2 + (-v1[k] + 3 * v2[k] - 3 * v3[k] + v4[k]) * t3);
    return { x: f('x'), y: f('y') };
  };
  for (let i = 0; i < n - 1; i++) {
    const v1 = i > 0 ? pts[i - 1] : pts[i];
    const v2 = pts[i];
    const v3 = i < n - 1 ? pts[i + 1] : { x: 2 * v2.x - v1.x, y: 2 * v2.y - v1.y };
    const v4 = i < n - 2 ? pts[i + 2] : { x: 2 * v3.x - v2.x, y: 2 * v3.y - v2.y };
    for (let c = 0; c < 50; c++) out.push(at(v1, v2, v3, v4, c / 50));
  }
  out.push({ ...pts[n - 1] });
  return out;
}

export function buildPath(type, pts, expectedLength) {
  let poly;
  if (pts.length < 2) poly = [{ ...pts[0] }, { ...pts[0] }];
  else if (type === 'L') poly = linear(pts);
  else if (type === 'P' && pts.length === 3) poly = circular(pts) || bezier(pts);
  else if (type === 'C') poly = catmull(pts);
  else poly = bezier(pts);

  // Drop consecutive duplicates
  const clean = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    if (dist(poly[i], clean[clean.length - 1]) > 1e-6) clean.push(poly[i]);
  }
  if (clean.length === 1) clean.push({ ...clean[0] });

  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + dist(clean[i - 1], clean[i]));
  let total = cum[cum.length - 1];
  const target = expectedLength > 0 ? expectedLength : total;

  if (total > target) {
    // truncate
    let i = 1;
    while (i < cum.length && cum[i] < target) i++;
    if (i < cum.length) {
      const a = clean[i - 1], b = clean[i];
      const segLen = cum[i] - cum[i - 1];
      const f = segLen > 0 ? (target - cum[i - 1]) / segLen : 0;
      clean.length = i + 1; cum.length = i + 1;
      clean[i] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      cum[i] = target;
    }
  } else if (total < target) {
    // extend along the last segment direction
    const a = clean[clean.length - 2], b = clean[clean.length - 1];
    const segLen = dist(a, b);
    if (segLen > 0) {
      const extra = target - total;
      clean.push({ x: b.x + (b.x - a.x) / segLen * extra, y: b.y + (b.y - a.y) / segLen * extra });
      cum.push(target);
    }
  }
  total = cum[cum.length - 1];
  return { points: clean, cum, length: total };
}

// Position at a distance along the path
export function pathAt(path, d) {
  const { points, cum, length } = path;
  if (d <= 0) return points[0];
  if (d >= length) return points[points.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid; else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const f = segLen > 0 ? (d - cum[lo]) / segLen : 0;
  const a = points[lo], b = points[hi];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
