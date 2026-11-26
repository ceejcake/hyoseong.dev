// Slider gallery.
// Loads the unique osu! slider shapes in sliders.json, filters and sorts them,
// and draws each one as SVG with the vv_idke_trail skin.

const SKIN = {
  combos: ['#1a74f2', '#a420f0', '#25b9ef', '#17d174', '#ff4bff'],
  border: '#787878',
  track: '#03030c',
};
const COMBOS = SKIN.combos.length ? SKIN.combos : ['#ff7ab6'];

const DATA_URL = 'sliders.json';
const PAGE_SIZE = 90;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TUMOUR = 'tumour (dense wobble)';

// Filter tags, in display order. Tags no slider has are left out.
const TAG_GROUPS = [
  ['Style', ['tech (fits 1 beat or less)', 'fast art (high SV)', 'art (long on screen)', 'low SV']],
  ['Rhythm', ['1/2 beat or less', '3/4 beat', '1 beat', '1-2 beats', '2+ beats']],
  ['Anchors', ['mostly white anchors', 'mostly red anchors', 'mixed anchors', 'linear (all red)']],
  ['Length', ['150-250px', '250-450px', '450-800px', '800px+']],
  ['Size', ['compact', 'medium size', 'large', 'huge']],
  ['Shape', [TUMOUR, 'loop / crosses itself', 'spiral', 'zigzag / wave', 'sharp corners', 'folded / buzz', 'symmetric', 'reverse']],
  ['Source', ['from tb/nm4 collection', 'ranked only']],
];

// Curve type letters as they appear in .osu files.
const CURVE_TYPES = { B: 'bezier', P: 'perfect', L: 'linear', C: 'catmull' };

const ICONS = {
  copy: '<svg class="ts__copy" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 2.5h-6a2 2 0 0 0-2 2v6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  done: '<svg class="ts__done" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.5l3.25 3.25L13 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 11l6-6M6.5 5H11v4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 2l1.76 3.8 4.14.46-3.08 2.8.86 4.08L8 11.07l-3.68 2.07.86-4.08-3.08-2.8 4.14-.46z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
};

const $ = (id) => document.getElementById(id);
const els = {
  meta: $('meta'),
  count: $('count'),
  grid: $('grid'),
  empty: $('empty'),
  more: $('more'),
  tagFilters: $('tag-filters'),
  tagsActive: $('tags-active'),
  tagGroups: $('taggroups'),
  sort: $('sort'),
  dir: $('dir'),
  dirLabel: $('dir-label'),
  query: $('q'),
  lmin: $('lmin'),
  lmax: $('lmax'),
  smin: $('smin'),
  smax: $('smax'),
  hideTumour: $('hidetum'),
  anchors: $('anch'),
  trueScale: $('scale'),
  announcer: $('announcer'),
};

let maps = {};
let sliders = [];
// Tag filters: tag -> 'require' | 'exclude'. A tag that isn't in the map is not filtered on.
const tagState = new Map();
let descending = true;
let list = []; // sliders that pass the filters, sorted
let shown = 0; // how many of them are on the page

// On phones the tag list starts collapsed; open, it would push the sliders far down the page.
const wideScreen = matchMedia('(min-width: 52rem)');
els.tagFilters.open = wideScreen.matches;
wideScreen.addEventListener('change', (event) => { els.tagFilters.open = event.matches; });

init().catch((error) => {
  console.error(error);
  els.grid.replaceChildren();
  els.grid.removeAttribute('aria-busy');
  els.meta.textContent = '';
  $('results-hint').hidden = true;
  els.count.textContent = "Couldn't load the slider data. Check your connection and reload the page.";
  els.count.classList.add('is-error');
});

async function init() {
  showSkeleton();
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`${DATA_URL}: HTTP ${response.status}`);
  const data = await response.json();

  maps = data.maps;
  sliders = data.sl;
  sliders.forEach((s, i) => {
    const m = maps[s.m];
    s.i = i;
    // Sort key for "Random": a new order on every visit, stable while filtering and scrolling.
    s.rnd = Math.random();
    s.size = Math.max(s.w, s.h);
    s.q = `${m.a} ${m.ti} ${m.d} ${m.c}`.toLowerCase();
  });

  els.meta.textContent = `${sliders.length.toLocaleString()} unique shapes · ${Object.keys(maps).length.toLocaleString()} maps`;
  buildTagFilters();
  bindControls();
  applyFilters();
}

// Controls

