// Loads the bundled skin (images, skin.ini colours, hitsound samples) and caches tinted sprites.

const BASE = new URL('../skin/', import.meta.url);

const IMAGES = [
  'hitcircle', 'hitcircleoverlay', 'approachcircle', 'sliderstartcircleoverlay',
  'reversearrow', 'sliderb0', 'sliderscorepoint', 'followpoint-4',
  'spinner-circle', 'spinner-approachcircle',
  ...Array.from({ length: 10 }, (_, i) => `default-${i}`),
];

const SAMPLES = [];
for (const set of ['normal', 'soft', 'drum'])
  for (const n of ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap']) SAMPLES.push(`${set}-${n}`);
SAMPLES.push('normal-slidertick');

function loadImage(url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

// skin/manifest.json lists the files in the skin folder (regenerate it if you swap skins)
let manifest = null;
const has = f => !manifest || manifest.has(f.toLowerCase());

async function loadSprite(name) {
  // Prefer @2x if present
  if (has(`${name}@2x.png`)) {
    const hd = await loadImage(new URL(`${name}@2x.png`, BASE));
    if (hd) return { img: hd, scale: 2, w: hd.width / 2, h: hd.height / 2 };
  }
  if (has(`${name}.png`)) {
    const sd = await loadImage(new URL(`${name}.png`, BASE));
    if (sd) return { img: sd, scale: 1, w: sd.width, h: sd.height };
  }
  return null;
}

function parseSkinIni(text) {
  const out = { combos: [], sliderBorder: [255, 255, 255], sliderTrack: null, hitCircleOverlap: -2, allowSliderBallTint: false };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { section = line.slice(1, -1); continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    const rgb = () => v.split(',').slice(0, 3).map(Number);
    if (section === 'Colours') {
      if (/^Combo\d$/.test(k)) out.combos[+k.slice(5) - 1] = rgb();
      else if (k === 'SliderBorder') out.sliderBorder = rgb();
      else if (k === 'SliderTrackOverride') out.sliderTrack = rgb();
    } else if (section === 'Fonts' && k === 'HitCircleOverlap') out.hitCircleOverlap = +v;
    else if (section === 'General' && k === 'AllowSliderBallTint') out.allowSliderBallTint = v === '1';
  }
  out.combos = out.combos.filter(Boolean);
  if (!out.combos.length) out.combos = [[255, 192, 0], [0, 202, 0], [18, 124, 255], [242, 24, 57]];
  return out;
}

export class Skin {
  async load(audioCtx) {
    try {
      const r = await fetch(new URL('manifest.json', BASE));
      if (r.ok) manifest = new Set((await r.json()).map(f => f.toLowerCase()));
    } catch { manifest = null; }
    const [ini, ...sprites] = await Promise.all([
      fetch(new URL('skin.ini', BASE)).then(r => r.ok ? r.text() : '').catch(() => ''),
      ...IMAGES.map(loadSprite),
    ]);
    this.ini = parseSkinIni(ini);
    this.sprites = {};
    IMAGES.forEach((n, i) => { if (sprites[i] && sprites[i].w > 1) this.sprites[n] = sprites[i]; });
    this.tintCache = new Map();
    this.samples = {};
    if (audioCtx) {
      await Promise.all(SAMPLES.map(async (n) => {
        for (const ext of ['ogg', 'wav', 'mp3']) {
          if (!has(`${n}.${ext}`)) continue;
          try {
            const r = await fetch(new URL(`${n}.${ext}`, BASE));
            if (!r.ok) continue;
            const buf = await r.arrayBuffer();
            if (buf.byteLength < 100) return; // intentionally blank sample
            this.samples[n] = await audioCtx.decodeAudioData(buf);
            return;
          } catch { /* try next */ }
        }
      }));
    }
    return this;
  }

  get(name) { return this.sprites[name] || null; }

  tinted(name, rgb) {
    const sp = this.sprites[name];
    if (!sp) return null;
    const key = name + '|' + rgb.join(',');
    let c = this.tintCache.get(key);
    if (!c) {
      const cv = document.createElement('canvas');
      cv.width = sp.img.width; cv.height = sp.img.height;
      const x = cv.getContext('2d');
      x.drawImage(sp.img, 0, 0);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      x.fillRect(0, 0, cv.width, cv.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(sp.img, 0, 0);
      c = { img: cv, scale: sp.scale, w: sp.w, h: sp.h };
      this.tintCache.set(key, c);
    }
    return c;
  }
}
