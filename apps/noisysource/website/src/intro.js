// The intro, and then the logo it settles into:
//
//   void → photons pass by → two of them collide (flash) → the burst
//   collapses into "noisy" (white photons that keep shimmering) → "source"
//   slides in (solid blue) → a photon wave crosses the name: white and wavy
//   over "noisy", straight and blue over "source" → the dot of the i lights
//   up → the horizon draws (clean, then breaking into particles) → the
//   tagline is typed out (typewriter.js).
//
// Plain 2D canvas, no dependencies. Positions come from the real glyphs: the
// letters of "noisy" are drawn off-screen and sampled, so the photons land
// exactly on the lettering. Click anywhere (not on a link) to replay.

import { typeTagline, showTagline } from './typewriter.js';

const FONT = 'Oxanium';
const WEIGHT = 500;
const WHITE = '#e8eefc';
const BLUE = '#4a7bff';
const LIGHT = '#cfe0ff';

// Timeline, in seconds from the start.
const T = {
  passStart: 0.8,   // photons start passing by
  pairStart: 4.2,   // the two that will collide come in
  collide: 6.0,     // flash
  burstEnd: 7.0,    // the burst has spread out
  formEnd: 9.6,     // "noisy" has formed
  source: 9.7,      // "source" slides in (0.9 s)
  wave: 10.7,       // the photon wave starts crossing (then loops)
  dot: 11.5,        // the light in the i
  horizon: 11.9,    // the horizon draws (1.3 s)
  type: 13.4,       // the tagline starts typing
};
const WAVE_PERIOD = 4.6;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (k) => 1 - Math.pow(1 - clamp01(k), 3);
const easeInOut = (k) => { k = clamp01(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const easeOutBack = (k) => { k = clamp01(k); const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

export function startIntro({ canvas, flash, tagline }) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, L = null, photons = [], passers = [], horizonDots = [];
  let t0 = performance.now(), flashed = false, typing = 0;

  // ---------- layout: where every letter, the dot and the horizon go ----------
  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const fs = Math.round(Math.max(30, Math.min(W * 0.085, 96)));
    const font = `${WEIGHT} ${fs}px ${FONT}`;
    ctx.font = font;
    const track = fs * 0.12, gap = fs * 0.42;
    const width = (s) => [...s].reduce((a, c) => a + ctx.measureText(c).width + track, 0) - track;
    const word1 = 'noısy', word2 = 'source';           // dotless ı: the dot is ours
    const total = width(word1) + gap + width(word2);
    const base = Math.round(H * 0.46 + fs * 0.35);
    let x = (W - total) / 2;
    const chars1 = [], chars2 = [];
    for (const c of word1) { chars1.push({ c, x }); x += ctx.measureText(c).width + track; }
    x += gap - track;
    for (const c of word2) { chars2.push({ c, x }); x += ctx.measureText(c).width + track; }
    const xEnd = x - track;
    const x0 = chars1[0].x, x1 = chars1[4].x + ctx.measureText('y').width, s0 = chars2[0].x;

    // The i's dot: where the font puts it (pixels of "i" minus "ı").
    const dot = findDot(font, fs, chars1[2].x, base);

    L = { fs, font, base, chars1, chars2, x0, x1, s0, xEnd, dot,
          midY: base - fs * 0.36, waveAmp: fs * 0.1, waveK: 0.22 * 38 / fs };

    buildPhotons();
    buildPassers();
    buildHorizon();
    placeTagline();
  }

  function findDot(font, fs, x, base) {
    const pad = Math.ceil(fs * 1.5);
    const c = document.createElement('canvas'); c.width = pad; c.height = pad;
    const g = c.getContext('2d', { willReadFrequently: true });
    const read = (ch) => { g.clearRect(0, 0, pad, pad); g.font = font; g.fillStyle = '#fff'; g.fillText(ch, 0, fs * 1.1); return g.getImageData(0, 0, pad, pad).data; };
    const withDot = read('i'), without = read('ı');
    let sx = 0, sy = 0, n = 0;
    for (let i = 3; i < withDot.length; i += 4) {
      if (withDot[i] > 128 && without[i] < 64) { const p = (i - 3) / 4; sx += p % pad; sy += Math.floor(p / pad); n++; }
    }
    if (!n) return { x: x + fs * 0.12, y: base - fs * 0.8, r: fs * 0.045 };
    return { x: x + sx / n, y: base - fs * 1.1 + sy / n, r: Math.max(2.4, Math.sqrt(n / Math.PI) * 0.9) };
  }

  // The photons that become "noisy": one per sampled pixel of its letters.
  function buildPhotons() {
    const { fs, font, base, chars1, x0, x1 } = L;
    const S = 2, w = Math.ceil((x1 - x0 + fs) * S), h = Math.ceil(fs * 1.6 * S);
    const ox = x0 - fs * 0.5, oy = base - fs * 1.2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.scale(S, S); g.font = font; g.fillStyle = '#fff';
    for (const ch of chars1) g.fillText(ch.c, ch.x - ox, base - oy);
    const img = g.getImageData(0, 0, w, h).data;
    const step = Math.max(1.6, fs / 24);
    const C = { x: (x0 + x1) / 2, y: L.midY };
    photons = [];
    seed = 7;
    for (let y = 0; y < h / S; y += step) {
      for (let x = 0; x < w / S; x += step) {
        const jx = x + (rnd() - 0.5) * step * 0.8, jy = y + (rnd() - 0.5) * step * 0.8;
        const px = Math.round(jx * S), py = Math.round(jy * S);
        if (px < 0 || py < 0 || px >= w || py >= h || img[(py * w + px) * 4 + 3] < 140) continue;
        const tx = ox + jx, ty = oy + jy, k = (tx - x0) / (x1 - x0);
        photons.push(makePhoton(C, tx, ty, (0.4 + Math.pow(1 - k, 1.6) * 3.2) * fs / 38, 1));
      }
    }
    // A few strays: noise that never quite joins the letters.
    for (let n = 0; n < 50; n++) {
      const k = Math.pow(rnd(), 2) * 0.5, sc = 1 - k * 2;
      const tx = x0 + k * (x1 - x0) - rnd() * fs * sc, ty = L.midY + (rnd() - 0.5) * fs * 1.3;
      photons.push(makePhoton(C, tx, ty, (3 + sc * 5) * fs / 38, 0.5));
    }
  }

  function makePhoton(C, tx, ty, amp, alpha) {
    const a = rnd() * Math.PI * 2, reach = L.fs * (1.5 + rnd() * 6);
    return {
      tx, ty, amp, alpha,
      bx: C.x + Math.cos(a) * reach * 1.6, by: C.y + Math.sin(a) * reach * 0.8,   // where the burst throws it
      delay: rnd() * 0.7, ph: rnd() * 6.283, sp: 0.8 + rnd() * 1.6,
      r: (0.65 + rnd() * 0.55) * Math.max(1, L.fs / 48),
      white: rnd() < 0.3,
    };
  }

  // Photons passing by before the collision, plus the pair that collides.
  function buildPassers() {
    passers = [];
    const span = T.pairStart - T.passStart + 1.2;
    for (let n = 0; n < 11; n++) {
      passers.push({ a: rnd() * Math.PI * 2, c: (rnd() - 0.5) * H * 0.8, ts: T.passStart + rnd() * span,
                     v: (0.9 + rnd() * 0.8) * Math.max(W, H), wav: rnd() * 10, dim: 0.35 + rnd() * 0.3 });
    }
  }

  // The line under the name: clean on the left, scattering on the right.
  function buildHorizon() {
    const { x0, xEnd, base, fs } = L;
    const cx = (x0 + xEnd) / 2, sc = (xEnd - x0) / 480;
    const R = 900 * sc, top = base + fs * 1.15, cy = top + R;
    const a0 = cx - 120 * sc, split = cx - 10 * sc, a1 = cx + 120 * sc;
    L.hz = { arcY: (x) => cy - Math.sqrt(R * R - (x - cx) * (x - cx)), a0, split, a1 };
    horizonDots = [];
    for (let n = 0; n < 140; n++) {
      const k = Math.pow(rnd(), 0.8), x = split + k * (a1 - split) + (rnd() - 0.5) * 10 * sc;
      const amp = Math.pow(k, 1.8) * 22 * sc;
      horizonDots.push({ x, y: L.hz.arcY(x) + (rnd() - 0.5) * 2 * amp, r: (0.4 + rnd() * 0.8) * Math.max(1, sc), a: 0.85 - 0.6 * k, k });
    }
  }

  function placeTagline() {
    tagline.style.top = `${Math.round(L.base + L.fs * 1.75)}px`;
    tagline.style.fontSize = `${Math.max(11, Math.round(L.fs * 0.19))}px`;
  }

  // ---------- drawing ----------
  function drawPhotonTrail(hx, hy, ang, len, wav, t, alpha, color) {
    const ca = Math.cos(ang), sa = Math.sin(ang), seg = 18;
    ctx.lineCap = 'round';
    for (let s = 0; s < seg; s++) {
      const b0 = (s / seg) * len, b1 = ((s + 1) / seg) * len;
      const w0 = Math.sin(b0 * 0.09 - t * 30 + wav) * 4 * (1 - b0 / len), w1 = Math.sin(b1 * 0.09 - t * 30 + wav) * 4 * (1 - b1 / len);
      ctx.strokeStyle = color; ctx.globalAlpha = alpha * (1 - s / seg) * 0.8; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(hx - b0 * ca - w0 * sa, hy - b0 * sa + w0 * ca);
      ctx.lineTo(hx - b1 * ca - w1 * sa, hy - b1 * sa + w1 * ca);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha * 0.25; ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawPassers(t) {
    const diag = Math.hypot(W, H);
    for (const p of passers) {
      const s = -diag / 2 - 200 + (t - p.ts) * p.v;
      if (t < p.ts || s > diag / 2 + 200) continue;
      const ca = Math.cos(p.a), sa = Math.sin(p.a);
      drawPhotonTrail(W / 2 + s * ca - p.c * sa, H / 2 + s * sa + p.c * ca, p.a, 170, p.wav, t, p.dim, '#8fb0ff');
    }
    if (t >= T.pairStart && t < T.collide) {
      const k = (t - T.pairStart) / (T.collide - T.pairStart), C = { x: (L.x0 + L.x1) / 2, y: L.midY };
      const far = Math.max(W, H) * 0.7;
      for (const side of [-1, 1]) {
        const hx = C.x + side * far * (1 - k), hy = C.y + side * far * 0.18 * (1 - k) * (1 - k);
        drawPhotonTrail(hx, hy, Math.atan2(C.y - hy, C.x - hx), 220, side * 2, t, 1, side < 0 ? '#dfe8ff' : '#7fa6ff');
      }
    }
  }

  function drawNoisy(t, settled) {
    if (t < T.collide) return;
    const burst = easeOut((t - T.collide) / (T.burstEnd - T.collide));
    const C = { x: (L.x0 + L.x1) / 2, y: L.midY };
    for (const p of photons) {
      let x, y, shimmer = 0;
      if (t < T.burstEnd) {
        x = C.x + (p.bx - C.x) * burst; y = C.y + (p.by - C.y) * burst;
      } else {
        const k = easeInOut((t - T.burstEnd - p.delay) / (T.formEnd - T.burstEnd - 0.7));
        shimmer = settled ? 0 : k;
        x = p.bx + (p.tx - p.bx) * k; y = p.by + (p.ty - p.by) * k;
      }
      if (shimmer) {
        x += Math.sin(t * p.sp + p.ph) * p.amp * shimmer;
        y += Math.cos(t * p.sp * 1.3 + p.ph) * p.amp * 0.7 * shimmer;
      }
      ctx.globalAlpha = p.alpha * (t < T.burstEnd ? 0.6 + 0.4 * burst : 1);
      ctx.fillStyle = p.white ? '#ffffff' : '#d9e3f7';
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSource(t) {
    if (t < T.source) return;
    const k = easeOut((t - T.source) / 0.9);
    ctx.font = L.font; ctx.fillStyle = BLUE; ctx.globalAlpha = k;
    const shift = (1 - k) * L.fs * 0.9;
    for (const ch of L.chars2) ctx.fillText(ch.c, ch.x + shift, L.base);
    ctx.globalAlpha = 1;
  }

  // The photon that crosses the name: a white wave over "noisy", then a
  // straight blue line over "source". Faint guides, a bright moving head.
  function waveY(x) {
    const xm = L.s0 - L.fs * 0.1;
    if (x >= xm) return L.midY;
    const fade = Math.min(1, (xm - x) / (L.fs * 0.35));
    return L.midY + Math.sin((x - xm) * L.waveK) * L.waveAmp * fade;
  }
  function drawWave(t) {
    if (t < T.wave) return;
    const xs = L.x0 - L.fs * 2.2, xm = L.s0 - L.fs * 0.1, xe = L.xEnd + L.fs * 0.6;
    const appear = clamp01((t - T.wave) / 0.6);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.14 * appear; ctx.strokeStyle = '#dfe8ff';
    ctx.beginPath(); for (let x = xs; x <= xm; x += 2) (x === xs ? ctx.moveTo(x, waveY(x)) : ctx.lineTo(x, waveY(x))); ctx.stroke();
    ctx.globalAlpha = 0.35 * appear; ctx.strokeStyle = BLUE;
    ctx.beginPath(); ctx.moveTo(xm, L.midY); ctx.lineTo(xe, L.midY); ctx.stroke();

    const k = ((t - T.wave) % WAVE_PERIOD) / (WAVE_PERIOD * 0.8);
    if (k > 1) { ctx.globalAlpha = 1; return; }
    const head = xs + (xe - xs) * k, len = L.fs * 0.7;
    ctx.lineCap = 'round';
    for (let x = Math.max(xs, head - len); x < head; x += 2) {
      const blue = x >= xm;
      ctx.globalAlpha = ((x - (head - len)) / len) * (k > 0.92 ? (1 - k) / 0.08 : 1);
      ctx.strokeStyle = blue ? '#7fa6ff' : '#ffffff'; ctx.lineWidth = blue ? 1.8 : 1.5;
      ctx.beginPath(); ctx.moveTo(x, waveY(x)); ctx.lineTo(x + 2, waveY(x + 2)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawDot(t) {
    if (t < T.dot) return;
    const k = easeOutBack((t - T.dot) / 0.7), pulse = 1 + 0.12 * Math.sin(t * 2.2);
    const { x, y, r } = L.dot;
    ctx.fillStyle = BLUE;
    ctx.globalAlpha = 0.12 * clamp01(k); ctx.beginPath(); ctx.arc(x, y, r * 3.3 * pulse * k, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.28 * clamp01(k); ctx.beginPath(); ctx.arc(x, y, r * 1.8 * pulse * k, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = clamp01(k); ctx.fillStyle = LIGHT; ctx.beginPath(); ctx.arc(x, y, r * Math.max(0, k), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawHorizon(t) {
    if (t < T.horizon) return;
    const { arcY, a0, split } = L.hz;
    const k = easeInOut((t - T.horizon) / 0.7);
    ctx.strokeStyle = BLUE; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = a0; x <= a0 + (split - a0) * k; x += 2) (x === a0 ? ctx.moveTo(x, arcY(x)) : ctx.lineTo(x, arcY(x)));
    ctx.stroke();
    ctx.fillStyle = BLUE;
    for (const d of horizonDots) {
      const a = clamp01((t - T.horizon - 0.6 - d.k * 0.6) / 0.4);
      if (!a) continue;
      ctx.globalAlpha = d.a * a; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    const t = reduce ? 999 : (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    if (t < T.collide) drawPassers(t);
    if (!flashed && t >= T.collide && t < T.collide + 1) {
      flashed = true; flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    }
    drawNoisy(t, reduce);
    drawSource(t);
    if (!reduce) drawWave(t);
    drawDot(t);
    drawHorizon(t);
    if (typing === 0 && t >= T.type) {
      typing = 1;
      const run = ++runs;
      if (reduce) showTagline(tagline);
      else typeTagline(tagline, { isCancelled: () => run !== runs });
    }
    requestAnimationFrame(frame);
  }
  let runs = 0;

  function replay() {
    t0 = performance.now(); flashed = false; typing = 0; runs++;
    tagline.innerHTML = '';
  }

  window.addEventListener('resize', layout);
  window.addEventListener('click', (e) => { if (!e.target.closest('a')) replay(); });

  layout();
  canvas.classList.add('on');
  requestAnimationFrame(frame);
}