function bindControls() {
  for (const input of [els.sort, els.lmin, els.lmax, els.smin, els.smax, els.query]) {
    input.addEventListener('input', applyFilters);
  }
  els.hideTumour.addEventListener('change', applyFilters);
  els.anchors.addEventListener('change', redraw);
  els.trueScale.addEventListener('change', redraw);

  els.dir.addEventListener('click', () => {
    descending = !descending;
    els.dirLabel.textContent = descending ? 'Desc' : 'Asc';
    els.dir.classList.toggle('is-asc', !descending);
    applyFilters();
  });

  $('reset').addEventListener('click', resetFilters);
  $('empty-reset').addEventListener('click', resetFilters);

  els.tagGroups.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) cycleTag(chip.dataset.tag);
  });

  els.grid.addEventListener('click', (event) => {
    const tag = event.target.closest('.tag');
    if (tag) {
      tagState.set(tag.dataset.tag, 'require');
      paintChips();
      applyFilters();
      window.scrollTo({ top: 0 });
      return;
    }
    const timestamp = event.target.closest('.ts');
    if (timestamp) copyTimestamp(timestamp);
  });

  els.more.addEventListener('click', () => render(shown + PAGE_SIZE));
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && shown < list.length) render(shown + PAGE_SIZE);
  }, { rootMargin: '800px' }).observe(els.more);
}

