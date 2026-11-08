// Music playback clock (smoothed against the <audio> element) + scheduled hitsounds via Web Audio.

export class Player {
  constructor(skin) {
    this.skin = skin;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.hsGain = this.ctx.createGain();
    this.hsGain.connect(this.ctx.destination);
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.rate = 1;
    this.offset = 0;          // ms; positive = objects appear later
    this.playing = false;
    this.mode = 'virtual';    // virtual | starting | audio
    this._t = 0;
    this._lastNow = 0;
    this.hitsounds = [];
    this.hitsoundsOn = true;
    this.mapSamples = new Map();
    this._hsIdx = 0;
    this._pending = [];
    this.minTime = 0;
    this.maxTime = 0;
    this.onEnded = null;

    const ready = () => {
      if (this.playing && this.mode === 'starting' && !this.audio.paused && !this.audio.seeking) {
        this.mode = 'audio';
        this._refAudio = this.audioMapTime();
        this._refPerf = performance.now();
        this._t = this._refAudio;
        this.resetHitsounds(this._t);
      }
    };
    this.audio.addEventListener('playing', ready);
    this.audio.addEventListener('seeked', ready);
  }

  get duration() { return (this.audio.duration || 0) * 1000; }
  audioMapTime() { return this.audio.currentTime * 1000 - this.offset; }

  async loadAudio(url) {
    this.audio.pause();
    this.audio.src = url;
    await new Promise((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const bad = () => { cleanup(); rej(new Error('Could not load the audio file')); };
      const cleanup = () => { this.audio.removeEventListener('loadedmetadata', ok); this.audio.removeEventListener('error', bad); };
      this.audio.addEventListener('loadedmetadata', ok);
      this.audio.addEventListener('error', bad);
    });
  }

  setRate(rate, pitch) {
    if (rate === this.rate && pitch === this._pitch) return;
    this._pitch = pitch;
    this.rate = rate;
    this.audio.playbackRate = rate;
    this.audio.preservesPitch = !pitch;
    this.audio.mozPreservesPitch = !pitch;
    if (this.playing) this.seek(this._t);
  }

  setMusicVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); }
  setHitsoundVolume(v) { this.hsGain.gain.value = v; }

  inAudio(t) { const a = (t + this.offset) / 1000; return a >= 0 && a < (this.audio.duration || 0) - 0.05; }

  play() {
    if (this.playing) return;
    this.ctx.resume();
    if (this._t >= this.maxTime) this._t = this.minTime;
    this.playing = true;
    this._lastNow = performance.now();
    this._enterRegion();
  }

  _enterRegion() {
    if (this.inAudio(this._t)) {
      this.mode = 'starting';
      this.audio.currentTime = (this._t + this.offset) / 1000;
      const p = this.audio.play();
      if (p && p.catch) p.catch(() => { this.mode = 'virtual'; });
    } else {
      this.mode = 'virtual';
      if (!this.audio.paused) this.audio.pause();
    }
    this.resetHitsounds(this._t);
  }

  pause() {
    if (!this.playing) return;
    this.update(performance.now());
    this.playing = false;
    this.audio.pause();
    this.stopPending();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this._t = Math.max(this.minTime, Math.min(this.maxTime, t));
    this.stopPending();
    if (this.playing) { this._lastNow = performance.now(); this._enterRegion(); }
    else if (this.inAudio(this._t)) this.audio.currentTime = (this._t + this.offset) / 1000;
    this.resetHitsounds(this._t);
  }

  time() { return this._t; }

  update(now) {
    if (!this.playing) { this._lastNow = now; return this._t; }
    if (this.mode === 'virtual') {
      const t = this._t + (now - this._lastNow) * this.rate;
      const wasOutside = !this.inAudio(this._t);
      this._t = t;
      if (wasOutside && this.inAudio(t) && t < this.duration - this.offset - 100) this._enterRegion();
    } else if (this.mode === 'audio') {
      if (this.audio.ended || this.audio.paused) {
        this.mode = 'virtual';
      } else {
        const at = this.audioMapTime();
        if (at !== this._refAudio) { this._refAudio = at; this._refPerf = now; }
        let t = this._refAudio + Math.min(120, now - this._refPerf) * this.rate;
        if (t < this._t && this._t - t < 40) t = this._t; // keep it monotonic for tiny corrections
        this._t = t;
      }
    }
    this._lastNow = now;
    if (this._t >= this.maxTime) {
      this._t = this.maxTime;
      this.pause();
      this.onEnded && this.onEnded();
    }
    if (this.playing && this.mode !== 'starting') this.scheduleHitsounds(this._t);
    return this._t;
  }

  // ---- hitsounds ----
  resetHitsounds(t) {
    const ev = this.hitsounds;
    let lo = 0, hi = ev.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].time < t) lo = m + 1; else hi = m; }
    this._hsIdx = lo;
  }

  stopPending() {
    const now = this.ctx.currentTime;
    for (const s of this._pending) { if (s.when > now) { try { s.src.stop(); } catch { } } }
    this._pending = [];
  }

  bufferFor(smp) {
    if (smp.file) {
      const key = smp.file.toLowerCase().replace(/\.(wav|ogg|mp3)$/, '');
      return this.mapSamples.has(key) ? this.mapSamples.get(key) : null;
    }
    const base = `${smp.set}-${smp.name}`;
    if (smp.index >= 1) {
      const key = base + (smp.index > 1 ? smp.index : '');
      if (this.mapSamples.has(key)) return this.mapSamples.get(key);
    }
    return this.skin.samples[base] || (smp.name === 'slidertick' ? null : this.skin.samples[`normal-${smp.name}`]) || null;
  }

  scheduleHitsounds(t) {
    if (!this.hitsoundsOn || !this.hitsounds.length) return;
    const ahead = 100 * this.rate;
    const ev = this.hitsounds;
    const ctxNow = this.ctx.currentTime;
    this._pending = this._pending.filter(p => p.when > ctxNow - 1);
    while (this._hsIdx < ev.length && ev[this._hsIdx].time < t + ahead) {
      const e = ev[this._hsIdx++];
      if (e.time < t - 25) continue;
      const when = ctxNow + Math.max(0, (e.time - t) / this.rate / 1000);
      for (const smp of e.samples) {
        const buf = this.bufferFor(smp);
        if (!buf) continue;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = smp.vol * (e.tick ? 0.8 : 1);
        src.connect(g); g.connect(this.hsGain);
        src.start(when);
        this._pending.push({ src, when });
      }
    }
  }
}
