// The animated scene: void -> photons -> collision -> expansion -> mind
// (neurons firing, building to an overload) -> explosion -> void, on a loop.
// Plain WebGL, no dependencies. Every visible shape is the same ~12k points,
// moved between stage positions (stagePos) and stage colours (stageColors).
//
// startCosmos({ canvas, status, flash, halo }) — status/flash/halo are the
// page elements it drives (stage name, collision flash, background glow).
export function startCosmos({ canvas, status: statusEl, flash: flashEl, halo: haloEl }) {

  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return;
  const PR = Math.min(window.devicePixelRatio || 1, 2);
  const TAU = Math.PI * 2;
  const fract = (x) => x - Math.floor(x);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

  // ---------- the mind (two abstract lobes) ----------
  const folds = (x, y, z) =>
    Math.sin(x * 9.0 + Math.sin(y * 6.0)) * Math.cos(y * 8.0 + z * 5.0) * 0.6 +
    Math.sin(z * 11.0 + x * 3.0) * 0.4;
  const pts = [];
  function hemisphere(side, n) {
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * TAU, s = Math.sqrt(1 - u * u);
      const dx = Math.abs(s * Math.cos(th)), dy = u, dz = s * Math.sin(th);
      const r = 1 + 0.11 * folds(dx * 1.4, dy * 1.4, dz * 1.4);
      const depth = Math.random() < 0.72 ? 1 : 0.12 + 0.8 * Math.random();      // 72% outline, 28% neurons inside
      let z = dz * 1.35 * r * depth;
      let x = dx * 0.82 * r * depth * (1 - 0.12 * Math.max(0, z / 1.35));
      let y = dy * 0.98 * r * depth;
      if (y < -0.45) y = -0.45 + (y + 0.45) * 0.7;
      y += 0.12 * Math.cos(z * 1.2);
      pts.push(side * (x + 0.05), y, z);
    }
  }
  hemisphere(-1, 6000); hemisphere(1, 6000);
  const brainPos = new Float32Array(pts), count = brainPos.length / 3;

  // ---------- per-point traits ----------
  const rand = new Float32Array(count), rand2 = new Float32Array(count), rand3 = new Float32Array(count), phase = new Float32Array(count);
  const sph = new Float32Array(count * 3), dir = new Float32Array(count * 3), g1 = new Float32Array(count), g2 = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    rand[i] = Math.random(); rand2[i] = Math.random(); rand3[i] = Math.random(); phase[i] = Math.random() * TAU;
    g1[i] = gauss(); g2[i] = gauss();
    const u = Math.random() * 2 - 1, th = Math.random() * TAU, s = Math.sqrt(1 - u * u), rr = Math.cbrt(Math.random());
    dir[i*3] = s * Math.cos(th); dir[i*3+1] = u; dir[i*3+2] = s * Math.sin(th);
    sph[i*3] = dir[i*3] * rr; sph[i*3+1] = dir[i*3+1] * rr; sph[i*3+2] = dir[i*3+2] * rr;
  }
  // light rays for the star and the universe burst
  const RAYS = 70, rayDir = [];
  for (let k = 0; k < RAYS; k++) { const a = Math.random() * TAU, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u); rayDir.push([s * Math.cos(a), u, s * Math.sin(a)]); }

  // ---------- synapses + signals (mind) ----------
  const edges = [], synapses = [];
  for (let k = 0; k < 5000; k++) {
    const a = (Math.random() * count) | 0;
    for (let t = 0; t < 30; t++) {
      const b = (Math.random() * count) | 0;
      const d = Math.hypot(brainPos[a*3]-brainPos[b*3], brainPos[a*3+1]-brainPos[b*3+1], brainPos[a*3+2]-brainPos[b*3+2]);
      if (b !== a && d < 0.32 && d > 0.05 && Math.sign(brainPos[a*3]) === Math.sign(brainPos[b*3])) {
        edges.push([a, b]);
        synapses.push(brainPos[a*3], brainPos[a*3+1], brainPos[a*3+2], brainPos[b*3], brainPos[b*3+1], brainPos[b*3+2]);
        break;
      }
    }
  }
  const NP = 420, pulses = [], pulsePos = new Float32Array(NP * 3);
  const newPulse = (p) => { p.e = edges[(Math.random() * edges.length) | 0]; p.t = 0; p.v = 0.6 + Math.random() * 1.4; return p; };
  for (let i = 0; i < NP; i++) { const p = newPulse({}); p.t = Math.random(); pulses.push(p); }

  // =========================================================
  // Stages
  // =========================================================
  const VOID = 0, PHOTONS = 1, BURST = 2, MIND = 3, FADE = 4;
  const NAMES = ['void', 'photons', 'expansion', 'mind', 'explosion'];
  const NST = 5;
  const CAM = [5.6, 3.6, 2.4, 5.6, 6.4];                  // camera distance per stage (zoom)

  // palette
  const WHITE = [1.0, 0.97, 0.92], ICE = [0.78, 0.88, 1.0], BLUE = [0.22, 0.42, 1.0], CYAN = [0.35, 0.78, 1.0],
        DEEP = [0.12, 0.2, 0.85], BLACK = [0, 0, 0];
  const mix = (a, b, k) => [a[0] + (b[0]-a[0]) * k, a[1] + (b[1]-a[1]) * k, a[2] + (b[2]-a[2]) * k];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

  let spin = 1.0;
  function face(x, y, z, tilt, o) {                       // screen-facing (cancels the scene spin)
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const X = x, Y = y * c - z * s, Z = y * s + z * c;
    const cs = Math.cos(-spin), sn = Math.sin(-spin);
    o[0] = X * cs + Z * sn; o[1] = Y; o[2] = -X * sn + Z * cs;
  }
  const smooth = (k) => k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);

  const PHOTON_HOLD = 7.0, FADE_HOLD = 3.0, PAIR_TIME = 3.0;
  const isHead = (i) => rand[i] < 0.3;                    // photon head vs light trail
  // photons that pass by before the collision: each has its own line, start time and speed
  const NG = 14, passers = [];
  for (let g = 2; g < NG; g++) {
    passers[g] = { a: Math.random() * TAU, c: (Math.random() - 0.5) * 2.4, z: (Math.random() - 0.5) * 1.5,
                   ts: Math.random() * (PHOTON_HOLD - 2.6), v: 6 + Math.random() * 5, wav: Math.random() * 10 };
  }

  function stagePos(s, i, t, L, o) {
    const j = i * 3, r1 = rand[i], r2 = rand2[i], r3 = rand3[i];
    switch (s) {
      case PHOTONS: {
        const g = i % NG;
        if (g < 2) {                                      // the two that will collide
          const p = Math.min(1, Math.max(0, (L - (PHOTON_HOLD - PAIR_TIME)) / PAIR_TIME));
          const side = g ? 1 : -1;
          const headX = side * 6.5 * (1 - p), headY = side * 0.9 * (1 - p) * (1 - p);
          if (isHead(i)) {
            const r = 0.03 * (1 + 0.2 * Math.sin(t * 9 + phase[i]));
            face(headX + sph[j] * r, headY + sph[j+1] * r, sph[j+2] * r, 0, o); return;
          }
          const back = r2 * 1.6;
          const tx = headX + side * back, ty = headY + side * back * 0.14 * (1 - p) + 0.035 * Math.sin(back * 14 - t * 30) * (1 - back / 1.6);
          face(tx + 0.01 * g1[i], ty + 0.01 * g2[i], 0.01 * sph[j+2], 0, o); return;
        }
        const q = passers[g];                             // a photon passing by
        let sHead = -9 + (L - q.ts) * q.v;
        if (L < q.ts || sHead > 12) sHead = 30;           // parked far away when not on screen
        const back = isHead(i) ? 0 : r2 * 1.4;
        const s = sHead - back;
        const w = isHead(i) ? 0 : 0.03 * Math.sin(back * 14 - t * 30 + q.wav) * (1 - back / 1.4);
        const r = isHead(i) ? 0.022 : 0.008;
        const ca = Math.cos(q.a), sa = Math.sin(q.a);
        const px = s * ca - (q.c + w) * sa, py = s * sa + (q.c + w) * ca;
        face(px + sph[j] * r, py + sph[j+1] * r, q.z + sph[j+2] * r, 0, o); return;
      }
      case BURST: {                                       // collision → expansion
        const e = 1 - Math.exp(-L * 1.7);
        let x, y, z;
        if (r1 < 0.08) {
          const R = 0.25 * e * Math.cbrt(r2);
          x = dir[j] * R; y = dir[j+1] * R; z = dir[j+2] * R;
        } else if (r1 < 0.55) {
          const d = rayDir[i % RAYS];
          const R = (0.15 + 3.8 * Math.pow(r2, 0.8)) * e + L * 0.05 * r3;
          x = d[0] * R * 1.25; y = d[1] * R * 0.6; z = d[2] * R * 0.6;
        } else {
          const R = (0.2 + 4.2 * Math.pow(r2, 0.7)) * e + L * 0.04 * r3;
          x = dir[j] * R * 1.3; y = dir[j+1] * R * 0.5 + 0.06 * g1[i]; z = dir[j+2] * R * 0.6;
        }
        face(x, y, z, 0, o); return;
      }
      case MIND:
        o[0] = brainPos[j]; o[1] = brainPos[j+1]; o[2] = brainPos[j+2]; return;
      case FADE: case VOID: {                             // the mind explodes into darkness
        const k = s === VOID ? FADE_HOLD + 2 : L;
        const e = (1 - Math.exp(-k * 2.2)) * (0.6 + 4.2 * Math.pow(r1, 1.5)) + k * 0.15 * r2;
        o[0] = brainPos[j] + dir[j] * e; o[1] = brainPos[j+1] + dir[j+1] * e; o[2] = brainPos[j+2] + dir[j+2] * e; return;
      }
    }
  }

  // colours per stage (static, blended during morphs) — black = invisible
  const stageColors = [0, 1, 2, 3, 4].map(() => new Float32Array(count * 3));
  for (let i = 0; i < count; i++) {
    const r1 = rand[i], r2 = rand2[i];
    const set = (s, c) => { stageColors[s][i*3] = c[0]; stageColors[s][i*3+1] = c[1]; stageColors[s][i*3+2] = c[2]; };
    set(VOID, BLACK);
    { const pair = (i % NG) < 2, dim = pair ? 1 : 0.55;
      set(PHOTONS, isHead(i) ? scale(r2 < 0.6 ? WHITE : ICE, dim) : scale(mix(CYAN, BLUE, r2), dim * 0.9 * Math.pow(1 - r2, 1.5))); }
    set(BURST, r1 < 0.08 ? WHITE : r2 < 0.12 ? WHITE : r2 < 0.5 ? mix(BLUE, CYAN, r2) : mix(DEEP, BLUE, r2));
    set(MIND, r2 < 0.15 ? WHITE : mix(ICE, BLUE, r2 * 0.8));
    set(FADE, r2 < 0.2 ? scale(WHITE, 0.7) : scale(mix(CYAN, DEEP, r2), 0.55));
  }

  // the loop: morph into a stage, then hold it (seconds)
  const easeIO = (k) => k <= 0 ? 0 : k >= 1 ? 1 : k * k * k * (k * (k * 6 - 15) + 10);
  const easeOut = (k) => k <= 0 ? 0 : k >= 1 ? 1 : 1 - Math.pow(1 - k, 4);
  const MIND_HOLD = 17.0;
  const SEQ = [
    { s: VOID,    morph: 3.0,  hold: 1.5,         ease: easeIO },   // fade to black, silence
    { s: PHOTONS, morph: 0.05, hold: PHOTON_HOLD, ease: easeIO },   // two photons fire…
    { s: BURST,   morph: 0.35, hold: 5.5,         ease: easeOut },  // …collide: light, expansion
    { s: MIND,    morph: 4.5,  hold: MIND_HOLD,   ease: easeIO },   // zoom out: the mind, neurons firing
    { s: FADE,    morph: 0.5,  hold: FADE_HOLD,   ease: easeOut },  // overload → explosion
  ];
  // how hard the neurons fire, by time spent in the mind
  const fireLevel = (L) => 0.35 + 0.5 * smooth(L / 6) + 2.6 * Math.pow(smooth((L - 8) / (MIND_HOLD - 8)), 2);
  const CYCLE = SEQ.reduce((a, q) => a + q.morph + q.hold, 0);
  function timeline(t) {
    let tt = fract(t / CYCLE) * CYCLE;
    for (let n = 0; n < SEQ.length; n++) {
      const q = SEQ[n], prev = SEQ[(n + SEQ.length - 1) % SEQ.length];
      if (tt < q.morph) return { from: prev.s, to: q.s, k: q.ease(tt / q.morph), Lfrom: prev.morph + prev.hold + tt, Lto: tt };
      if (tt < q.morph + q.hold) return { from: q.s, to: q.s, k: 1, Lfrom: tt, Lto: tt };
      tt -= q.morph + q.hold;
    }
  }
  const weight = (tl, s) => tl.from === tl.to ? (tl.to === s ? 1 : 0) : (tl.to === s ? tl.k : 0) + (tl.from === s ? 1 - tl.k : 0);

  // =========================================================
  // WebGL
  // =========================================================
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    return p;
  }
  const pointProg = program(`
    precision highp float;
    attribute vec3 position; attribute float aRand; attribute vec3 aColor;
    uniform mat4 uP, uMV; uniform float uTime, uPR, uMode, uFade, uWave, uBoost, uFire;
    varying float vA; varying vec3 vC;
    void main(){
      vec4 mv = uMV * vec4(position, 1.0);
      gl_Position = uP * mv;
      vC = aColor;
      if (uMode < 0.5) {
        float wave = mix(1.0, 0.6 + 0.9 * pow(sin(position.z * 2.5 - uTime * 1.2) * 0.5 + 0.5, 3.0), uWave);
        float tw = 0.5 + 0.5 * sin(uTime * 1.7 + aRand * 60.0);
        float rate = 0.6 + aRand * 2.2;
        float spike = pow(max(0.0, sin(uTime * rate * (1.0 + uFire * 1.2) + aRand * 517.0)), 40.0) * min(uFire, 2.5) * 0.85;
        vA = (0.35 + 0.65 * tw) * wave * uFade * uBoost * (1.0 - min(uFire, 3.0) * 0.12) + spike;
        vC = mix(aColor, vec3(1.0, 0.92, 0.88) * length(aColor) * 0.7, clamp(spike, 0.0, 1.0));
        gl_PointSize = (1.8 + 2.6 * aRand) * (1.0 + spike * 0.7) * uPR * (6.0 / -mv.z);
      } else {
        vA = 0.95 * uFade;
        gl_PointSize = 7.0 * uPR * (6.0 / -mv.z);
      }
    }`, `
    precision highp float;
    uniform float uMode; varying float vA; varying vec3 vC;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float s = smoothstep(0.5, 0.0, d);
      if (uMode > 0.5) s = s * s;
      gl_FragColor = vec4(vC, s * vA);
    }`);
  const lineProg = program(`
    attribute vec3 position; uniform mat4 uP, uMV;
    void main(){ gl_Position = uP * uMV * vec4(position, 1.0); }`, `
    precision mediump float; uniform vec3 uColor; uniform float uAlpha;
    void main(){ gl_FragColor = vec4(uColor, uAlpha); }`);

  function buffer(data, usage) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); return b; }
  const cur = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const bPos = buffer(cur, gl.DYNAMIC_DRAW), bCol = buffer(col, gl.DYNAMIC_DRAW), bRand = buffer(rand), bPulse = buffer(pulsePos, gl.DYNAMIC_DRAW);
  const synArr = new Float32Array(synapses), bSyn = buffer(synArr);

  const U = (p, n) => gl.getUniformLocation(p, n);
  const pu = { P: U(pointProg,'uP'), MV: U(pointProg,'uMV'), time: U(pointProg,'uTime'), pr: U(pointProg,'uPR'), mode: U(pointProg,'uMode'), fade: U(pointProg,'uFade'), wave: U(pointProg,'uWave'), boost: U(pointProg,'uBoost'), fire: U(pointProg,'uFire') };
  const lu = { P: U(lineProg,'uP'), MV: U(lineProg,'uMV'), color: U(lineProg,'uColor'), alpha: U(lineProg,'uAlpha') };
  const aPos = gl.getAttribLocation(pointProg, 'position'), aRand = gl.getAttribLocation(pointProg, 'aRand'), aCol = gl.getAttribLocation(pointProg, 'aColor');
  const aLine = gl.getAttribLocation(lineProg, 'position');

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k]; o[c*4+r] = s; } return o; };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); };
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); };
  const trans = (x, y, z) => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
  const persp = (fovy, asp, n, f) => { const t = 1 / Math.tan(fovy / 2); return new Float32Array([t/asp,0,0,0, 0,t,0,0, 0,0,(f+n)/(n-f),-1, 0,0,2*f*n/(n-f),0]); };

  let P, portrait = 1;
  
  function resize() {
    const w = innerWidth, h = innerHeight;
    canvas.width = w * PR; canvas.height = h * PR;
    gl.viewport(0, 0, canvas.width, canvas.height);
    portrait = w < h ? 1.5 : 1;
    P = persp(40 * Math.PI / 180, w / h, 0.1, 100);
  }
  window.addEventListener('resize', resize); resize();

  let mx = 0, my = 0, tx = 0, ty = 0;
  window.addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; });

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mindAt = SEQ[0].morph + SEQ[0].hold + SEQ[1].morph + SEQ[1].hold + SEQ[2].morph + SEQ[2].hold + SEQ[3].morph + 1;
  const startOffset = reduce ? mindAt : SEQ[0].morph;      // begin on the photon
  let t0 = performance.now() - startOffset * 1000;
  let last = performance.now();

  window.addEventListener('click', (e) => { if (e.target.closest('a')) return; t0 = performance.now() - SEQ[0].morph * 1000; });

  const A = [0, 0, 0], B = [0, 0, 0];
  let shownName = '';
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    let t = reduce ? mindAt : (now - t0) / 1000;
    const tl = timeline(t);

    const cf = stageColors[tl.from], ct = stageColors[tl.to], k = tl.from === tl.to ? 0 : tl.k;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      stagePos(tl.from, i, t, tl.Lfrom, A);
      if (k > 0) {
        stagePos(tl.to, i, t, tl.Lto, B);
        cur[j] = A[0] + (B[0]-A[0]) * k; cur[j+1] = A[1] + (B[1]-A[1]) * k; cur[j+2] = A[2] + (B[2]-A[2]) * k;
        col[j] = cf[j] + (ct[j]-cf[j]) * k; col[j+1] = cf[j+1] + (ct[j+1]-cf[j+1]) * k; col[j+2] = cf[j+2] + (ct[j+2]-cf[j+2]) * k;
      } else {
        cur[j] = A[0]; cur[j+1] = A[1]; cur[j+2] = A[2];
        col[j] = cf[j]; col[j+1] = cf[j+1]; col[j+2] = cf[j+2];
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, cur);
    gl.bindBuffer(gl.ARRAY_BUFFER, bCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, col);

    const name = NAMES[tl.k > 0.5 ? tl.to : tl.from];
    if (name !== shownName) {
      statusEl.textContent = name; shownName = name;
      if (name === 'expansion' || name === 'explosion') { flashEl.classList.remove('go'); void flashEl.offsetWidth; flashEl.classList.add('go'); }
    }
    let cz = 0; for (let s = 0; s < NST; s++) cz += CAM[s] * weight(tl, s);
    const camZ = cz * portrait;
    const wMind = weight(tl, MIND);
    let fire = 0;
    if (tl.from === MIND && tl.to === MIND) fire = fireLevel(tl.Lfrom);
    else if (tl.to === MIND) fire = fireLevel(0) * tl.k;
    else if (tl.from === MIND) fire = fireLevel(MIND_HOLD) * (1 - tl.k);
    if (tl.from === MIND && tl.to === MIND && fire > 1.6 && shownName !== 'overload') { statusEl.textContent = 'overload'; shownName = 'overload'; }
    const haloOp = (1 - weight(tl, VOID)) * (1 - 0.7 * weight(tl, FADE)) * (1 - 0.6 * weight(tl, PHOTONS)) + Math.min(fire, 3) * 0.12;
    haloEl.style.opacity = haloOp.toFixed(3);

    const activePulses = Math.floor(NP * Math.min(1, 0.2 + fire * 0.32));
    for (let i = 0; i < NP; i++) {
      const p = pulses[i];
      p.t += dt * p.v * (1 + fire * 0.9); if (p.t >= 1) newPulse(p);
      const a = p.e[0] * 3, b = p.e[1] * 3;
      for (let q = 0; q < 3; q++) pulsePos[i*3+q] = brainPos[a+q] + (brainPos[b+q] - brainPos[a+q]) * p.t;
    }

    spin = 1.5 + (reduce ? 0 : 0.45 * Math.sin(t * 0.12));
    tx += (mx - tx) * 0.04; ty += (my - ty) * 0.04;
    const MV = mul(trans(0, Math.sin(t * 0.5) * 0.05 + 0.05, -camZ), mul(rotX(0.15 + ty * 0.4), rotY(spin + tx * 0.8)));

    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);

    if (wMind > 0.01) {
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(lu.P, false, P); gl.uniformMatrix4fv(lu.MV, false, MV);
      gl.uniform3f(lu.color, 0.3, 0.45, 0.95); gl.uniform1f(lu.alpha, (0.16 + Math.min(fire, 3) * 0.05) * wMind);
      gl.bindBuffer(gl.ARRAY_BUFFER, bSyn); gl.enableVertexAttribArray(aLine); gl.vertexAttribPointer(aLine, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, synArr.length / 3);
    }

    gl.useProgram(pointProg);
    gl.uniformMatrix4fv(pu.P, false, P); gl.uniformMatrix4fv(pu.MV, false, MV);
    gl.uniform1f(pu.time, t); gl.uniform1f(pu.pr, PR);
    gl.uniform1f(pu.mode, 0); gl.uniform1f(pu.fade, 1); gl.uniform1f(pu.wave, wMind); gl.uniform1f(pu.boost, 1 + 0.6 * weight(tl, BURST)); gl.uniform1f(pu.fire, fire);
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bRand); gl.enableVertexAttribArray(aRand); gl.vertexAttribPointer(aRand, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bCol); gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, count);

    if (wMind > 0.01) {                                     // red signals through the mind
      gl.uniform1f(pu.mode, 1); gl.uniform1f(pu.fade, wMind);
      gl.bindBuffer(gl.ARRAY_BUFFER, bPulse); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pulsePos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.disableVertexAttribArray(aRand); gl.vertexAttrib1f(aRand, 0.5);
      gl.disableVertexAttribArray(aCol); gl.vertexAttrib3f(aCol, 1.0, 0.22, 0.16);
      gl.uniform1f(pu.fire, 0);
      gl.drawArrays(gl.POINTS, 0, activePulses);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  requestAnimationFrame(() => canvas.classList.add('on'));
}
