// Resolving beatmap links, downloading .osz files from mirrors, and reading local files.

// Parses osu! links / ids. Returns { setId, beatmapId } (either may be null) or null.
export function parseInput(input) {
  const s = (input || '').trim();
  if (!s) return null;
  let m;
  if ((m = /beatmapsets\/(\d+)(?:\/?#\w+\/(\d+))?/i.exec(s))) return { setId: +m[1], beatmapId: m[2] ? +m[2] : null };
  if ((m = /\/beatmaps\/(\d+)/i.exec(s))) return { setId: null, beatmapId: +m[1] };
  if ((m = /\/b\/(\d+)/i.exec(s))) return { setId: null, beatmapId: +m[1] };
  if ((m = /\/s\/(\d+)/i.exec(s))) return { setId: +m[1], beatmapId: null };
  if ((m = /[?&]b=(\d+)/i.exec(s))) return { setId: null, beatmapId: +m[1] };
  if ((m = /[?&]s=(\d+)/i.exec(s))) return { setId: +m[1], beatmapId: null };
  if ((m = /^s(\d+)$/i.exec(s))) return { setId: +m[1], beatmapId: null };
  if ((m = /^(\d+)$/.exec(s))) return { setId: null, beatmapId: +m[1] };
  return null;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// Look up beatmap metadata (set id + star ratings) through public mirror APIs.
export async function lookupBeatmap(beatmapId) {
  const urls = [`https://osu.direct/api/v2/b/${beatmapId}`, `https://catboy.best/api/v2/b/${beatmapId}`];
  for (const u of urls) {
    try {
      const j = await fetchJson(u);
      if (j && j.beatmapset_id) return j;
    } catch { /* next */ }
  }
  throw new Error(`Couldn't find beatmap ${beatmapId} on the mirrors.`);
}

export async function lookupSet(setId) {
  const urls = [`https://osu.direct/api/v2/s/${setId}`, `https://catboy.best/api/v2/s/${setId}`];
  for (const u of urls) {
    try {
      const j = await fetchJson(u);
      if (j && j.beatmaps) return j;
    } catch { /* next */ }
  }
  return null;
}

const MIRRORS = [
  id => `https://osu.direct/api/d/${id}?noVideo=1`,
  id => `https://api.nerinyan.moe/d/${id}?noVideo=true`,
  id => `https://catboy.best/d/${id}n`,
];

export async function downloadSet(setId, onProgress) {
  let lastErr;
  for (const mk of MIRRORS) {
    const url = mk(setId);
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = +r.headers.get('content-length') || 0;
      const reader = r.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress && onProgress(got, total, new URL(url).host);
      }
      const blob = new Blob(chunks);
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('not a zip');
      return blob;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`All mirrors failed to download set ${setId} (${lastErr?.message || 'unknown error'}). Try uploading the .osz instead.`);
}

// Normalises a set of files (from a zip or a folder/multi-select) to { name(lowercase path) -> Blob-like loader }
export async function filesFromZip(blob) {
  if (!window.JSZip) throw new Error('JSZip failed to load');
  const zip = await window.JSZip.loadAsync(blob);
  const files = new Map();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    files.set(path.replace(/\\/g, '/').toLowerCase(), {
      name: path,
      text: () => entry.async('string'),
      blob: () => entry.async('blob'),
      arrayBuffer: () => entry.async('arraybuffer'),
      size: entry._data?.uncompressedSize ?? 0,
    });
  });
  return files;
}

export function filesFromList(fileList) {
  const files = new Map();
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    // strip leading folder when a whole folder was selected
    const path = f.webkitRelativePath ? rel.split('/').slice(1).join('/') : rel;
    files.set(path.toLowerCase(), {
      name: path,
      text: () => f.text(),
      blob: async () => f,
      arrayBuffer: () => f.arrayBuffer(),
      size: f.size,
    });
  }
  return files;
}

export function findFile(files, name) {
  if (!name) return null;
  const n = name.replace(/\\/g, '/').toLowerCase();
  if (files.has(n)) return files.get(n);
  // fallback: match by basename
  const base = n.split('/').pop();
  for (const [k, v] of files) if (k.split('/').pop() === base) return v;
  return null;
}