function buildTagFilters() {
  const counts = new Map();
  for (const s of sliders) {
    for (const t of s.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }

  els.tagGroups.innerHTML = TAG_GROUPS.map(([name, tags], g) => {
    const chips = tags.filter((t) => counts.has(t)).map((t) => `
      <button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="false">
        <span class="chip__name">${esc(t)}</span><span class="chip__count">${counts.get(t).toLocaleString()}</span><span class="visually-hidden chip__state"></span>
      </button>`).join('');
    if (!chips) return '';
    return `
      <div class="group" role="group" aria-labelledby="tag-group-${g}">
        <p class="group__name" id="tag-group-${g}">${name}</p>
        <div class="chips">${chips}</div>
      </div>`;
  }).join('');
}

// Click order: require, then exclude, then clear.
function cycleTag(tag) {
  const state = tagState.get(tag);
  if (!state) tagState.set(tag, 'require');
  else if (state === 'require') tagState.set(tag, 'exclude');
  else tagState.delete(tag);
  paintChips();
  applyFilters();
}

function paintChips() {
  for (const chip of els.tagGroups.querySelectorAll('.chip')) {
    const state = tagState.get(chip.dataset.tag);
    if (state) chip.dataset.state = state;
    else delete chip.dataset.state;
    chip.setAttribute('aria-pressed', String(state === 'require'));
    chip.querySelector('.chip__state').textContent = state === 'exclude' ? ', excluded' : '';
  }
  els.tagsActive.textContent = tagState.size ? `${tagState.size} active` : '';
}

// Clears tags, ranges and search. Sort and display options stay as they are.
function resetFilters() {
  tagState.clear();
  for (const input of [els.lmin, els.lmax, els.smin, els.smax, els.query]) input.value = '';
  paintChips();
  applyFilters();
}

// Filtering

function applyFilters() {
  const required = [], excluded = [];
  for (const [tag, state] of tagState) (state === 'require' ? required : excluded).push(tag);

  const lmin = Number(els.lmin.value) || 0;
  const lmax = Number(els.lmax.value) || Infinity;
  const smin = Number(els.smin.value) || 0;
  const smax = Number(els.smax.value) || Infinity;
  const query = els.query.value.trim().toLowerCase();
  // Asking for tumour sliders by tag overrides the checkbox.
  const hideTumour = els.hideTumour.checked && tagState.get(TUMOUR) !== 'require';

  list = sliders.filter((s) =>
    s.L >= lmin && s.L <= lmax
    && s.size >= smin && s.size <= smax
    && required.every((t) => s.tags.includes(t))
    && !excluded.some((t) => s.tags.includes(t))
    && (!query || s.q.includes(query))
    && !(hideTumour && s.tags.includes(TUMOUR)));

  const key = els.sort.value;
  list.sort((a, b) => (descending ? b[key] - a[key] : a[key] - b[key]));
  // Reversing a random order changes nothing, so the direction only applies to real measures.
  els.dir.disabled = key === 'rnd';

  const n = list.length;
  els.count.textContent = `${n.toLocaleString()} ${n === 1 ? 'shape matches' : 'shapes match'}`;
  els.empty.hidden = n > 0;
  els.grid.replaceChildren();
  shown = 0;
  render(PAGE_SIZE);
}

// Rendering

function render(upTo) {
  const options = { showAnchors: els.anchors.checked, trueScale: els.trueScale.checked };
  const end = Math.min(upTo, list.length);
  const fragment = document.createDocumentFragment();
  for (; shown < end; shown++) fragment.append(createCard(list[shown], options));
  els.grid.append(fragment);
  els.grid.removeAttribute('aria-busy');
  els.more.hidden = shown >= list.length;
}

// Redraws the cards on the page after a display option changes.
function redraw() {
  const count = shown;
  els.grid.replaceChildren();
  shown = 0;
  render(Math.max(count, 60));
}

function showSkeleton(count = 8) {
  els.grid.setAttribute('aria-busy', 'true');
  els.grid.innerHTML = `
    <div class="slider slider--skeleton" aria-hidden="true">
      <div class="slider__frame"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
    </div>`.repeat(count);
}

function createCard(s, options) {
  const m = maps[s.m];
  const card = document.createElement('article');
  card.className = 'slider';
  card.append(drawSlider(s, COMBOS[s.i % COMBOS.length], options));

  const song = `${m.a} - ${m.ti}`;
  const link = mapLink(m);
  const curve = (CURVE_TYPES[s.ty] || s.ty) + (s.sl > 1 ? ` ×${s.sl}` : '');

  card.insertAdjacentHTML('beforeend', `
    <h3 class="slider__title" title="${esc(song)}">${esc(song)}</h3>
    <p class="slider__sub" title="${esc(m.d)}">[${esc(m.d)}] by ${esc(m.c)}${m.sr ? ` · <span class="stars">${m.sr.toFixed(2)}${ICONS.star}<span class="visually-hidden"> stars</span></span>` : ''}</p>
    <dl class="stats">
      <div><dt>length</dt><dd>${Math.round(s.L)}<span class="unit">px</span></dd></div>
      <div><dt>box</dt><dd>${s.w}×${s.h}</dd></div>
      <div title="${s.na} anchors, ${s.rd} red"><dt>anchors</dt><dd>${s.na} <span class="unit">(${s.rd}r)</span></dd></div>
      <div><dt>type</dt><dd>${esc(curve)}</dd></div>
      <div><dt>time</dt><dd>${(s.du / 1000).toFixed(2)}<span class="unit">s</span></dd></div>
      <div><dt>beats</dt><dd>${formatBeats(s.bt)}</dd></div>
      <div><dt>SV</dt><dd>${s.es.toFixed(2)}</dd></div>
      <div title="SV relative to the map's base SV"><dt>rel. SV</dt><dd>${s.sv.toFixed(1)}<span class="unit">×</span></dd></div>
    </dl>
    <ul class="tags" aria-label="Tags">
      ${s.tags.map((t) => `<li><button type="button" class="tag" data-tag="${esc(t)}" title="Show only shapes tagged ${esc(t)}">${esc(t)}</button></li>`).join('')}
    </ul>
    <div class="slider__actions">
      ${timestampButton(s.ts)}
      ${link ? `<a class="map-link" href="${link}" target="_blank" rel="noopener">Map page<span class="visually-hidden"> (opens in a new tab)</span>${ICONS.external}</a>` : ''}
    </div>`);

  if (s.n > 1) card.insertAdjacentHTML('beforeend', similarList(s));
  return card;
}

function similarList(s) {
  const items = s.o.map(([mapId, time]) => {
    const m = maps[mapId];
    const link = mapLink(m);
    const name = esc(`${m.a} - ${m.ti} [${m.d}]`);
    const label = link ? `<a href="${link}" target="_blank" rel="noopener">${name}</a>` : name;
    return `<li><span class="similar__map" title="${name}">${label}</span>${timestampButton(formatTime(time))}</li>`;
  }).join('');
  return `
    <details class="similar">
      <summary>+${s.n - 1} similar (${s.nm} map${s.nm > 1 ? 's' : ''})</summary>
      <ul>${items}</ul>
    </details>`;
}

function timestampButton(ts) {
  return `<button type="button" class="ts" data-ts="${esc(ts)}" title="Copy, then paste it in the osu! editor"><span class="visually-hidden">Copy timestamp </span>${esc(ts)}${ICONS.copy}${ICONS.done}</button>`;
}

// Draws the slider body, head, tail and (optionally) its anchors, framed at 4:3.
function drawSlider(s, color, { showAnchors, trueScale }) {
  const svg = svgEl('svg', { class: 'slider__frame', 'aria-hidden': 'true' });
  const r = s.r;
  const pad = r + 6;

  let xs = s.p.map((p) => p[0]);
  let ys = s.p.map((p) => p[1]);
  if (showAnchors) {
    xs = xs.concat(s.cp.map((c) => c[0]));
    ys = ys.concat(s.cp.map((c) => c[1]));
  }
  let x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
  let y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  if (trueScale) {
    // Always include the whole 512×384 playfield.
    x0 = Math.min(x0, -40); y0 = Math.min(y0, -30);
    x1 = Math.max(x1, 552); y1 = Math.max(y1, 414);
  }

  // Grow the short side so the view is 4:3, keeping the slider centered.
  let w = x1 - x0, h = y1 - y0;
  if (w / h > 4 / 3) {
    const nh = w * 3 / 4;
    y0 -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * 4 / 3;
    x0 -= (nw - w) / 2;
    w = nw;
  }
  svg.setAttribute('viewBox', `${x0} ${y0} ${w} ${h}`);

  if (trueScale) svgEl('rect', { class: 'playfield', x: 0, y: 0, width: 512, height: 384 }, svg);

  const path = 'M' + s.p.map((p) => `${p[0]} ${p[1]}`).join('L');
  const stroke = { d: path, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  svgEl('path', { ...stroke, stroke: SKIN.border, 'stroke-width': r * 2 }, svg);
  svgEl('path', { ...stroke, stroke: SKIN.track || shade(color), 'stroke-width': r * 2 * 0.84 }, svg);

  const head = s.p[0];
  const tail = s.p[s.p.length - 1];
  const circle = (c) => ({ x: c[0] - r, y: c[1] - r, width: r * 2, height: r * 2 });

  svgEl('circle', { cx: tail[0], cy: tail[1], r: r * 0.92, fill: color, opacity: 0.55 }, svg);
  svgEl('use', { href: '#hco', ...circle(tail), opacity: 0.7 }, svg);
  if (s.sl > 1) {
    // Reverse arrow on the tail, pointing back along the path.
    const prev = s.p[Math.max(0, s.p.length - 2)];
    const angle = Math.atan2(prev[1] - tail[1], prev[0] - tail[0]) * 180 / Math.PI;
    svgEl('use', {
      href: '#rev',
      x: tail[0] - r * 0.8, y: tail[1] - r * 0.8, width: r * 1.6, height: r * 1.6,
      transform: `rotate(${angle} ${tail[0]} ${tail[1]})`,
    }, svg);
  }

  svgEl('circle', { cx: head[0], cy: head[1], r: r * 0.92, fill: color }, svg);
  svgEl('use', { href: '#hc', ...circle(head) }, svg);
  svgEl('use', { href: '#hco', ...circle(head) }, svg);

  if (showAnchors) {
    svgEl('path', { class: 'anchor-line', d: 'M' + s.cp.map((c) => `${c[0]} ${c[1]}`).join('L') }, svg);
    const q = Math.max(3.5, w / 90);
    for (const [x, y, red] of s.cp) {
      svgEl('rect', {
        class: red ? 'anchor anchor--red' : 'anchor',
        x: x - q, y: y - q, width: q * 2, height: q * 2, 'stroke-width': q / 3,
      }, svg);
    }
  }
  return svg;
}

// Clipboard

const copyTimers = new WeakMap();

async function copyTimestamp(button) {
  const text = button.dataset.ts;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    announce("Couldn't copy the timestamp.");
    return;
  }
  button.classList.add('is-copied');
  announce(`Copied ${text}`);
  clearTimeout(copyTimers.get(button));
  copyTimers.set(button, setTimeout(() => button.classList.remove('is-copied'), 1200));
}

function announce(message) {
  els.announcer.textContent = '';
  requestAnimationFrame(() => { els.announcer.textContent = message; });
}

// Helpers

function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  if (parent) parent.append(node);
  return node;
}

function mapLink(m) {
  if (m.b > 0) return `https://osu.ppy.sh/b/${m.b}`;
  if (m.s > 0) return `https://osu.ppy.sh/s/${m.s}`;
  return null;
}

// Beats rounded to the nearest quarter: "1/2", "3/4", "2", "2.25".
function formatBeats(beats) {
  const q = Math.round(beats * 4) / 4;
  const fractions = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' };
  return fractions[q] || (q % 1 === 0 ? String(q) : q.toFixed(2));
}

// Milliseconds to an osu! editor timestamp, mm:ss:mmm.
function formatTime(ms) {
  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}:${pad(ms % 1000, 3)}`;
}

// A darker version of a combo color, for skins without a slider track color.
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * 0.35);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
