/* ═══════════════════════════════════════════════════════════
   noise.js — deterministic RNG, value/fractal noise, easing.
   Everything random in this world is seeded so that the
   counterfactual ("what if I switch this off?") simulation
   sees the exact same weather as the real timeline.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ---------- mulberry32: tiny, fast, seedable ---------- */
  function makeRNG(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* A pure LCG we can carry inside a clonable state object.
     step() returns [nextSeed, value] so cloning a state clones its future. */
  function lcg(seed) {
    const s = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return s;
  }
  function lcgFloat(seed) {
    return (seed >>> 8) / 16777216;
  }

  /* ---------- value noise ---------- */
  const PERM = new Uint8Array(512);
  (function seedPerm() {
    const r = makeRNG(1337);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  })();

  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  function grad2(hash, x, y) {
    switch (hash & 7) {
      case 0: return  x + y;
      case 1: return  x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return  x;
      case 5: return -x;
      case 6: return  y;
      default: return -y;
    }
  }

  /** Perlin-ish 2D noise, range roughly [-1, 1]. */
  function noise2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = PERM[PERM[X] + Y], ab = PERM[PERM[X] + Y + 1];
    const ba = PERM[PERM[X + 1] + Y], bb = PERM[PERM[X + 1] + Y + 1];
    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** Fractal Brownian motion — layered noise for terrain. */
  function fbm(x, y, oct, lac, gain) {
    oct = oct || 4; lac = lac || 2.0; gain = gain || 0.5;
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lac;
    }
    return sum / norm;
  }

  /** Divergence-free-ish flow field used for wind, smoke and clouds. */
  function curl(x, y, t) {
    const e = 0.12;
    const n1 = fbm(x, y + e, 3), n2 = fbm(x, y - e, 3);
    const n3 = fbm(x + e, y, 3), n4 = fbm(x - e, y, 3);
    return { x: (n1 - n2) / (2 * e), y: -(n3 - n4) / (2 * e) };
  }

  /* ---------- small math helpers used everywhere ---------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const smoothstep = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
  const mix = (a, b, t) => a + (b - a) * t;
  /** frame-rate independent exponential approach */
  const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const TAU = Math.PI * 2;

  /** hex/rgb helpers for the renderer */
  function rgba(r, g, b, a) { return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a + ')'; }
  function mixRGB(c1, c2, t) {
    return [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
  }
  function css(c, a) {
    return a === undefined ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
                           : rgba(c[0], c[1], c[2], a);
  }

  global.NZ = {
    makeRNG, lcg, lcgFloat, noise2, fbm, curl,
    clamp, clamp01, smoothstep, mix, approach, easeOut, easeInOut, TAU,
    rgba, mixRGB, css
  };
})(window);
