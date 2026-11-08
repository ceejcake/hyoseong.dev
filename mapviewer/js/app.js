import { parseOsu, buildObjects, mapLength } from './beatmap.js';
import { Skin } from './skin.js';
import { Renderer } from './renderer.js';
import { Player } from './audio.js';
import { Overview, RhythmStrip } from './timeline.js';
import { parseInput, lookupBeatmap, lookupSet, downloadSet, filesFromZip, filesFromList, findFile } from './loader.js';

const $ = id => document.getElementById(id);

// ---------- settings ----------
const DEFAULTS = {
  musicVol: 0.6, hsVol: 0.5, dim: 0.8, offset: 0,
  hitsounds: true, pitch: false, followPoints: true, hitAnimations: true, sliderTicks: true, beatmapColours: true, showPlayfield: false,
  snap: 4, speed: 1, hr: false, ez: false,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('omv-settings') || '{}')); } catch { }
const saveSettings = () => { try { localStorage.setItem('omv-settings', JSON.stringify(settings)); } catch { } };

// ---------- state ----------
const skin = new Skin();
let player, renderer, overview, strip;
let set = null;        // { files, diffs: [{file, bm, stars}], setId, info }
let current = null;    // { diff, bm, map, min, max }
let audioUrl = null, bgUrl = null, currentAudioName = null;

// ---------- UI helpers ----------
function fmt(ms, withMs = true) {
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
  const base = `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}:${String(x).padStart(3, '0')}` : base;
}
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
}
function setStatus(msg, error = false) {
  const el = $('landing-status');
  el.textContent = msg || '';
  el.classList.toggle('error', error);
}
function showLoading(text, sub = '', progress = null) {
  $('loading').hidden = false;
  $('loading-text').textContent = text;
  $('loading-sub').textContent = sub;
  const bar = $('loading-bar').parentElement;
  bar.classList.toggle('indeterminate', progress === null);
  $('loading-bar').style.width = progress === null ? '' : `${Math.round(progress * 100)}%`;
}
const hideLoading = () => { $('loading').hidden = true; };

// ---------- recent ----------
function getRecent() { try { return JSON.parse(localStorage.getItem('omv-recent') || '[]'); } catch { return []; } }
function pushRecent(entry) {
  const list = getRecent().filter(r => !(r.b === entry.b && r.s === entry.s));
  list.unshift(entry);
  try { localStorage.setItem('omv-recent', JSON.stringify(list.slice(0, 8))); } catch { }
}
function renderRecent() {
  const list = getRecent();
  $('recent').hidden = !list.length;
  const ul = $('recent-list');
  ul.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const t = document.createElement('span'); t.className = 'r-title'; t.textContent = `${r.artist} - ${r.title}`;
    const d = document.createElement('span'); d.className = 'r-diff'; d.textContent = r.version ? `[${r.version}]` : '';
    b.append(t, d);
    b.onclick = () => loadOnline(r.b ? { beatmapId: r.b, setId: r.s } : { setId: r.s, beatmapId: null });
    li.append(b); ul.append(li);
  }
}

// ---------- loading ----------
async function ensureEngine() {
  if (player) return;
  player = new Player(skin);
  await skin.load(player.ctx);
  renderer = new Renderer($('playfield'), skin);
  overview = new Overview($('overview'), (t, scrubbing) => seek(t, scrubbing));
  strip = new RhythmStrip($('strip'), (t, scrubbing) => seek(t, scrubbing));
  player.onEnded = () => updatePlayState();
  window.omv = { player, renderer, overview, strip, get current() { return current; }, seek, drawAt: t => { player.seek(t); renderer.draw(t); strip.draw(t); overview.draw(t); } };
  applySettings();
  requestAnimationFrame(frame);
}

async function loadOnline({ setId, beatmapId }) {
  setStatus('');
  try {
    await ensureEngine();
    let setInfo = null;
    if (!setId) {
      showLoading('Looking up beatmap…', `#${beatmapId}`);
      const b = await lookupBeatmap(beatmapId);
      setId = b.beatmapset_id;
    }
    const infoP = lookupSet(setId).catch(() => null);
    showLoading('Downloading beatmap set…', `set ${setId}`, 0);
    const blob = await downloadSet(setId, (got, total, host) => {
      const mb = (got / 1048576).toFixed(1);
      showLoading('Downloading beatmap set…', `${mb} MB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ''} from ${host}`, total ? got / total : null);
    });
    showLoading('Unpacking…');
    const files = await filesFromZip(blob);
    setInfo = await infoP;
    await openSet(files, { setId, beatmapId, setInfo });
    const url = new URL(location.href);
    url.search = '';
    const bid = +current?.bm.metadata.BeatmapID || beatmapId;
    if (bid > 0) url.searchParams.set('b', bid);
    else url.searchParams.set('s', setId);
    history.replaceState(null, '', url);
  } catch (e) {
    console.error(e);
    hideLoading();
    showLanding();
    setStatus(e.message || String(e), true);
  }
}

async function loadLocal(fileList) {
  // Copy before any await: the caller clears the <input>, which empties its live FileList.
  const arr = [...fileList];
  setStatus('');
  try {
    await ensureEngine();
    showLoading('Reading files…');
    let files;
    const zip = arr.find(f => /\.(osz|zip)$/i.test(f.name));
    if (zip) files = await filesFromZip(zip);
    else files = filesFromList(arr);
    await openSet(files, {});
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    console.error(e);
    hideLoading();
    showLanding();
    setStatus(e.message || String(e), true);
  }
}

async function openSet(files, { setId, beatmapId, setInfo }) {
  const osuFiles = [...files.entries()].filter(([k]) => k.endsWith('.osu'));
  if (!osuFiles.length) throw new Error('No .osu difficulty files found.');
  showLoading('Parsing difficulties…');
  const diffs = [];
  for (const [, f] of osuFiles) {
    const bm = parseOsu(await f.text());
    if (bm.mode !== 0) continue;
    const bid = +(bm.metadata.BeatmapID || 0);
    const info = setInfo?.beatmaps?.find(b => b.id === bid);
    diffs.push({ file: f, bm, stars: info?.difficulty_rating ?? null, objects: bm.rawObjects.length });
  }
  if (!diffs.length) throw new Error('This set has no osu!standard difficulties (only taiko / catch / mania).');
  diffs.sort((a, b) => (a.stars ?? 0) - (b.stars ?? 0) || a.objects - b.objects);
  set = { files, diffs, setId };

  // difficulty picker
  const sel = $('diff-select');
  sel.innerHTML = '';
  diffs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${d.stars != null ? `★${d.stars.toFixed(2)}  ` : ''}${d.bm.metadata.Version || 'Unnamed'}`;
    sel.append(o);
  });
  let idx = diffs.findIndex(d => beatmapId && +d.bm.metadata.BeatmapID === beatmapId);
  if (idx < 0) idx = diffs.length - 1;
  sel.value = idx;

  loadMapSamples(files); // async, not awaited
  await openDiff(idx);
}

async function loadMapSamples(files) {
  player.mapSamples = new Map();
  const jobs = [];
  for (const [k, f] of files) {
    const base = k.split('/').pop();
    if (!/\.(wav|ogg|mp3)$/.test(base)) continue;
    if (f.size > 2_000_000) continue; // skip the song itself / long files
    const key = base.replace(/\.(wav|ogg|mp3)$/, '');
    jobs.push((async () => {
      try {
        const buf = await f.arrayBuffer();
        if (buf.byteLength < 100) { player.mapSamples.set(key, null); return; }
        player.mapSamples.set(key, await player.ctx.decodeAudioData(buf));
      } catch { player.mapSamples.set(key, null); }
    })());
  }
  await Promise.all(jobs);
}

async function openDiff(idx) {
  const d = set.diffs[idx];
  const bm = d.bm;
  const wasPlaying = player.playing;
  const keepTime = current ? player.time() : null;
  player.pause();

  // audio (diffs can use different files)
  const audioName = bm.general.AudioFilename;
  if (audioName !== currentAudioName || !audioUrl) {
    const af = findFile(set.files, audioName);
    if (!af) throw new Error(`Audio file "${audioName}" is missing from the set.`);
    showLoading('Loading audio…', audioName);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const blob = await af.blob();
    audioUrl = URL.createObjectURL(blob);
    await player.loadAudio(audioUrl);
    currentAudioName = audioName;
  }

  // background
  if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
  const bgf = findFile(set.files, bm.background);
  if (bgf && /\.(png|jpe?g|gif|webp|bmp)$/i.test(bm.background)) {
    bgUrl = URL.createObjectURL(await bgf.blob());
    $('bg').style.backgroundImage = `url("${bgUrl}")`;
  } else $('bg').style.backgroundImage = '';

  current = { diff: d, bm, idx };
  rebuild();
  hideLoading();
  showViewer();

  const md = bm.metadata;
  $('title').textContent = `${md.Artist || ''} - ${md.Title || ''}`;
  $('mapper').textContent = `[${md.Version || ''}] mapped by ${md.Creator || 'unknown'}`;
  document.title = `${md.Artist} - ${md.Title} [${md.Version}] · osu! map viewer`;
  pushRecent({ b: +md.BeatmapID || null, s: +md.BeatmapSetID || set.setId || null, artist: md.Artist, title: md.Title, version: md.Version });

  const startAt = keepTime ?? pendingStartTime ?? Math.max(current.min, (current.map.objects[0]?.time ?? 0) - current.map.diff.preempt - 500);
  pendingStartTime = null;
  player.seek(startAt);
  if (wasPlaying) player.play();
  updatePlayState();
}
let pendingStartTime = null;

function rebuild() {
  const bm = current.bm;
  const map = buildObjects(bm, { hr: settings.hr, ez: settings.ez });
  current.map = map;
  const firstT = map.objects[0]?.time ?? 0;
  const min = Math.min(0, firstT - map.diff.preempt - 1000);
  const max = Math.max(player.duration, mapLength(map.objects) + 1000);
  current.min = min; current.max = max;
  player.minTime = min; player.maxTime = max;
  player.hitsounds = map.hitsounds;
  player.resetHitsounds(player.time());
  renderer.setMap(map, bm);
  overview.setMap(map, bm, min, max, renderer.colours);
  strip.setMap(map, renderer.colours);
  $('time-total').textContent = fmt(max, false);
  const dd = map.diff;
  const bpms = map.timing.red.map(p => 60000 / p.beatLength);
  const bpmMin = Math.round(Math.min(...bpms)), bpmMax = Math.round(Math.max(...bpms));
  const r1 = n => Math.round(n * 10) / 10;
  $('stats').innerHTML = `<span>CS <b>${r1(dd.cs)}</b></span><span>AR <b>${r1(dd.ar)}</b></span><span>OD <b>${r1(dd.od)}</b></span><span>HP <b>${r1(dd.hp)}</b></span><span>BPM <b>${bpmMin === bpmMax ? bpmMin : `${bpmMin}–${bpmMax}`}</b></span>`;
}

function showViewer() { $('landing').hidden = true; $('viewer').hidden = false; requestAnimationFrame(() => onResize()); }
function showLanding() {
  if (player) player.pause();
  $('viewer').hidden = true; $('landing').hidden = false;
  closePopovers();
  renderRecent();
  document.title = 'osu! map viewer';
}

// ---------- transport ----------
function seek(t, scrubbing = false) {
  if (!current) return;
  player.seek(t);
}

// unit: 'snap' (one tick at the current divisor) or 'measure' (one bar of the red line's meter)
function snapStep(dir, unit = 'snap') {
  const { timing } = current.map;
  const t = player.time();
  const stepOf = p => unit === 'measure' ? p.beatLength * (p.meter || 4) : p.beatLength / settings.snap;
  // Move a full step, then snap to the nearest grid line. (Snapping to the previous line instead
  // made backward steps tiny during playback, since playback is always just past a line.)
  const x = t + dir * stepOf(timing.redAt(t));
  const p = timing.redAt(x);
  const s = stepOf(p);
  let target = p.time + Math.round((x - p.time) / s) * s;
  if (dir * (target - t) < 1) target += dir * s;
  seek(Math.round(target));
}

function objectStep(dir) {
  const objs = current.map.objects;
  const t = player.time();
  if (dir > 0) { const o = objs.find(o => o.time > t + 0.5); if (o) seek(o.time); }
  else { for (let i = objs.length - 1; i >= 0; i--) if (objs[i].time < t - 0.5) { seek(objs[i].time); break; } }
}

function updatePlayState() { $('viewer').classList.toggle('playing', !!player?.playing); }

// ---------- frame loop ----------
let lastTimeText = '';
function frame(now) {
  requestAnimationFrame(frame);
  if (!current || $('viewer').hidden) return;
  const t = player.update(now);
  renderer.draw(t);
  strip.draw(t);
  overview.draw(t);
  const txt = fmt(t);
  if (txt !== lastTimeText) {
    lastTimeText = txt;
    $('time-cur').textContent = txt;
    const tm = current.map.timing;
    const bpm = Math.round(tm.bpmAt(t) * 10) / 10;
    const sv = tm.svAt(t);
    const kiai = tm.kiai.some(k => t >= k.start && t < k.end);
    $('live').innerHTML = `${bpm} bpm · ${sv.toFixed(2)}x${kiai ? ' · <span class="kiai">kiai</span>' : ''}`;
  }
  if (!player.playing && $('viewer').classList.contains('playing')) updatePlayState();
}

function onResize() {
  if (!renderer) return;
  renderer.resize();
  overview.invalidate();
  strip.invalidate();
}
window.addEventListener('resize', onResize);

// ---------- settings wiring ----------
function applySettings() {
  if (!player) return;
  player.setMusicVolume(settings.musicVol);
  player.setHitsoundVolume(settings.hsVol);
  player.hitsoundsOn = settings.hitsounds;
  player.offset = settings.offset;
  player.setRate(settings.speed, settings.pitch);
  $('dim').style.opacity = settings.dim;
  Object.assign(renderer.settings, {
    followPoints: settings.followPoints, hitAnimations: settings.hitAnimations, sliderTicks: settings.sliderTicks,
    beatmapColours: settings.beatmapColours, showPlayfield: settings.showPlayfield,
  });
  const prevColours = renderer.colours;
  renderer.updateColours();
  if (current && prevColours !== renderer.colours) { overview.setMap(current.map, current.bm, current.min, current.max, renderer.colours); strip.setMap(current.map, renderer.colours); }
  strip.divisor = settings.snap;
  $('snap-select').value = settings.snap;
  $('speed-select').value = settings.speed;
  $('mod-hr').classList.toggle('on', settings.hr);
  $('mod-ez').classList.toggle('on', settings.ez);
  saveSettings();
}

function bindSettings() {
  const bindRange = (id, key, after) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('input', () => { settings[key] = +el.value; after && after(); applySettings(); });
  };
  bindRange('vol-music', 'musicVol');
  bindRange('vol-hs', 'hsVol');
  bindRange('bg-dim', 'dim');
  const offVal = () => { $('offset-val').textContent = `${settings.offset > 0 ? '+' : ''}${settings.offset} ms`; };
  bindRange('offset', 'offset', () => { offVal(); if (player) player.seek(player.time()); });
  offVal();
  const bindCheck = (id, key) => {
    const el = $(id);
    el.checked = settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; applySettings(); });
  };
  bindCheck('opt-hitsounds', 'hitsounds');
  bindCheck('opt-pitch', 'pitch');
  bindCheck('opt-fp', 'followPoints');
  bindCheck('opt-hitanim', 'hitAnimations');
  bindCheck('opt-ticks', 'sliderTicks');
  bindCheck('opt-bmcol', 'beatmapColours');
  bindCheck('opt-border', 'showPlayfield');

  $('snap-select').addEventListener('change', e => { settings.snap = +e.target.value; applySettings(); e.target.blur(); });
  $('speed-select').addEventListener('change', e => { settings.speed = +e.target.value; applySettings(); e.target.blur(); });
  const setMod = (mod) => {
    settings[mod] = !settings[mod];
    if (mod === 'hr' && settings.hr) settings.ez = false;
    if (mod === 'ez' && settings.ez) settings.hr = false;
    applySettings();
    if (current) { rebuild(); }
  };
  $('mod-hr').addEventListener('click', e => { setMod('hr'); e.currentTarget.blur(); });
  $('mod-ez').addEventListener('click', e => { setMod('ez'); e.currentTarget.blur(); });
}

function closePopovers() { $('settings').hidden = true; $('help').hidden = true; $('settings-btn').classList.remove('active'); $('help-btn').classList.remove('active'); }
function togglePopover(id) {
  const el = $(id);
  const open = el.hidden;
  closePopovers();
  el.hidden = !open;
  $(id === 'settings' ? 'settings-btn' : 'help-btn').classList.toggle('active', open);
}

// ---------- input ----------
function onKey(e) {
  if (!current || $('viewer').hidden) return;
  const tgt = e.target instanceof Element ? e.target : null;
  if (tgt?.matches('input[type=text], textarea')) return;
  if (tgt?.tagName === 'SELECT' && /Arrow/.test(e.key)) return;
  if (e.ctrlKey && /^[0-9]$/.test(e.key)) return;
  const k = e.key;
  let handled = true;
  if (k === ' ' || k === 'k' || k === 'K') { player.ctx.resume(); player.toggle(); updatePlayState(); }
  else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const dir = k === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) seek(player.time() + dir * 5000);
    else if (e.ctrlKey || e.metaKey) objectStep(dir);
    else snapStep(dir);
  }
  else if (k === 'j' || k === 'J') seek(player.time() - 10000);
  else if (k === 'l' || k === 'L') seek(player.time() + 10000);
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    settings.musicVol = Math.max(0, Math.min(1, Math.round((settings.musicVol + (k === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100));
    $('vol-music').value = settings.musicVol;
    applySettings();
    toast(`Music ${Math.round(settings.musicVol * 100)}%`);
  }
  else if (k === '[' || k === ']') {
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    let i = speeds.indexOf(settings.speed);
    i = Math.max(0, Math.min(speeds.length - 1, (i < 0 ? 3 : i) + (k === ']' ? 1 : -1)));
    settings.speed = speeds[i];
    applySettings();
    toast(`Speed ${settings.speed}×`);
  }
  else if (e.altKey && /^[1-9]$/.test(k)) {
    const n = +k;
    if ([1, 2, 3, 4, 6, 8].includes(n)) { settings.snap = n; applySettings(); toast(`Beat snap 1/${n}`); }
  }
  else if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey) seek(current.min + (current.max - current.min) * (+k / 10));
  else if (k === 'Home') seek(current.min);
  else if (k === 'End') seek(current.max);
  else if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  else if (k === 'm' || k === 'M') { player.audio.muted = !player.audio.muted; toast(player.audio.muted ? 'Music muted' : 'Music unmuted'); }
  else if (k === 'h' || k === 'H') { settings.hitsounds = !settings.hitsounds; $('opt-hitsounds').checked = settings.hitsounds; applySettings(); toast(settings.hitsounds ? 'Hitsounds on' : 'Hitsounds off'); }
  else if (k === '?') togglePopover('help');
  else if (k === 'Escape') closePopovers();
  else handled = false;
  if (handled) e.preventDefault();
}

function setup() {
  bindSettings();
  renderRecent();

  $('load-form').addEventListener('submit', e => {
    e.preventDefault();
    const parsed = parseInput($('map-input').value);
    if (!parsed) { setStatus("That doesn't look like an osu! beatmap link or ID.", true); return; }
    loadOnline(parsed);
  });
  $('osz-input').addEventListener('change', e => { if (e.target.files.length) loadLocal(e.target.files); e.target.value = ''; });
  $('folder-input').addEventListener('change', e => { if (e.target.files.length) loadLocal(e.target.files); e.target.value = ''; });
  $('back-btn').addEventListener('click', () => { showLanding(); history.replaceState(null, '', location.pathname); });
  $('diff-select').addEventListener('change', e => { openDiff(+e.target.value).catch(err => toast(err.message)); e.target.blur(); });
  $('play-btn').addEventListener('click', () => { player.ctx.resume(); player.toggle(); updatePlayState(); });
  $('settings-btn').addEventListener('click', () => togglePopover('settings'));
  $('help-btn').addEventListener('click', () => togglePopover('help'));
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.popover, #settings-btn, #help-btn')) closePopovers();
  });
  window.addEventListener('keydown', onKey);

  // Wheel anywhere in the viewer: one bar per notch, Shift for one snap tick.
  // Trackpads send many small deltas, so they're accumulated into notches.
  let wheelAcc = 0;
  $('viewer').addEventListener('wheel', e => {
    if (!current || e.ctrlKey || e.target.closest('.popover, select')) return;
    e.preventDefault();
    let d = e.deltaY || e.deltaX; // Shift+wheel arrives as deltaX in some browsers
    if (e.deltaMode === 1) d *= 33; else if (e.deltaMode === 2) d *= 100;
    let steps;
    if (Math.abs(d) >= 50) { wheelAcc = 0; steps = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 100)); } // mouse notch(es)
    else { wheelAcc += d; steps = Math.trunc(wheelAcc / 100); wheelAcc -= steps * 100; } // trackpad
    const unit = e.shiftKey ? 'snap' : 'measure';
    for (let i = 0; i < Math.abs(steps); i++) snapStep(Math.sign(steps), unit);
  }, { passive: false });
  $('playfield').addEventListener('click', () => { if (current) { player.ctx.resume(); player.toggle(); updatePlayState(); } });

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0; $('drop').hidden = true;
    if (e.dataTransfer.files.length) loadLocal(e.dataTransfer.files);
  });

  // deep links: ?b=beatmapId, ?s=setId, &t=ms
  const q = new URLSearchParams(location.search);
  if (q.get('t')) pendingStartTime = +q.get('t');
  if (q.get('b')) { $('map-input').value = q.get('b'); loadOnline({ beatmapId: +q.get('b'), setId: q.get('s') ? +q.get('s') : null }); }
  else if (q.get('s')) loadOnline({ setId: +q.get('s'), beatmapId: null });
  window.omvBooted = true;
}

setup();
