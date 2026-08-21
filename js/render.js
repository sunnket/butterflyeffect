/* ═══════════════════════════════════════════════════════════
   render.js — the valley, drawn.

   Oblique 2.5D: world space is a plan view and height is a shear
   lift (+x, −y). Footprints are arbitrary quads, so buildings face
   the street they were generated along. Every solid throws a cast
   shadow whose length and direction follow the sun through the
   day. Depth sorting is by world y.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { clamp, clamp01, smoothstep, mix, fbm, noise2, makeRNG, TAU, css, mixRGB } = NZ;
  const W = WORLD;

  const LX = 0.32, LY = 0.86;
  const lift = (x, y, h) => [x + h * LX, y - h * LY];
  /* the direction the camera looks from, in the projected plane */
  const VX = -0.348, VY = 0.937;

  const CAT_COLOR = {
    power: '#ffb545', water: '#3fd0e8', nature: '#54d98c',
    civic: '#a98bff', econ: '#ff6f91', air: '#8fb4ff'
  };
  const EDGE_COLOR = { power:'#ffb545', water:'#3fd0e8', matter:'#ff6f91', social:'#a98bff', air:'#8fb4ff' };

  const PALETTES = {
    brick:   { wall:[150, 96, 84],  roof:[88, 76, 84]  },
    brick2:  { wall:[172,114, 90],  roof:[106, 66, 58] },
    render:  { wall:[216,204,182],  roof:[100, 90, 96] },
    render2: { wall:[230,218,198],  roof:[128, 82, 64] },
    stone:   { wall:[188,180,162],  roof:[84, 88, 98]  },
    slate:   { wall:[170,168,166],  roof:[68, 72, 84]  },
    ochre:   { wall:[208,170,118],  roof:[120, 74, 56] },
    sage:    { wall:[178,182,160],  roof:[78, 84, 88]  },
    shed:    { wall:[144,148,152],  roof:[94, 98,106]  },
    civic:   { wall:[226,222,212],  roof:[92, 96,108]  }
  };

  const R = {
    cv: null, ctx: null, dpr: 1, w: 0, h: 0,
    cam: { x: 2300, y: 1700, z: 0.4, tz: 0.4, tx: 2300, ty: 1700 },
    layers: { links: false, wind: false, heat: false, haze: true, labels: true, people: true },
    hover: null, selected: null, time: 0, darkness: 0, minZ: 0.2,
    terrain: null, terrainScale: 2.8,
    glows: [], drawables: [], shadowPass: [], sun: { dx:-1, dy:0.4, elev:0.5, up:true, a:0.2 },

    /* ─────────────────────────── setup ─────────────────────────── */
    init(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.resize();
      this.bakeTerrain();
      this.fit();
      this.hitOrder = W.nodes.slice().sort((a, b) => (a.w * a.d) - (b.w * b.d));
    },

    resize() {
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = window.innerWidth || document.documentElement.clientWidth || 1280;
      this.h = window.innerHeight || document.documentElement.clientHeight || 720;
      this.cv.width = this.w * this.dpr; this.cv.height = this.h * this.dpr;
      this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
      this.minZ = clamp(Math.min(this.w / (W.w * 1.06), this.h / (W.h * 1.06)) * 0.88, 0.04, 3);
      if (this.cam.tz < this.minZ) this.cam.tz = this.cam.z = this.minZ;
    },

    fit() {
      if (!this.w || !this.h) this.resize();
      const z = Math.min(this.w / (W.w * 1.06), this.h / (W.h * 1.06));
      this.minZ = clamp(z * 0.88, 0.04, 3);
      this.cam.z = this.cam.tz = clamp(z, this.minZ, 3);
      this.cam.x = this.cam.tx = W.w / 2;
      this.cam.y = this.cam.ty = W.h / 2 - 60;
    },

    /* ───────────────────── terrain baking ─────────────────────
       Coarse elevation sampled bilinearly, then broken up with
       three scales of noise plus slope-driven rock, so it never
       reads as a smooth heightmap. */
    bakeTerrain() {
      const sampleE = W.elevF;
      const TS = this.terrainScale;
      const tw = Math.ceil(W.w / TS), th = Math.ceil(W.h / TS);
      const off = document.createElement('canvas');
      off.width = tw; off.height = th;
      const octx = off.getContext('2d');
      const img = octx.createImageData(tw, th);
      const px = img.data;

      const C_BED    = [78, 84, 66];
      const C_SAND   = [170, 158, 122];
      const C_MEADOW = [116, 148, 86];
      const C_GRASS  = [84, 122, 70];
      const C_GRASS2 = [104, 132, 68];
      const C_UPLAND = [108, 118, 76];
      const C_SCRUB  = [124, 120, 92];
      const C_ROCK   = [122, 122, 126];
      const C_ROCK2  = [148, 144, 140];
      const C_SNOW   = [216, 222, 230];

      for (let j = 0; j < th; j++) {
        const wy = j * TS;
        for (let i = 0; i < tw; i++) {
          const wx = i * TS;
          const e = sampleE(wx, wy);
          const det = fbm(wx / 54, wy / 54, 3) * 0.5 + 0.5;
          const mott = fbm(wx / 210, wy / 210, 2) * 0.5 + 0.5;
          const patch = fbm(wx / 96, wy / 96, 2) * 0.5 + 0.5;
          const grain = noise2(wx / 6.5, wy / 6.5) * 0.5 + 0.5;
          const grain2 = noise2(wx / 2.3, wy / 2.3) * 0.5 + 0.5;
          const ee = clamp(e + (det - 0.5) * 0.06, 0, 1.6);

          let c;
          if (ee < 0.14)      c = mixRGB(C_BED, C_SAND, smoothstep(0.02, 0.14, ee));
          else if (ee < 0.26) c = mixRGB(C_SAND, C_MEADOW, smoothstep(0.14, 0.26, ee));
          else if (ee < 0.54) c = mixRGB(C_MEADOW, mixRGB(C_GRASS, C_GRASS2, mott), smoothstep(0.26, 0.54, ee));
          else if (ee < 0.84) c = mixRGB(mixRGB(C_GRASS, C_GRASS2, mott), C_UPLAND, smoothstep(0.54, 0.84, ee));
          else if (ee < 1.06) c = mixRGB(C_UPLAND, C_SCRUB, smoothstep(0.84, 1.06, ee));
          else if (ee < 1.28) c = mixRGB(C_SCRUB, C_ROCK, smoothstep(1.06, 1.28, ee));
          else                c = mixRGB(C_ROCK, C_SNOW, smoothstep(1.28, 1.46, ee));

          const ex = sampleE(wx + 11, wy) - sampleE(wx - 11, wy);
          const ey = sampleE(wx, wy + 11) - sampleE(wx, wy - 11);
          const slope = Math.hypot(ex, ey);

          // steep ground sheds soil and shows rock
          const rocky = clamp01((slope - 0.055) * 14) * clamp01(ee * 1.6);
          if (rocky > 0.01) c = mixRGB(c, mixRGB(C_ROCK, C_ROCK2, grain), rocky * 0.72);

          // meadow patchiness: some swards are yellower, some are shaded and lush
          c = mixRGB(c, mixRGB(c, [138, 146, 84], 0.55), clamp01((patch - 0.52) * 3.2));
          c = mixRGB(c, mixRGB(c, [52, 84, 52], 0.5), clamp01((0.44 - patch) * 3.0));

          const shade = clamp(1 + (ex * 0.9 - ey * 1.55) * 5.4, 0.40, 1.66);
          const tex = 0.84 + grain * 0.20 + grain2 * 0.09 + det * 0.10;

          const o = (j * tw + i) * 4;
          px[o]     = clamp(c[0] * shade * tex, 0, 255);
          px[o + 1] = clamp(c[1] * shade * tex, 0, 255);
          px[o + 2] = clamp(c[2] * shade * tex, 0, 255);
          px[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);

      octx.save();
      octx.scale(1 / TS, 1 / TS);
      octx.globalAlpha = 0.15; octx.fillStyle = '#8a8058';
      W.buildings.forEach(b => {
        octx.beginPath(); octx.ellipse(b.x, b.y + 6, b.w * 1.5, b.d * 1.5, 0, 0, TAU); octx.fill();
      });
      octx.globalAlpha = 0.26; octx.strokeStyle = '#4a4436'; octx.lineCap = 'round';
      W.roads.forEach(r => {
        octx.lineWidth = r.w * 2.1;
        octx.beginPath(); r.smooth.forEach((p, k) => k ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]));
        octx.stroke();
      });
      octx.globalAlpha = 0.18; octx.lineWidth = 16;
      octx.beginPath();
      W.streets.forEach(s => { octx.moveTo(s.a[0], s.a[1]); octx.lineTo(s.b[0], s.b[1]); });
      octx.stroke();
      octx.restore();

      this.terrain = off;
    },

    /* ───────────────────── camera helpers ───────────────────── */
    applyCam(ctx) {
      const c = this.cam, d = this.dpr;
      ctx.setTransform(c.z * d, 0, 0, c.z * d,
        (-c.x * c.z + this.w / 2) * d, (-c.y * c.z + this.h / 2) * d);
    },
    s2w(sx, sy) {
      const c = this.cam;
      return { x: (sx - this.w / 2) / c.z + c.x, y: (sy - this.h / 2) / c.z + c.y };
    },
    w2s(wx, wy) {
      const c = this.cam;
      return { x: (wx - c.x) * c.z + this.w / 2, y: (wy - c.y) * c.z + this.h / 2 };
    },
    viewBounds() {
      const a = this.s2w(0, 0), b = this.s2w(this.w, this.h);
      return { x0: a.x - 80, y0: a.y - 240, x1: b.x + 80, y1: b.y + 80 };
    },

    hitTest(wx, wy) {
      for (const n of this.hitOrder) {
        const x0 = n.x - n.w / 2, x1 = n.x + n.w / 2 + n.h * LX;
        const y0 = n.y - n.d / 2 - n.h * LY, y1 = n.y + n.d / 2;
        if (wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1) return n;
      }
      return null;
    },

    /* ───────────────────────── frame ───────────────────────── */
    frame(S, dtReal) {
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (vw && vh && (vw !== this.w || vh !== this.h)) this.resize();
      if (!this.w || !this.h) return;

      const ctx = this.ctx;
      const c = this.cam;
      c.z += (c.tz - c.z) * clamp01(dtReal * 12);
      c.x += (c.tx - c.x) * clamp01(dtReal * 14);
      c.y += (c.ty - c.y) * clamp01(dtReal * 14);
      this.time += dtReal;

      const L = lighting(S);
      this.darkness = L.night;
      this.sun = sunVec(S);
      this.glows.length = 0;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const bg = ctx.createRadialGradient(this.w / 2, this.h / 2, 0,
                                          this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      bg.addColorStop(0, L.off0); bg.addColorStop(1, L.off1);
      ctx.fillStyle = bg; ctx.fillRect(0, 0, this.w, this.h);

      this.applyCam(ctx);
      const V = this.viewBounds();
      const z = c.z;

      /* ── ground ── */
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 40 / z; ctx.shadowOffsetY = 8 / z;
      ctx.fillStyle = '#0b1018'; ctx.fillRect(0, 0, W.w, W.h);
      ctx.restore();
      ctx.drawImage(this.terrain, 0, 0, W.w, W.h);

      drawBurnScar(ctx, S);
      drawLake(ctx, S, this.time);
      drawMarsh(ctx, S, this.time);
      drawRiver(ctx, S, this.time);
      drawCanal(ctx, S, this.time);
      drawFields(ctx, S, this.time, V, z);
      drawCanopyMass(ctx, S, z);
      drawStreets(ctx, z, V);
      drawRoads(ctx, z);
      drawRail(ctx, z);

      /* ── depth-sorted solids ── */
      const D = this.drawables; D.length = 0;
      const SH = this.shadowPass; SH.length = 0;
      collectTrees(D, S, V, z, this.time, SH);
      collectBuildings(D, S, V, z, SH);
      collectProps(D, S, V, z, SH);
      collectLandmarks(D, S, V, z, this.time);
      collectNodes(D, S, V, z, this.time);
      if (this.layers.people && z > 0.34) collectAgents(D, S, V, z, this.time);
      if (z > 0.40) collectLamps(D, S, V, z);
      collectParticles(D, S, V, z);
      // Shadows first, as a single union-filled path: a neighbour drawn later
      // must not paint over them, and one fill beats a thousand.
      if (SH.length && this.sun.up) {
        ctx.fillStyle = 'rgba(24,28,38,' + this.sun.a + ')';
        const CHUNK = 16;
        for (let i = 0; i < SH.length; i += CHUNK) {
          const end = Math.min(i + CHUNK, SH.length);
          ctx.beginPath();
          for (let j = i; j < end; j++) SH[j](ctx);
          ctx.fill();
        }
      }
      D.sort((a, b) => a.y - b.y);
      for (let i = 0; i < D.length; i++) D[i].f(ctx, this);

      /* ── night tint ── */
      if (L.tintA > 0.01) {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = 'rgba(' + L.tint + ',' + L.tintA + ')';
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.globalCompositeOperation = 'source-over';
      }

      /* ── emissive pass ── */
      if (this.glows.length) {
        this.applyCam(ctx);
        ctx.globalCompositeOperation = 'lighter';
        for (const g of this.glows) {
          const rad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
          rad.addColorStop(0, 'rgba(' + g.c + ',' + g.a + ')');
          rad.addColorStop(1, 'rgba(' + g.c + ',0)');
          ctx.fillStyle = rad;
          ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, TAU); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      if (this.layers.haze) drawHaze(ctx, S, this);

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (S.rain > 0.03) drawRain(ctx, S, this);

      this.applyCam(ctx);
      if (this.layers.wind) drawWindField(ctx, S, this.time, V);
      if (this.layers.heat) drawHeat(ctx, S);
      if (this.layers.links) drawLinks(ctx, S, this.time, this);
      if (SIM.ripple) drawRipple(ctx, S);
      drawSelection(ctx, this);
      if (this.layers.labels) drawLabels(ctx, S, this, z);

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const vg = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.44,
                                          this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.80);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.48)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, this.w, this.h);
    }
  };

  /* ═══════════════════════ light ═══════════════════════ */

  function sunVec(S) {
    const h = S.d.hod;
    const t = clamp01((h - 5.4) / 13.2);
    const elev = Math.sin(Math.PI * t);
    const up = h > 5.4 && h < 18.6;
    const len = 0.5 + 2.1 * (1 - elev);
    return { dx: -Math.cos(Math.PI * t) * len, dy: 0.40 * len, elev, up,
             a: up ? clamp01(0.15 + elev * 0.20) : 0.10 };
  }

  function lighting(S) {
    const h = S.d.hod;
    const dawn = smoothstep(4.6, 7.2, h), dusk = 1 - smoothstep(17.2, 20.0, h);
    const day = clamp01(dawn * dusk);
    const golden = clamp01(Math.max(smoothstep(5.2, 6.6, h) * (1 - smoothstep(6.6, 8.4, h)),
                                    smoothstep(16.4, 18.2, h) * (1 - smoothstep(18.2, 19.6, h))));
    let tint = '48,64,124', tintA = (1 - day) * 0.66;
    if (golden > 0.05 && day > 0.15) { tint = '255,176,120'; tintA = Math.max(tintA, golden * 0.26); }
    return {
      day, golden, night: 1 - day,
      off0: dim('#141b28', 0.55 + day * 0.55),
      off1: dim('#070a11', 0.60 + day * 0.50),
      tint, tintA
    };
  }
  function hex2rgb(h) { return [parseInt(h.substr(1,2),16), parseInt(h.substr(3,2),16), parseInt(h.substr(5,2),16)]; }
  function dim(c, k) { const m = hex2rgb(c); return css([m[0]*k, m[1]*k, m[2]*k]); }

  /* ═══════════════════ core solid renderer ═══════════════════ */

  function quadOf(cx, cy, w, d, rot) {
    const s = Math.sin(rot || 0), c = Math.cos(rot || 0);
    const hw = w / 2, hd = d / 2;
    const p = [[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd]];
    return p.map(q => [cx + q[0]*c - q[1]*s, cy + q[0]*s + q[1]*c]);
  }

  /** Append shadow geometry to the current path (no fill). */
  function shadowPath(ctx, pts, h, sun, simple) {
    if (!sun.up || h < 1) return;
    const dx = sun.dx * h, dy = sun.dy * h;
    if (!simple) {
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i+1)%4];
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0]+dx, b[1]+dy); ctx.lineTo(a[0]+dx, a[1]+dy); ctx.closePath();
      }
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.moveTo(pts[0][0]+dx, pts[0][1]+dy);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0]+dx, pts[i][1]+dy);
    ctx.closePath();
  }

  /** Standalone shadow for the sparse painters that draw inline. */
  function castShadow(ctx, pts, h, sun, simple) {
    if (!sun.up || h < 1) return;
    ctx.fillStyle = 'rgba(24,28,38,' + sun.a + ')';
    ctx.beginPath();
    shadowPath(ctx, pts, h, sun, simple);
    ctx.fill();
  }

  /** Soft elliptical shadow for round things, batched into the current path. */
  function shadowBlob(ctx, x, y, h, rx, ry, sun) {
    const cx = x + sun.dx * h, cy = y + sun.dy * h;
    ctx.moveTo(cx + rx, cy);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  }

  /** Which of the four side faces the camera can see, with a shade factor. */
  function faceInfo(pts) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i+1)%4];
      const ex = b[0]-a[0], ey = b[1]-a[1];
      const L = Math.hypot(ex, ey) || 1;
      const nx = ey / L, ny = -ex / L;
      if (nx * VX + ny * VY > 0.001) out.push({ a, b, i, k: 0.50 + 0.44 * clamp01(nx * 0.25 + ny * 0.97) });
    }
    return out;
  }

  function poly(ctx, arr, fill) {
    ctx.beginPath();
    ctx.moveTo(arr[0][0], arr[0][1]);
    for (let i = 1; i < arr.length; i++) ctx.lineTo(arr[i][0], arr[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }

  const mid = (a, b) => [(a[0]+b[0])/2, (a[1]+b[1])/2];

  /** Glazing on one wall face, in face-local (u along the edge, v up). */
  const _winDark = [], _winLit = [];
  function faceWindows(ctx, f, h, o) {
    const cols = Math.max(1, Math.round(Math.hypot(f.b[0]-f.a[0], f.b[1]-f.a[1]) / 13));
    const rows = o.storeys;
    const dark = R.darkness;
    const litP = o.lit === undefined ? 0 : o.lit;
    const seed = Math.abs((f.a[0] * 7 + f.a[1] * 13) | 0);
    const P = (u, v) => lift(f.a[0] + (f.b[0]-f.a[0]) * u, f.a[1] + (f.b[1]-f.a[1]) * u, h * v);
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const u0 = (cI + 0.26) / cols, u1 = (cI + 0.74) / cols;
        const v0 = (r + 0.30) / rows, v1 = (r + 0.78) / rows;
        const on = litP > 0 && (((seed + r * 7 + cI * 3) % 10) / 10) < litP;
        (on ? _winLit : _winDark).push(P(u0,v0), P(u1,v0), P(u1,v1), P(u0,v1));
        if (on && dark > 0.2 && ((r + cI) & 1) === 0) {
          const g = P((u0+u1)/2, (v0+v1)/2);
          R.glows.push({ x: g[0], y: g[1], r: 20, c: '255,196,116', a: 0.20 * dark });
        }
      }
    }
    if (o.door) _winDark.push(P(0.44,0.02), P(0.56,0.02), P(0.56,0.30), P(0.44,0.30));
  }

  /** Flush the accumulated glazing as two fills instead of dozens. */
  function flushWindows(ctx) {
    for (let pass = 0; pass < 2; pass++) {
      const arr = pass ? _winLit : _winDark;
      if (!arr.length) continue;
      ctx.fillStyle = pass ? 'rgba(255,208,132,' + (0.5 + R.darkness * 0.45) + ')'
                           : 'rgba(38,48,66,0.60)';
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 4) {
        ctx.moveTo(arr[i][0], arr[i][1]);
        ctx.lineTo(arr[i+1][0], arr[i+1][1]);
        ctx.lineTo(arr[i+2][0], arr[i+2][1]);
        ctx.lineTo(arr[i+3][0], arr[i+3][1]);
        ctx.closePath();
      }
      ctx.fill();
      arr.length = 0;
    }
  }

  /** A cheap box with no roof logic — chimneys, bins, transformers. */
  function solidPlain(ctx, pts, h, rgb) {
    for (const f of faceInfo(pts)) {
      const la = lift(f.a[0], f.a[1], h), lb = lift(f.b[0], f.b[1], h);
      poly(ctx, [f.a, f.b, lb, la], css([rgb[0]*f.k, rgb[1]*f.k, rgb[2]*f.k]));
    }
    poly(ctx, pts.map(p => lift(p[0], p[1], h)), css(mixRGB(rgb, [255,250,240], 0.14)));
  }

  /**
   * The workhorse. An extruded quad with a pitched, hipped, flat or
   * mono-pitch roof, plus optional glazing and a chimney.
   */
  function solid(ctx, pts, h, o) {
    o = o || {};
    const pal = o.pal || PALETTES.render;
    const wallRGB = o.wall || pal.wall;
    const roofRGB = o.roof || pal.roof;
    const tint = ((o.tone === undefined ? 0.5 : o.tone) - 0.5) * 16;
    const wall = [wallRGB[0]+tint, wallRGB[1]+tint, wallRGB[2]+tint];

    const faces = faceInfo(pts);
    const lifted = pts.map(p => lift(p[0], p[1], h));

    for (const f of faces) {
      const la = lift(f.a[0], f.a[1], h), lb = lift(f.b[0], f.b[1], h);
      poly(ctx, [f.a, f.b, lb, la], css([wall[0]*f.k, wall[1]*f.k, wall[2]*f.k]));
      if (o.windows && o.storeys) faceWindows(ctx, f, h, o);
    }
    if (o.windows && o.storeys) flushWindows(ctx);

    const rh = o.roofH || 0;
    const rt = o.roofType || 'flat';

    if (rt === 'flat' || rh < 1) {
      poly(ctx, lifted, css(mixRGB(roofRGB, [255,250,240], 0.10)));
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lifted[0][0], lifted[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(lifted[i][0], lifted[i][1]);
      ctx.closePath(); ctx.stroke();
      if (o.roofClutter) {
        const c = mid(mid(pts[0],pts[2]), mid(pts[1],pts[3]));
        const p = lift(c[0], c[1], h);
        ctx.fillStyle = 'rgba(90,94,104,0.9)'; ctx.fillRect(p[0]-6, p[1]-5, 12, 8);
      }
    } else if (rt === 'shed') {
      const C = lift(pts[2][0], pts[2][1], h + rh), Dd = lift(pts[3][0], pts[3][1], h + rh);
      poly(ctx, [lifted[0], lifted[1], C, Dd], css(mixRGB(roofRGB, [255,250,240], 0.20)));
      poly(ctx, [lifted[1], lift(pts[2][0],pts[2][1],h), C], css(mixRGB(roofRGB, [0,0,0], 0.30)));
      poly(ctx, [lifted[0], lift(pts[3][0],pts[3][1],h), Dd], css(mixRGB(roofRGB, [0,0,0], 0.42)));
    } else {
      // gable / hip — the ridge runs parallel to edge p0→p1
      const m03 = mid(pts[0], pts[3]), m12 = mid(pts[1], pts[2]);
      let r1 = m03, r2 = m12;
      if (rt === 'hip') {
        r1 = [m03[0] + (m12[0]-m03[0])*0.22, m03[1] + (m12[1]-m03[1])*0.22];
        r2 = [m12[0] + (m03[0]-m12[0])*0.22, m12[1] + (m03[1]-m12[1])*0.22];
      }
      const R1 = lift(r1[0], r1[1], h + rh), R2 = lift(r2[0], r2[1], h + rh);
      [{ q:[lifted[0], lifted[1], R2, R1], e:0 }, { q:[lifted[2], lifted[3], R1, R2], e:2 }]
        .forEach(sl => {
          const a = pts[sl.e], b = pts[(sl.e+1)%4];
          const ex = b[0]-a[0], ey = b[1]-a[1], L = Math.hypot(ex,ey)||1;
          const k = 0.62 + 0.40 * clamp01((ey/L)*0.2 + (-ex/L)*0.98);
          poly(ctx, sl.q, css([roofRGB[0]*k, roofRGB[1]*k, roofRGB[2]*k]));
        });
      if (R.cam.z > 0.62) {
        poly(ctx, [lifted[3], lifted[0], R1], css(mixRGB(wall, [0,0,0], 0.30)));
        poly(ctx, [lifted[1], lifted[2], R2], css(mixRGB(wall, [0,0,0], 0.18)));
      }
      if (R.cam.z > 0.8) {
        ctx.strokeStyle = 'rgba(255,250,240,0.20)'; ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(R1[0], R1[1]); ctx.lineTo(R2[0], R2[1]); ctx.stroke();
      }

      if (o.chimney && R.cam.z > 0.88) {
        const cp = [mix(r1[0], r2[0], 0.24), mix(r1[1], r2[1], 0.24)];
        solidPlain(ctx, quadOf(cp[0], cp[1], 7, 6, o.rot || 0), h + rh + 9, [116, 92, 84]);
      }
    }
  }

  /* ═══════════════════════ water ═══════════════════════ */

  function polyCentroid(p) { let x=0,y=0; p.forEach(q=>{x+=q[0];y+=q[1];}); return [x/p.length, y/p.length]; }
  function insetPoly(p, k) {
    const c = polyCentroid(p);
    return p.map(q => [c[0] + (q[0]-c[0])*(1-k), c[1] + (q[1]-c[1])*(1-k)]);
  }
  function tracePoly(ctx, p) {
    ctx.beginPath();
    p.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
    ctx.closePath();
  }

  function drawLake(ctx, S, t) {
    tracePoly(ctx, W.lake);
    ctx.fillStyle = 'rgba(126,112,82,0.9)'; ctx.fill();
    ctx.save(); tracePoly(ctx, W.lake); ctx.clip();
    ctx.fillStyle = 'rgba(100,88,62,0.55)';
    for (let i = 0; i < 34; i++) {
      const a = i * 137.5, r = 60 + i * 30;
      ctx.beginPath();
      ctx.ellipse(1800 + Math.cos(a)*r, 400 + Math.sin(a)*r*0.45, 42 + (i%5)*13, 10, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    const wet = insetPoly(W.lake, (1 - S.reservoir) * 0.28);
    tracePoly(ctx, wet);
    const g = ctx.createLinearGradient(1150, 150, 2500, 660);
    g.addColorStop(0, '#1c5c7c'); g.addColorStop(0.5, '#26769a'); g.addColorStop(1, '#194f6e');
    ctx.fillStyle = g; ctx.fill();

    ctx.save(); tracePoly(ctx, wet); ctx.clip();
    ctx.globalAlpha = 0.12; ctx.strokeStyle = '#bfeaf7'; ctx.lineWidth = 1.8;
    for (let i = 0; i < 26; i++) {
      const y = 170 + i * 20 + Math.sin(t*0.7 + i) * 3;
      ctx.beginPath();
      for (let x = 1140; x < 2500; x += 34) {
        const yy = y + Math.sin((x + t*36) / 70 + i*0.6) * 3;
        x === 1140 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(190,228,242,.30)'; ctx.lineWidth = 3; tracePoly(ctx, wet); ctx.stroke();
    ctx.restore();
  }

  function drawMarsh(ctx, S, t) {
    const hp = S.marshHp;
    tracePoly(ctx, W.marsh);
    ctx.fillStyle = css(mixRGB([124,114,80], [82,132,106], hp), 0.9); ctx.fill();
    ctx.save(); ctx.clip();
    const rr = makeRNG(808);
    ctx.globalAlpha = 0.55 * hp; ctx.fillStyle = '#4f9cb2';
    for (let i = 0; i < 22; i++) {
      ctx.beginPath();
      ctx.ellipse(1330 + rr()*350, 1900 + rr()*380, 16 + rr()*34, 8 + rr()*13, 0, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css(mixRGB([134,120,78], [104,178,126], hp), 0.8);
    ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (let i = 0; i < 420; i++) {
      const x = 1310 + rr()*400, y = 1870 + rr()*430;
      const s = 6 + rr()*11 * (0.4 + hp*0.8);
      const sw = Math.sin(t*1.4 + i) * S.wind * 3.4;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sw, y - s); ctx.stroke();
    }
    ctx.restore();
  }

  function strokePath(ctx, pts, width, style) {
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.lineWidth = width; ctx.strokeStyle = style; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawRiver(ctx, S, t) {
    const flow = S.d.riverFlow || 0;
    const w = 12 + clamp(flow, 0, 60) * 0.55;
    const dry = clamp01(1 - flow / 8);
    strokePath(ctx, W.smoothRiver, w + 14, 'rgba(112,100,74,0.5)');
    strokePath(ctx, W.smoothRiver, w + 6, 'rgba(138,126,94,0.55)');
    if (dry < 0.98) {
      strokePath(ctx, W.smoothRiver, w, css(mixRGB([132,118,88], [40,116,144], 1 - dry)));
      ctx.save();
      ctx.globalAlpha = 0.42 * (1 - dry);
      ctx.setLineDash([22, 40]); ctx.lineDashOffset = -t * 46;
      strokePath(ctx, W.smoothRiver, Math.max(2, w * 0.30), '#cdeef8');
      ctx.setLineDash([]); ctx.restore();
    }
  }

  function drawCanal(ctx, S, t) {
    const d = S.d.canalDraw || 0;
    const w = 5 + clamp(d, 0, 22) * 0.5;
    strokePath(ctx, W.smoothCanal, w + 8, 'rgba(116,104,78,0.55)');
    if (d > 0.4) {
      strokePath(ctx, W.smoothCanal, w, '#32869f');
      ctx.save(); ctx.globalAlpha = 0.45;
      ctx.setLineDash([14, 28]); ctx.lineDashOffset = -t * 38;
      strokePath(ctx, W.smoothCanal, Math.max(1.2, w * 0.4), '#bfe8f4');
      ctx.setLineDash([]); ctx.restore();
    }
  }

  function drawFields(ctx, S, t, V, z) {
    const y = S.yield;
    const lush = mixRGB([146,128,80], [92,156,64], clamp01(y * 1.15));
    const dead = [140,120,84];
    W.fields.forEach((f, i) => {
      if (f.x + f.w < V.x0 || f.x - f.w > V.x1 || f.y + f.d < V.y0 || f.y - f.d > V.y1) return;
      const local = clamp01(y + ((i % 7) - 3) * 0.045);
      const col = mixRGB(dead, lush, local);
      ctx.save();
      ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      ctx.fillStyle = css(col, 0.95);
      ctx.fillRect(-f.w/2, -f.d/2, f.w, f.d);
      if (z > 0.3) {
        ctx.strokeStyle = css(mixRGB(col, [30,34,22], 0.34), 0.55);
        ctx.lineWidth = 1.4;
        for (let r = 1; r < f.rows; r++) {
          const yy = -f.d/2 + (f.d / f.rows) * r;
          ctx.beginPath(); ctx.moveTo(-f.w/2 + 3, yy); ctx.lineTo(f.w/2 - 3, yy); ctx.stroke();
        }
      }
      if (f.hedge) {
        ctx.strokeStyle = css(mixRGB([56,80,48], [72,96,56], (i%3)/3), 0.85);
        ctx.lineWidth = 5;
        ctx.strokeRect(-f.w/2, -f.d/2, f.w, f.d);
      }
      if (local > 0.35 && S.wind > 0.25) {
        ctx.globalAlpha = 0.12 * S.wind; ctx.fillStyle = '#eef8cf';
        const ph = Math.sin(t*1.6 + f.x*0.01) * f.w * 0.3;
        ctx.fillRect(-f.w/2 + ph, -f.d/2, f.w*0.26, f.d);
      }
      ctx.restore();
    });
  }

  function drawStreets(ctx, z, V) {
    if (z < 0.22) return;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#57534a'; ctx.lineWidth = 15;
    ctx.beginPath();
    for (const s of W.streets) {
      if ((s.a[0] < V.x0 && s.b[0] < V.x0) || (s.a[0] > V.x1 && s.b[0] > V.x1)) continue;
      if ((s.a[1] < V.y0 && s.b[1] < V.y0) || (s.a[1] > V.y1 && s.b[1] > V.y1)) continue;
      ctx.moveTo(s.a[0], s.a[1]); ctx.lineTo(s.b[0], s.b[1]);
    }
    ctx.stroke();
    if (z > 0.6) { ctx.strokeStyle = 'rgba(180,174,158,0.16)'; ctx.lineWidth = 1; ctx.stroke(); }
  }

  function drawRoads(ctx, z) {
    W.roads.forEach(r => {
      strokePath(ctx, r.smooth, r.w + 7, 'rgba(44,40,32,0.42)');
      strokePath(ctx, r.smooth, r.w, '#514c43');
      if (z > 0.45) {
        ctx.save(); ctx.globalAlpha = 0.32;
        ctx.setLineDash([13, 18]);
        strokePath(ctx, r.smooth, 1.5, '#d3cbb4');
        ctx.setLineDash([]); ctx.restore();
      }
    });
  }

  function drawRail(ctx, z) {
    strokePath(ctx, W.smoothRail, 20, 'rgba(88,80,66,0.7)');
    if (z > 0.35) {
      ctx.strokeStyle = 'rgba(58,50,42,0.85)'; ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 2; i < W.smoothRail.length; i += 2) {
        const a = W.smoothRail[i-1], b = W.smoothRail[i];
        const ang = Math.atan2(b[1]-a[1], b[0]-a[0]);
        const nx = -Math.sin(ang)*8, ny = Math.cos(ang)*8;
        ctx.moveTo(b[0]-nx, b[1]-ny); ctx.lineTo(b[0]+nx, b[1]+ny);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,148,142,0.75)'; ctx.lineWidth = 1.6;
    for (const off of [-5, 5]) {
      ctx.beginPath();
      W.smoothRail.forEach((p, i) => {
        const q = W.smoothRail[Math.min(i+1, W.smoothRail.length-1)];
        const ang = Math.atan2(q[1]-p[1], q[0]-p[0]);
        const x = p[0] - Math.sin(ang)*off, y = p[1] + Math.cos(ang)*off;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  }

  function drawBurnScar(ctx, S) {
    if (S.fire <= 0.005) return;
    ctx.save();
    ctx.globalAlpha = clamp01(S.fire * 0.8);
    const g = ctx.createRadialGradient(820, 1360, 30, 820, 1360, 90 + S.fire * 460);
    g.addColorStop(0, 'rgba(58,26,14,0.9)'); g.addColorStop(1, 'rgba(58,26,14,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(820, 1360, 90 + S.fire * 460, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /* ═══════════════════════ vegetation ═══════════════════════ */

  /* At map scale individual trees read as dots, so the forest is underlaid
     with a soft mass that fades out as you zoom in — and shrinks with the
     canopy, so deforestation is legible from across the valley. */
  function drawCanopyMass(ctx, S, z) {
    if (z > 0.44 || !S.on.forest) return;
    const a = clamp01((0.44 - z) / 0.16) * 0.9 * clamp01(S.canopy * 1.2);
    if (a < 0.02) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = css(mixRGB([104, 124, 70], [44, 84, 54], clamp01(S.canopy)));
    const k = 0.70 + 0.36 * clamp01(S.canopy);
    const col = ctx.fillStyle;
    W.canopyBlobs.forEach(bl => {
      const r = bl[2] * k;
      const g = ctx.createRadialGradient(bl[0], bl[1], r * 0.45, bl[0], bl[1], r);
      g.addColorStop(0, col); g.addColorStop(1, css(mixRGB([104,124,70],[44,84,54], clamp01(S.canopy)), 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bl[0], bl[1], r, 0, TAU); ctx.fill();
    });
    ctx.restore();
  }

  function collectTrees(D, S, V, z, t, SH) {
    const canopy = S.canopy;
    const detail = z > 0.62;
    const sway = S.wind * 3.6;
    const step = z < 0.24 ? 6 : z < 0.32 ? 4 : z < 0.52 ? 2 : 1;
    const sun = R.sun;
    for (let i = 0; i < W.trees.length; i += step) {
      const tr = W.trees[i];
      if (tr.x < V.x0 || tr.x > V.x1 || tr.y < V.y0 || tr.y > V.y1) continue;
      let alive = true;
      if (tr.group === 'park') alive = S.on.park;
      else if (tr.group === 'orchard') alive = S.on.orchard;
      else if (tr.group === 'forest') alive = tr.rank < canopy;
      if (!alive && (tr.group !== 'forest' || tr.rank > canopy + 0.10)) continue;
      const fade = alive ? 1 : clamp01(1 - (tr.rank - canopy) / 0.10);
      const stress = tr.group === 'forest' ? clamp01((canopy - tr.rank) / 0.16) : 1;
      const burning = S.fire > 0 && Math.hypot(tr.x - 820, tr.y - 1360) < 460 * S.fire;
      if (detail && sun.up) {
        const hh = tr.h * (0.5 + fade * 0.5);
        SH.push((c2) => shadowBlob(c2, tr.x, tr.y, hh * 0.55, tr.r * 0.92, tr.r * 0.4, sun));
      }
      D.push({ y: tr.y, f: (c2) => drawTree(c2, tr, fade, stress, burning, sway, t, detail, sun) });
    }
  }

  function drawTree(ctx, tr, fade, stress, burning, sway, t, detail, sun) {
    const h = tr.h * (0.5 + fade * 0.5);
    const off = Math.sin(t * 1.3 + tr.sway) * sway;
    const [tx, ty] = lift(tr.x + off * 0.5, tr.y, h);
    ctx.globalAlpha = fade;

    if (detail && R.cam.z > 0.82) {
      ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = Math.max(1.2, tr.r * 0.24); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tr.x, tr.y); ctx.lineTo(tx, ty + tr.r * 0.45); ctx.stroke();
    }

    let base, hi;
    if (burning) { base = [168, 62, 24]; hi = [240, 148, 46]; }
    else {
      const green = tr.kind === 'pine' ? [40, 88, 56]
                  : tr.kind === 'apple' ? [78, 122, 62]
                  : tr.kind === 'willow' ? [96, 132, 74]
                  : [62, 114, 62];
      base = mixRGB(green, [130, 106, 54], clamp01(1 - stress) * 0.9);
      hi = mixRGB(base, [190, 228, 152], 0.44);
    }
    const ts = (tr.tone - 0.5) * 16;
    const bc = css([base[0]+ts, base[1]+ts, base[2]+ts]);

    if (tr.kind === 'pine') {
      const layers = (detail && R.cam.z > 0.9) ? 3 : 1;
      for (let l = 0; l < layers; l++) {
        const f = 1 - l * 0.26;
        const cy = ty + tr.r * (0.5 + l * 0.55);
        ctx.fillStyle = bc;
        ctx.beginPath();
        ctx.moveTo(tx, cy - tr.r * 1.55 * f);
        ctx.lineTo(tx + tr.r * f, cy + tr.r * 0.4);
        ctx.lineTo(tx - tr.r * f, cy + tr.r * 0.4);
        ctx.closePath(); ctx.fill();
      }
      if (detail) {
        ctx.fillStyle = css(hi, 0.5);
        ctx.beginPath(); ctx.moveTo(tx, ty - tr.r * 1.55);
        ctx.lineTo(tx + tr.r * 0.42, ty + tr.r * 0.1); ctx.lineTo(tx, ty + tr.r * 0.1);
        ctx.closePath(); ctx.fill();
      }
    } else if (tr.kind === 'poplar') {
      ctx.fillStyle = bc;
      ctx.beginPath(); ctx.ellipse(tx, ty, tr.r * 0.62, tr.r * 1.5, 0, 0, TAU); ctx.fill();
      if (detail) {
        ctx.fillStyle = css(hi, 0.45);
        ctx.beginPath(); ctx.ellipse(tx + tr.r*0.2, ty - tr.r*0.4, tr.r*0.32, tr.r*0.8, 0, 0, TAU); ctx.fill();
      }
    } else {
      ctx.fillStyle = bc;
      if (detail && R.cam.z > 1.1) {
        ctx.beginPath(); ctx.arc(tx - tr.r*0.4, ty + tr.r*0.2, tr.r*0.72, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(tx + tr.r*0.45, ty + tr.r*0.1, tr.r*0.66, 0, TAU); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(tx, ty, tr.r, 0, TAU); ctx.fill();
      if (detail) {
        ctx.fillStyle = css(hi, 0.55);
        ctx.beginPath(); ctx.arc(tx + tr.r*0.28, ty - tr.r*0.32, tr.r*0.55, 0, TAU); ctx.fill();
      }
      if (tr.kind === 'apple' && detail && !burning) {
        ctx.fillStyle = 'rgba(206,72,58,0.85)';
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(tx + Math.cos(k*2.1+tr.sway)*tr.r*0.55, ty + Math.sin(k*2.1+tr.sway)*tr.r*0.5, 1.6, 0, TAU);
          ctx.fill();
        }
      }
    }
    if (burning) R.glows.push({ x: tx, y: ty, r: tr.r * 4, c: '255,140,40', a: 0.5 });
    ctx.globalAlpha = 1;
  }

  /* ═══════════════════════ built fabric ═══════════════════════ */

  function collectBuildings(D, S, V, z, SH) {
    const night = S.d.isNight;
    const lit = night ? clamp01(S.d.served * 1.1) * 0.72 : 0;
    const detail = z > 0.70;
    const tiny = z < 0.34;
    const sun = R.sun;
    for (const b of W.buildings) {
      if (b.owner && !S.on[b.owner]) continue;
      if (b.x + b.w < V.x0 || b.x - b.w > V.x1 || b.y + b.d < V.y0 || b.y - b.d - b.h > V.y1) continue;
      const pts = quadOf(b.x, b.y, b.w, b.d, b.rot);
      if (!tiny) SH.push((ctx) => shadowPath(ctx, pts, b.h + (b.roofH || 0) * 0.6, sun, !detail));
      D.push({ y: b.y, f: (ctx) => {
        solid(ctx, pts, b.h, {
          pal: PALETTES[b.pal] || PALETTES.render,
          roofType: tiny ? 'flat' : b.roof,
          roofH: b.roofH, tone: b.tone, rot: b.rot,
          chimney: detail && b.chimney,
          windows: detail, storeys: b.storeys,
          lit: lit * (0.45 + b.lit * 0.85),
          door: detail && b.type !== 'shed'
        });
        if (detail && b.awning) {
          const f = faceInfo(pts)[0];
          if (f) {
            const la = lift(f.a[0], f.a[1], 11), lb = lift(f.b[0], f.b[1], 11);
            const cols = ['#c1503f','#3f7cc1','#5aa860','#cfa03a','#8a5fb0'];
            poly(ctx, [f.a, f.b, lb, la], cols[(b.seedv * 5) | 0]);
          }
        }
      }});
    }
  }

  function collectProps(D, S, V, z, SH) {
    if (z < 0.50) return;
    const detail = z > 0.72;
    const fine = z > 0.92;
    const sun = R.sun;
    for (const p of W.props) {
      if (!fine && (p.kind === 'bin' || p.kind === 'bench')) continue;
      if (p.owner && !S.on[p.owner]) continue;
      if (p.x < V.x0 - 40 || p.x > V.x1 + 40 || p.y < V.y0 - 40 || p.y > V.y1 + 40) continue;
      if (sun.up && detail) {
        if (p.kind === 'shed') {
          const q = quadOf(p.x, p.y, p.w, p.d, p.rot);
          SH.push((ctx) => shadowPath(ctx, q, p.h, sun, true));
        } else if (p.kind === 'gardentree') {
          SH.push((ctx) => shadowBlob(ctx, p.x, p.y, p.h * 0.5, p.r * 0.9, p.r * 0.4, sun));
        } else if (p.kind === 'hedge' || p.kind === 'wall') {
          const q = quadOf(p.x, p.y, p.w, 5, p.rot);
          SH.push((ctx) => shadowPath(ctx, q, p.h, sun, true));
        }
      }
      D.push({ y: p.y, f: (ctx) => {
        if (p.kind === 'hedge' || p.kind === 'wall') {
          const q = quadOf(p.x, p.y, p.w, 5, p.rot);
          const c = p.kind === 'hedge' ? [64, 100, 56] : [176, 168, 150];
          poly(ctx, [q[3], q[2], lift(q[2][0], q[2][1], p.h), lift(q[3][0], q[3][1], p.h)],
               css([c[0]*0.72, c[1]*0.72, c[2]*0.72]));
          poly(ctx, q.map(v => lift(v[0], v[1], p.h)), css(mixRGB(c, [255,250,240], 0.16)));
        } else if (p.kind === 'gardentree') {
          const [tx, ty] = lift(p.x, p.y, p.h);
          ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty + p.r*0.4); ctx.stroke();
          ctx.fillStyle = css(mixRGB([70,120,64], [104,146,72], p.tone));
          ctx.beginPath(); ctx.arc(tx, ty, p.r, 0, TAU); ctx.fill();
        } else if (p.kind === 'shed') {
          solid(ctx, quadOf(p.x, p.y, p.w, p.d, p.rot), p.h, { pal: PALETTES.shed, roofType:'shed', roofH: 5, tone: 0.5 });
        } else if (p.kind === 'parked') {
          drawCar(ctx, p.x, p.y, p.rot,
                  ['#d8dde6','#9aa6bb','#b4553f','#3f6fc4','#4d4f57','#c9a24b'][(p.tone*6)|0]);
        } else if (p.kind === 'bin') {
          solidPlain(ctx, quadOf(p.x, p.y, 5, 4, p.rot), 7, [70, 92, 78]);
        } else if (p.kind === 'bench') {
          solidPlain(ctx, quadOf(p.x, p.y, 11, 3.4, p.rot), 4, [122, 92, 62]);
        }
      }});
    }
  }

  /* ═══════════════════════ landmarks ═══════════════════════ */

  function collectLandmarks(D, S, V, z, t) {
    const sun = R.sun;
    for (const L of W.landmarks) {
      if (L.x < V.x0 - 140 || L.x > V.x1 + 140 || L.y < V.y0 - 260 || L.y > V.y1 + 140) continue;
      D.push({ y: L.y, f: (ctx) => LANDMARK[L.kind](ctx, L, S, t, sun) });
    }
  }

  const LANDMARK = {
    church(ctx, L, S, t, sun) {
      const nave = quadOf(L.x, L.y, 96, 46, L.rot);
      castShadow(ctx, nave, 46, sun);
      solid(ctx, nave, 40, { pal: PALETTES.stone, roofType:'gable', roofH: 20, tone:.5,
                             windows:true, storeys:1, lit: R.darkness > .3 ? .5 : 0 });
      const cx = L.x - 54 * Math.cos(L.rot), cy = L.y - 54 * Math.sin(L.rot);
      const tw = quadOf(cx, cy, 30, 30, L.rot);
      castShadow(ctx, tw, 118, sun);
      solid(ctx, tw, 96, { pal: PALETTES.stone, roofType:'flat', tone:.5 });
      const apex = lift(cx, cy, 158);
      const base = tw.map(p => lift(p[0], p[1], 96));
      for (let i = 0; i < 4; i++) {
        const a = base[i], b = base[(i+1)%4];
        const k = a[0] > b[0] ? 0.9 : 0.62;
        poly(ctx, [a, b, apex], css([74*k, 78*k, 92*k]));
      }
      ctx.strokeStyle = '#e8e2d4'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(apex[0], apex[1]-12); ctx.lineTo(apex[0], apex[1]-2);
      ctx.moveTo(apex[0]-5, apex[1]-8); ctx.lineTo(apex[0]+5, apex[1]-8); ctx.stroke();
    },
    townhall(ctx, L, S, t, sun) {
      const q = quadOf(L.x, L.y, 130, 74, L.rot);
      castShadow(ctx, q, 66, sun);
      solid(ctx, q, 58, { pal: PALETTES.civic, roofType:'hip', roofH: 16, tone:.5,
                          windows:true, storeys:3, lit: R.darkness > .3 ? .55 : 0, door:true });
      const f = faceInfo(q)[0];
      if (f) {
        ctx.strokeStyle = 'rgba(240,238,230,0.85)'; ctx.lineWidth = 3.4;
        for (let i = 1; i <= 4; i++) {
          const u = i / 5;
          const x = f.a[0] + (f.b[0]-f.a[0])*u, y = f.a[1] + (f.b[1]-f.a[1])*u;
          const a = lift(x, y, 0), b = lift(x, y, 36);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      }
      const cl = lift(L.x, L.y - 10, 76);
      ctx.fillStyle = '#3a3f48'; ctx.beginPath(); ctx.arc(cl[0], cl[1], 9, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#e8e2d4'; ctx.lineWidth = 1.4;
      const ha = (S.d.hod / 12) * TAU - Math.PI/2;
      ctx.beginPath(); ctx.moveTo(cl[0], cl[1]); ctx.lineTo(cl[0]+Math.cos(ha)*6, cl[1]+Math.sin(ha)*6); ctx.stroke();
    },
    mill(ctx, L, S, t, sun) {
      const q = quadOf(L.x, L.y, 40, 40, L.rot);
      castShadow(ctx, q, 76, sun);
      solid(ctx, q, 64, { pal: PALETTES.brick, roofType:'hip', roofH: 14, tone:.4 });
      const c = lift(L.x, L.y, 74);
      const a = t * (0.3 + S.wind * 2.2);
      ctx.strokeStyle = '#e2ded2'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const aa = a + i * Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(c[0], c[1]);
        ctx.lineTo(c[0] + Math.cos(aa)*32, c[1] + Math.sin(aa)*29); ctx.stroke();
      }
    },
    watermill(ctx, L, S, t, sun) {
      const q = quadOf(L.x, L.y, 52, 40, L.rot);
      castShadow(ctx, q, 44, sun);
      solid(ctx, q, 36, { pal: PALETTES.stone, roofType:'gable', roofH: 13, tone:.5, chimney:true, rot:L.rot });
      const c = lift(L.x - 32, L.y + 8, 16);
      const a = t * (0.6 + clamp01((S.d.riverFlow||0)/40) * 3);
      ctx.strokeStyle = '#6b5a44'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(c[0], c[1], 18, 0, TAU); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const aa = a + i * TAU / 8;
        ctx.beginPath(); ctx.moveTo(c[0], c[1]);
        ctx.lineTo(c[0]+Math.cos(aa)*18, c[1]+Math.sin(aa)*18); ctx.stroke();
      }
    },
    barn(ctx, L, S, t, sun) {
      const q = quadOf(L.x, L.y, 84, 52, L.rot);
      castShadow(ctx, q, 52, sun);
      solid(ctx, q, 40, { wall:[142, 74, 62], roof:[74, 60, 54], roofType:'gable', roofH: 20, tone:.5 });
    },
    silo(ctx, L, S, t, sun) {
      const q = quadOf(L.x, L.y, 30, 30, L.rot);
      castShadow(ctx, q, 88, sun);
      for (const f of faceInfo(q)) {
        const la = lift(f.a[0], f.a[1], 78), lb = lift(f.b[0], f.b[1], 78);
        poly(ctx, [f.a, f.b, lb, la], css([196*f.k, 200*f.k, 206*f.k]));
      }
      poly(ctx, q.map(p => lift(p[0], p[1], 78)), '#b9bec6');
      const cap = lift(L.x, L.y, 96);
      ctx.fillStyle = '#9aa0a8';
      ctx.beginPath(); ctx.ellipse(cap[0], cap[1], 17, 9, 0, 0, TAU); ctx.fill();
    },
    pylon(ctx, L, S, t, sun) {
      const top = lift(L.x, L.y, 108);
      ctx.strokeStyle = 'rgba(150,156,166,0.9)'; ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(L.x-12, L.y); ctx.lineTo(top[0], top[1]); ctx.lineTo(L.x+12, L.y);
      ctx.stroke();
      ctx.lineWidth = 1.4;
      for (let k = 1; k <= 3; k++) {
        const y = k / 4;
        const l = lift(L.x - 12*(1-y), L.y, 108*y), r2 = lift(L.x + 12*(1-y), L.y, 108*y);
        ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(r2[0], r2[1]); ctx.stroke();
      }
      for (const hh of [72, 94]) {
        const arm = lift(L.x, L.y, hh);
        ctx.beginPath(); ctx.moveTo(arm[0]-28, arm[1]); ctx.lineTo(arm[0]+28, arm[1]); ctx.stroke();
      }
    }
  };

  /* ═══════════════════════ node structures ═══════════════════════ */

  const PAINT = {
    dam(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { wall:[146,145,140], roof:[176,175,168], roofType:'flat', tone:.5 });
      for (let i = -5; i <= 5; i++)
        solidPlain(ctx, quadOf(n.x + i * 34, n.y + n.d * 0.44, 15, 12, 0), n.h * 0.92, [128,127,122]);
      const open = S.d.spill > 0.5 || (S.on.dam && S.d.release > 12);
      for (let i = 0; i < 4; i++) {
        const p = lift(n.x - 96 + i * 64, n.y + n.d/2, n.h * 0.62);
        ctx.fillStyle = open ? '#2a6a86' : '#5a5954';
        ctx.fillRect(p[0]-17, p[1], 34, n.h * 0.6 * LY);
        if (open) {
          ctx.fillStyle = 'rgba(198,236,248,0.6)';
          ctx.fillRect(p[0]-15, p[1] + n.h*0.34*LY, 30, 9 + Math.sin(t*6+i)*3);
        }
      }
      if (!S.on.dam) { ctx.fillStyle = '#1d5570'; ctx.fillRect(n.x - 46, n.y - n.d/2 - 3, 92, n.d + 6); }
      ctx.strokeStyle = 'rgba(240,240,235,0.55)'; ctx.lineWidth = 1.6;
      const a = lift(n.x - n.w/2, n.y - n.d/2, n.h + 6), b = lift(n.x + n.w/2, n.y - n.d/2, n.h + 6);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    },

    powerhouse(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { pal: PALETTES.slate, roofType:'shed', roofH: 10, tone:.5,
                           windows:true, storeys:2, lit: R.darkness>.3 ? .6 : 0 });
      ctx.strokeStyle = '#6d7681'; ctx.lineWidth = 13; ctx.lineCap = 'round';
      const a = lift(n.x - 30, n.y - n.d/2, n.h * 0.6);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(1900, 716); ctx.stroke();
      ctx.strokeStyle = '#8b939e'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(1900, 716); ctx.stroke();
      if (S.d.hydroMW > 0.2) {
        const c = lift(n.x + 20, n.y - 8, n.h + 12);
        ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(t * (1.2 + S.d.hydroMW * 0.5));
        ctx.strokeStyle = 'rgba(255,200,110,0.9)'; ctx.lineWidth = 2.6;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo(0,0);
          ctx.lineTo(Math.cos(i*Math.PI/2)*12, Math.sin(i*Math.PI/2)*12); ctx.stroke();
        }
        ctx.restore();
        R.glows.push({ x:c[0], y:c[1], r:34, c:'255,190,90', a:0.30*clamp01(S.d.hydroMW/10) });
      }
    },

    wind(ctx, n, S, t, sun) {
      const spin = S.d.wcurve;
      W.turbines.forEach((tb, i) => {
        const top = lift(tb.x, tb.y, tb.h);
        if (sun.up) {
          ctx.strokeStyle = 'rgba(24,28,38,' + (sun.a*0.8) + ')'; ctx.lineWidth = 5;
          ctx.beginPath(); ctx.moveTo(tb.x, tb.y);
          ctx.lineTo(tb.x + sun.dx*tb.h, tb.y + sun.dy*tb.h); ctx.stroke();
        }
        ctx.strokeStyle = '#e6ebf0'; ctx.lineWidth = 4.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tb.x, tb.y); ctx.lineTo(top[0], top[1]); ctx.stroke();
        ctx.strokeStyle = 'rgba(126,136,150,0.65)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(tb.x, tb.y); ctx.lineTo(top[0], top[1]); ctx.stroke();
        const ang = t * (0.4 + spin * 7) * tb.s + i * 1.1;
        ctx.save(); ctx.translate(top[0], top[1]);
        ctx.strokeStyle = S.on.wind ? '#f2f6fa' : 'rgba(150,155,165,0.6)';
        ctx.lineWidth = 3.4; ctx.lineCap = 'round';
        for (let b = 0; b < 3; b++) {
          const a2 = ang + b * TAU / 3;
          ctx.beginPath(); ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a2)*36*tb.s, Math.sin(a2)*36*tb.s*0.92); ctx.stroke();
        }
        ctx.fillStyle = '#c9d2dc'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
        ctx.restore();
      });
    },

    solar(ctx, n, S, t, sun) {
      const out = clamp01(S.d.solarMW / 11);
      const sheen = out * (S.on.solar ? 1 : 0);
      W.panels.forEach((p, i) => {
        if (sun.up && (i % 2 === 0)) {
          ctx.fillStyle = 'rgba(24,28,38,' + (sun.a*0.7) + ')';
          ctx.beginPath();
          ctx.moveTo(p.x-11+sun.dx*8, p.y+6+sun.dy*8); ctx.lineTo(p.x+11+sun.dx*8, p.y+6+sun.dy*8);
          ctx.lineTo(p.x+11+sun.dx*14, p.y-6+sun.dy*14); ctx.lineTo(p.x-11+sun.dx*14, p.y-6+sun.dy*14);
          ctx.closePath(); ctx.fill();
        }
        const a = lift(p.x - 11, p.y + 6, 4), b = lift(p.x + 11, p.y + 6, 4);
        const c = lift(p.x + 11, p.y - 6, 15), d = lift(p.x - 11, p.y - 6, 15);
        ctx.beginPath();
        ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.lineTo(c[0],c[1]); ctx.lineTo(d[0],d[1]);
        ctx.closePath();
        const g = ctx.createLinearGradient(a[0], a[1], c[0], c[1]);
        g.addColorStop(0, css(mixRGB([26,34,56], [96,136,194], sheen*0.85)));
        g.addColorStop(1, css(mixRGB([16,22,38], [156,196,236], sheen)));
        ctx.fillStyle = g; ctx.fill();
        ctx.strokeStyle = 'rgba(200,215,235,0.26)'; ctx.lineWidth = 0.8; ctx.stroke();
        if (sheen > 0.35 && (i % 5 === 0))
          R.glows.push({ x:(a[0]+c[0])/2, y:(a[1]+c[1])/2, r:20, c:'150,200,255', a:0.16*sheen });
      });
      const shed = quadOf(4204, 2662, 40, 30, 0);
      castShadow(ctx, shed, 20, sun);
      solid(ctx, shed, 18, { pal: PALETTES.shed, roofType:'shed', roofH: 5, tone:.5 });
    },

    coal(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { wall:[126,126,130], roof:[78,82,90], roofType:'flat', tone:.5,
                           windows:true, storeys:4, lit: S.d.coalMW > 0.3 ? 0.5 : 0.05, roofClutter:true });
      [[-48,-18,104],[46,-10,96]].forEach(([dx, dy, hh]) => {
        const bx = n.x + dx, by = n.y + dy;
        const sq = quadOf(bx, by, 26, 22, 0);
        castShadow(ctx, sq, hh, sun, true);
        for (const f of faceInfo(sq)) {
          const la = lift(f.a[0], f.a[1], hh), lb = lift(f.b[0], f.b[1], hh);
          poly(ctx, [f.a, f.b, lb, la], css([128*f.k, 128*f.k, 132*f.k]));
        }
        poly(ctx, sq.map(p => lift(p[0],p[1],hh)), '#4a4a50');
        const band = lift(bx, by, hh * 0.86);
        ctx.fillStyle = '#b3574a'; ctx.fillRect(band[0]-12, band[1], 24, 6);
        const blink = (Math.sin(t*3) > 0.6) ? 1 : 0.15;
        const tp = lift(bx, by, hh + 4);
        ctx.fillStyle = 'rgba(255,70,70,' + blink + ')';
        ctx.beginPath(); ctx.arc(tp[0], tp[1], 3, 0, TAU); ctx.fill();
        if (blink > 0.5) R.glows.push({ x:tp[0], y:tp[1], r:16, c:'255,60,60', a:0.5 });
      });
      if (S.d.coalMW > 0.3)
        R.glows.push({ x:n.x, y:n.y, r:96, c:'255,150,60', a:0.09*clamp01(S.d.coalMW/20) });
    },

    substation(ctx, n, S, t, sun) {
      ctx.fillStyle = 'rgba(78,74,64,0.85)';
      ctx.fillRect(n.x - n.w/2 - 12, n.y - n.d/2 - 10, n.w + 24, n.d + 20);
      ctx.strokeStyle = 'rgba(160,160,160,0.4)'; ctx.lineWidth = 1.2;
      ctx.strokeRect(n.x - n.w/2 - 12, n.y - n.d/2 - 10, n.w + 24, n.d + 20);
      for (let i = 0; i < 4; i++) {
        const q = quadOf(n.x - 42 + i*28, n.y + 10, 20, 18, 0);
        castShadow(ctx, q, 22, sun, true);
        solidPlain(ctx, q, 22, [104,112,124]);
      }
      for (let i = 0; i < 2; i++) {
        const px = n.x - 26 + i*56, py = n.y - 26;
        const top = lift(px, py, 58);
        ctx.strokeStyle = '#9aa2ac'; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(px-8, py); ctx.lineTo(top[0], top[1]); ctx.lineTo(px+8, py); ctx.stroke();
        const arm = lift(px, py, 50);
        ctx.beginPath(); ctx.moveTo(arm[0]-16, arm[1]); ctx.lineTo(arm[0]+16, arm[1]); ctx.stroke();
      }
      if (S.on.grid && S.d.served > 0.02) {
        const a = lift(n.x - 26, n.y - 26, 50), b = lift(n.x + 30, n.y - 26, 50);
        ctx.strokeStyle = 'rgba(255,200,110,' + (0.35 + 0.3*Math.sin(t*4)) + ')';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]);
        ctx.quadraticCurveTo((a[0]+b[0])/2, a[1]+9, b[0], b[1]); ctx.stroke();
        R.glows.push({ x:n.x, y:n.y-18, r:58, c:'255,190,90', a:(0.06+0.22*R.darkness)*S.d.served });
      }
    },

    pump(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { pal: PALETTES.slate, roofType:'gable', roofH: 10, tone:.5,
                           windows:true, storeys:1, lit: R.darkness>.3?.5:0 });
      ctx.strokeStyle = '#6b727c'; ctx.lineWidth = 9; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(n.x - n.w/2, n.y + 12); ctx.lineTo(1812, 1148); ctx.stroke();
      if (S.d.pumpEff > 0.1) {
        ctx.strokeStyle = 'rgba(110,220,240,' + (0.25 + 0.25*Math.sin(R.time*5)) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(n.x - n.w/2, n.y + 12); ctx.lineTo(1812, 1148); ctx.stroke();
      }
    },

    treatment(ctx, n, S, t, sun) {
      ctx.fillStyle = 'rgba(98,96,88,0.7)';
      ctx.fillRect(n.x - n.w/2 - 8, n.y - n.d/2 - 8, n.w + 16, n.d + 16);
      const eff = S.d.treatEff;
      [[-58,-24,26],[6,-28,22],[-30,26,24],[46,20,20]].forEach((o, i) => {
        const cx = n.x + o[0], cy = n.y + o[1], r = o[2];
        ctx.fillStyle = '#70767e';
        ctx.beginPath(); ctx.ellipse(cx, cy, r, r*0.6, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = css(mixRGB([70,78,74], [58,140,162], clamp01(eff)));
        ctx.beginPath(); ctx.ellipse(cx, cy, r-3, (r-3)*0.6, 0, 0, TAU); ctx.fill();
        if (eff > 0.1) {
          ctx.strokeStyle = 'rgba(190,230,240,0.5)'; ctx.lineWidth = 1.4;
          const a = t*1.6 + i;
          ctx.beginPath(); ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a)*(r-4), cy + Math.sin(a)*(r-4)*0.6); ctx.stroke();
        }
      });
      const q = quadOf(n.x + 66, n.y - 34, 34, 26, 0);
      castShadow(ctx, q, 26, sun, true);
      solid(ctx, q, 24, { pal: PALETTES.shed, roofType:'gable', roofH: 7, tone:.5 });
    },

    tower(ctx, n, S, t, sun) {
      const legs = [[-18,-18],[18,-18],[18,18],[-18,18]];
      if (sun.up) {
        ctx.fillStyle = 'rgba(24,28,38,' + sun.a + ')';
        ctx.beginPath();
        ctx.ellipse(n.x + sun.dx*n.h*0.7, n.y + sun.dy*n.h*0.7, 36, 16, 0, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = '#8f96a0'; ctx.lineWidth = 3.6;
      legs.forEach(l => {
        const top = lift(n.x + l[0]*0.5, n.y + l[1]*0.5, 74);
        ctx.beginPath(); ctx.moveTo(n.x + l[0], n.y + l[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
      });
      ctx.lineWidth = 1.5;
      for (let k = 1; k <= 3; k++) {
        const hh = 74 * k / 4, sc = 1 - 0.5 * (k/4);
        const ring = legs.map(l => lift(n.x + l[0]*sc, n.y + l[1]*sc, hh));
        ctx.beginPath();
        ring.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.closePath(); ctx.stroke();
      }
      const tq = quadOf(n.x, n.y, 52, 52, 0);
      for (const f of faceInfo(tq)) {
        const la = lift(f.a[0], f.a[1], 104), lb = lift(f.b[0], f.b[1], 104);
        const ba = lift(f.a[0], f.a[1], 74), bb = lift(f.b[0], f.b[1], 74);
        poly(ctx, [ba, bb, lb, la], css([164*f.k, 172*f.k, 180*f.k]));
      }
      poly(ctx, tq.map(p => lift(p[0], p[1], 104)), '#c3cad2');
      const lvl = clamp01(S.tank === undefined ? 1 : S.tank);
      const by = 74 + 30 * lvl;
      ctx.strokeStyle = S.on.tower ? 'rgba(72,190,220,0.9)' : 'rgba(140,140,140,0.6)';
      ctx.lineWidth = 2.6;
      const l1 = lift(n.x - 26, n.y + 26, by), l2 = lift(n.x + 26, n.y + 26, by);
      ctx.beginPath(); ctx.moveTo(l1[0], l1[1]); ctx.lineTo(l2[0], l2[1]); ctx.stroke();
      if (S.on.tower) R.glows.push({ x:n.x, y:n.y-60, r:44, c:'80,200,230', a:0.05 + 0.10*R.darkness });
    },

    gate(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun, true);
      solid(ctx, q, n.h, { pal: PALETTES.slate, roofType:'flat', tone:.5 });
      const p = lift(n.x, n.y + n.d/2, n.h * 0.5);
      ctx.fillStyle = S.on.canal ? '#2f7f9c' : '#4a4a48';
      ctx.fillRect(p[0]-19, p[1], 38, 12);
      ctx.strokeStyle = '#c9ced4'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(p[0]-21, p[1]-3); ctx.lineTo(p[0]+21, p[1]-3); ctx.stroke();
    },

    bridge(ctx, n, S, t, sun) {
      ctx.fillStyle = 'rgba(24,28,38,' + (sun.up ? sun.a*0.7 : 0.1) + ')';
      ctx.beginPath(); ctx.ellipse(n.x, n.y + 20, n.w*0.5, 13, 0, 0, TAU); ctx.fill();
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      solid(ctx, q, n.h, { pal: PALETTES.stone, roofType:'flat', tone:.5 });
      ctx.strokeStyle = '#8d8778'; ctx.lineWidth = 4.5;
      for (let i = -1; i <= 1; i++) {
        const cx = n.x + i * 56;
        const a = lift(cx - 22, n.y + n.d/2, 0), b = lift(cx + 22, n.y + n.d/2, 0);
        const m = lift(cx, n.y + n.d/2, n.h * 0.8);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(m[0], m[1], b[0], b[1]); ctx.stroke();
      }
      ctx.strokeStyle = '#b9b2a0'; ctx.lineWidth = 3.4;
      [-1, 1].forEach(s => {
        const a = lift(n.x - n.w/2, n.y + s*n.d/2, n.h + 7), b = lift(n.x + n.w/2, n.y + s*n.d/2, n.h + 7);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
      if (!S.on.bridge) {
        ctx.strokeStyle = 'rgba(255,95,109,0.9)'; ctx.lineWidth = 4.5;
        const c = lift(n.x, n.y, n.h + 12);
        ctx.beginPath(); ctx.moveTo(c[0]-26, c[1]-6); ctx.lineTo(c[0]+26, c[1]-6); ctx.stroke();
      }
    },

    marsh() {},
    farm() {},
    housing() {},

    forest(ctx, n, S, t, sun) {
      const q = quadOf(940, 1160, 44, 34, 0.1);
      castShadow(ctx, q, 30, sun, true);
      solid(ctx, q, 26, { wall:[122, 94, 68], roof:[78, 62, 48], roofType:'gable', roofH: 11, tone:.5 });
      ctx.fillStyle = '#8a6a48';
      for (let i = 0; i < 6; i++) ctx.fillRect(980 + (i%3)*10, 1180 + ((i/3)|0)*8, 9, 7);
    },

    park(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, 44, 38, 0);
      castShadow(ctx, q, 22, sun, true);
      solid(ctx, q, 16, { pal: PALETTES.civic, roofType:'hip', roofH: 12, tone:.5 });
      ctx.strokeStyle = 'rgba(196,186,160,0.5)'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.ellipse(n.x, n.y, 96, 74, 0, 0, TAU); ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(n.x - 130, n.y - 40); ctx.lineTo(n.x + 130, n.y + 44); ctx.stroke();
    },

    apiary(ctx, n, S, t, sun) {
      for (let i = 0; i < 8; i++)
        solidPlain(ctx, quadOf(n.x - 30 + (i % 4) * 20, n.y - 12 + ((i/4)|0) * 22, 13, 11, 0), 14, [216, 198, 138]);
      if (S.d.beeIdx > 0.3) {
        ctx.fillStyle = 'rgba(255,214,90,0.9)';
        for (let i = 0; i < 12; i++) {
          const a = t*2.4 + i*1.4;
          const p = lift(n.x + Math.cos(a)*(20+i*2.6), n.y + Math.sin(a*1.3)*(14+i), 18 + Math.sin(a*2)*7);
          ctx.fillRect(p[0], p[1], 2, 2);
        }
      }
    },

    orchard(ctx, n, S, t, sun) {
      const q = quadOf(1900, 2952, 46, 34, 0.05);
      castShadow(ctx, q, 30, sun, true);
      solid(ctx, q, 26, { wall:[150, 88, 68], roof:[76, 62, 56], roofType:'gable', roofH: 12, tone:.5 });
      ctx.fillStyle = '#7a5334';
      for (let i = 0; i < 5; i++) {
        ctx.beginPath(); ctx.ellipse(1938 + i*11, 2966 + (i%2)*8, 5, 4, 0, 0, TAU); ctx.fill();
      }
    },

    factory(ctx, n, S, t, sun) {
      ctx.fillStyle = 'rgba(84,80,72,0.75)';
      ctx.fillRect(n.x - n.w/2 - 24, n.y - n.d/2 - 18, n.w + 48, n.d + 44);
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      const util = S.d.factUtil;
      solid(ctx, q, n.h, { wall:[144,140,132], roof:[92,92,92], roofType:'flat', tone:.5,
                           windows:true, storeys:3, lit: util > 0.15 ? 0.55 : 0.05 });
      for (let i = 0; i < 6; i++) {
        const rx = n.x - 122 + i * 48;
        const a = lift(rx, n.y - n.d/2, n.h), b = lift(rx + 22, n.y - n.d/2, n.h + 20);
        const c = lift(rx + 22, n.y + n.d/2, n.h + 20), d = lift(rx, n.y + n.d/2, n.h);
        poly(ctx, [a, b, c, d], util > 0.15 ? 'rgba(168,208,238,0.6)' : 'rgba(94,104,120,0.55)');
      }
      [[-92,-72,84],[54,-80,76]].forEach(([dx, dy, hh]) => {
        const sq = quadOf(n.x + dx, n.y + dy, 20, 18, 0);
        castShadow(ctx, sq, hh, sun, true);
        solidPlain(ctx, sq, hh, [130,126,118]);
      });
    },

    market(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      const active = S.on.market && (!S.d.isNight || S.on.lights);
      solid(ctx, q, n.h, { wall:[198,180,152], roof:[96,92,98], roofType:'gable', roofH: 11, tone:.5,
                           windows:true, storeys:2, lit: active && R.darkness>.3 ? 0.7 : 0.1, door:true });
      const cols = ['#c1503f','#3f7cc1','#5aa860','#cfa03a','#8a5fb0','#c96a9c'];
      for (let i = 0; i < 6; i++) {
        const sx = n.x - 80 + i * 34, sy = n.y + n.d/2 + 22;
        ctx.fillStyle = 'rgba(20,20,20,0.18)'; ctx.fillRect(sx-13, sy+5, 28, 6);
        const a = lift(sx - 14, sy, 15), b = lift(sx + 14, sy, 15);
        ctx.fillStyle = cols[i];
        ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
        ctx.lineTo(sx+14, sy); ctx.lineTo(sx-14, sy); ctx.closePath(); ctx.fill();
        if (active) R.glows.push({ x:sx, y:sy, r:22, c:'255,210,140', a:0.16*R.darkness });
      }
    },

    recycle(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { wall:[128,142,124], roof:[78,90,78], roofType:'shed', roofH: 12, tone:.5,
                           windows:true, storeys:2, lit: R.darkness>.3?.4:0 });
      ['#4f9dd9','#63b96b','#e0b040','#c1503f'].forEach((c, i) => {
        solidPlain(ctx, quadOf(n.x - 56 + i*30, n.y + n.d/2 + 22, 22, 16, 0), 14, hex2rgb(c));
      });
    },

    station(ctx, n, S, t, sun) {
      ctx.fillStyle = 'rgba(150,144,132,0.9)';
      ctx.fillRect(n.x - 100, n.y - 8, 200, 26);
      const q = quadOf(n.x, n.y - 34, n.w, n.d * 0.7, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { pal: PALETTES.brick2, roofType:'gable', roofH: 15, tone:.5,
                           windows:true, storeys:2, lit: R.darkness>.3?.6:0, door:true, chimney:true, rot:0 });
      ctx.strokeStyle = 'rgba(120,126,136,0.9)'; ctx.lineWidth = 2.2;
      for (let i = -2; i <= 2; i++) {
        const a = lift(n.x + i*40, n.y + 12, 0), b = lift(n.x + i*40, n.y + 12, 26);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      const ca = lift(n.x - 96, n.y + 12, 26), cb = lift(n.x + 96, n.y + 12, 26);
      const cc = lift(n.x + 96, n.y - 14, 30), cd = lift(n.x - 96, n.y - 14, 30);
      poly(ctx, [ca, cb, cc, cd], 'rgba(112,118,128,0.92)');
      if (S.on.station) R.glows.push({ x:n.x, y:n.y, r:56, c:'255,210,150', a:0.22*R.darkness });
    },

    hospital(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      const eff = S.d.hospEff;
      solid(ctx, q, n.h, { pal: PALETTES.civic, roofType:'flat', tone:.5, roofClutter:true,
                           windows:true, storeys:4, lit: eff > 0.1 ? 0.75 : 0, door:true });
      const c = lift(n.x, n.y, n.h);
      ctx.fillStyle = eff > 0.1 ? '#e2564f' : '#7a4a48';
      ctx.fillRect(c[0]-4, c[1]-14, 9, 28); ctx.fillRect(c[0]-14, c[1]-4, 28, 9);
      if (eff > 0.1) R.glows.push({ x:c[0], y:c[1], r:38, c:'255,120,110', a:0.06+0.20*R.darkness });
    },

    school(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { wall:[208,170,118], roof:[104,98,102], roofType:'hip', roofH: 10, tone:.5,
                           windows:true, storeys:2, lit: (S.on.school && !S.d.isNight) ? 0.5 : 0, door:true });
      ctx.strokeStyle = 'rgba(200,192,168,0.4)'; ctx.lineWidth = 2.4;
      ctx.strokeRect(n.x - 96, n.y + n.d/2 + 12, 130, 62);
      ctx.beginPath(); ctx.moveTo(n.x - 31, n.y + n.d/2 + 12); ctx.lineTo(n.x - 31, n.y + n.d/2 + 74); ctx.stroke();
    },

    fire(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { wall:[178, 66, 58], roof:[104, 98, 100], roofType:'gable', roofH: 13, tone:.5 });
      const f = faceInfo(q)[0];
      if (f) {
        const P = (u, v) => lift(f.a[0] + (f.b[0]-f.a[0])*u, f.a[1] + (f.b[1]-f.a[1])*u, n.h * v);
        for (let i = 0; i < 2; i++) {
          const u0 = 0.14 + i*0.44, u1 = u0 + 0.30;
          poly(ctx, [P(u0,0.02), P(u1,0.02), P(u1,0.62), P(u0,0.62)], 'rgba(232,226,216,0.95)');
        }
      }
      if (S.fire > 0 && S.on.fire)
        R.glows.push({ x:n.x, y:n.y, r:50, c:'255,90,80', a:0.4 + 0.2*Math.sin(R.time*8) });
    },

    tram(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, n.w, n.d, 0);
      castShadow(ctx, q, n.h, sun);
      solid(ctx, q, n.h, { pal: PALETTES.slate, roofType:'shed', roofH: 12, tone:.5,
                           windows:true, storeys:2, lit: R.darkness>.3?.5:0 });
      ctx.strokeStyle = 'rgba(180,188,198,0.6)'; ctx.lineWidth = 1.7;
      for (let i = 0; i < 4; i++) {
        const px = n.x - 56 + i*38;
        const a = lift(px, n.y + n.d/2 + 10, 0), b = lift(px, n.y + n.d/2 + 10, 34);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    },

    lights(ctx, n, S, t, sun) {
      solidPlain(ctx, quadOf(n.x, n.y, 22, 16, 0), 22, [121,128,138]);
      const top = lift(n.x + 18, n.y, 42);
      ctx.strokeStyle = '#8b929b'; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(n.x + 18, n.y); ctx.lineTo(top[0], top[1]); ctx.stroke();
      const lit = S.on.lights && S.d.isNight && S.d.served > 0.2;
      ctx.fillStyle = lit ? '#ffd68a' : '#5d636c';
      ctx.beginPath(); ctx.ellipse(top[0], top[1], 5, 3, 0, 0, TAU); ctx.fill();
      if (lit) R.glows.push({ x:top[0], y:top[1], r:44, c:'255,205,120', a:0.5 });
    },

    weather(ctx, n, S, t, sun) {
      const q = quadOf(n.x, n.y, 26, 20, 0);
      castShadow(ctx, q, 20, sun, true);
      solid(ctx, q, 18, { pal: PALETTES.civic, roofType:'shed', roofH: 5, tone:.5 });
      const top = lift(n.x, n.y - 6, n.h);
      ctx.strokeStyle = '#cdd3da'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(n.x, n.y - 6); ctx.lineTo(top[0], top[1]); ctx.stroke();
      const a = t * (0.6 + S.wind * 9);
      ctx.fillStyle = '#e6ebf0';
      for (let i = 0; i < 3; i++) {
        const aa = a + i*TAU/3;
        ctx.beginPath(); ctx.arc(top[0]+Math.cos(aa)*8, top[1]+Math.sin(aa)*4, 2.4, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = '#f0f4f8'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(top[0], top[1]+8);
      ctx.lineTo(top[0]+Math.cos(S.windDir)*12, top[1]+8+Math.sin(S.windDir)*7); ctx.stroke();
    }
  };

  function collectNodes(D, S, V, z, t) {
    const sun = R.sun;
    for (const n of W.nodes) {
      if (n.x + n.w < V.x0 || n.x - n.w > V.x1 || n.y + n.d + 200 < V.y0 || n.y - n.d - n.h > V.y1) continue;
      const p = PAINT[n.kind];
      if (!p) continue;
      const off = !S.on[n.id];
      D.push({ y: n.y, f: (ctx) => {
        ctx.save();
        if (off) ctx.globalAlpha = 0.5;
        p(ctx, n, S, t, sun);
        if (off && n.kind !== 'housing' && n.kind !== 'marsh' && n.kind !== 'farm') {
          const c = lift(n.x, n.y, n.h + 24);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,95,109,0.85)'; ctx.lineWidth = 2.6;
          ctx.beginPath(); ctx.arc(c[0], c[1], 10, 0, TAU); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c[0]-7, c[1]-7); ctx.lineTo(c[0]+7, c[1]+7); ctx.stroke();
        }
        ctx.restore();
      }});
    }
  }

  /* ═══════════════════════ agents ═══════════════════════ */

  function drawCar(ctx, x, y, ang, col) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(14,18,24,0.28)'; ctx.fillRect(-7, -2, 14, 5);
    ctx.fillStyle = col; ctx.fillRect(-6.5, -3.6, 13, 7);
    ctx.fillStyle = 'rgba(30,42,58,0.75)'; ctx.fillRect(-3.5, -2.6, 5.5, 5.2);
    ctx.restore();
  }

  function collectAgents(D, S, V, z, t) {
    const night = S.d.isNight;
    const mood = clamp01(S.happy / 100);
    for (const p of AGENTS.people) {
      if (!p.active) continue;
      const q = AGENTS.sampleRoad(p.road, p.s);
      const x = q.x - Math.sin(q.ang) * p.side, y = q.y + Math.cos(q.ang) * p.side;
      if (x < V.x0 || x > V.x1 || y < V.y0 || y > V.y1) continue;
      D.push({ y: y, f: (ctx) => {
        const bob = p.idle > 0 ? 0 : Math.abs(Math.sin(p.phase)) * 1.5;
        const hh = 8 + bob;
        const top = lift(x, y, hh);
        ctx.fillStyle = 'rgba(16,20,26,0.28)';
        ctx.beginPath(); ctx.ellipse(x, y + 1, 3, 1.4, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#2c3038'; ctx.lineWidth = 1.7; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(top[0], top[1] + 2.8); ctx.stroke();
        ctx.fillStyle = p.shirt;
        ctx.fillRect(top[0] - 1.8, top[1] - 0.6, 3.6, 4);
        ctx.fillStyle = css(mixRGB([196,150,120], [222,186,150], mood));
        ctx.beginPath(); ctx.arc(top[0], top[1] - 2.4, 1.7, 0, TAU); ctx.fill();
        if (p.bag) { ctx.fillStyle = '#6b5a44'; ctx.fillRect(top[0] + 1.8, top[1] + 0.4, 1.8, 2.2); }
      }});
    }

    for (const c of AGENTS.cars) {
      if (!c.active) continue;
      const q = AGENTS.sampleRoad(c.road, c.s);
      const x = q.x - Math.sin(q.ang) * c.side * c.dir, y = q.y + Math.cos(q.ang) * c.side * c.dir;
      if (x < V.x0 || x > V.x1 || y < V.y0 || y > V.y1) continue;
      D.push({ y: y, f: (ctx) => {
        drawCar(ctx, x, y, q.ang, c.col);
        if (night) {
          R.glows.push({ x: x + Math.cos(q.ang)*c.dir*8, y: y + Math.sin(q.ang)*c.dir*8,
                         r: 26, c: '255,240,190', a: 0.5 });
        }
      }});
    }

    if (S.on.tram) {
      const q = AGENTS.sampleRoad(AGENTS.tram.road, AGENTS.tram.s);
      D.push({ y: q.y, f: (ctx) => {
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.ang);
        ctx.fillStyle = 'rgba(14,18,24,0.3)'; ctx.fillRect(-18, -2.5, 36, 6);
        ctx.fillStyle = '#3f7f6f'; ctx.fillRect(-17, -5.5, 34, 11);
        ctx.fillStyle = 'rgba(200,235,240,' + (S.d.served > 0.3 ? 0.85 : 0.25) + ')';
        for (let i = 0; i < 5; i++) ctx.fillRect(-13 + i*6, -3.6, 4, 3.8);
        ctx.restore();
        if (S.d.served > 0.3) R.glows.push({ x:q.x, y:q.y, r:26, c:'190,235,240', a:0.3 });
      }});
    }

    if (AGENTS.train && S.on.station) {
      const tr = AGENTS.train;
      D.push({ y: tr.y, f: (ctx) => {
        ctx.save(); ctx.translate(tr.x, tr.y); ctx.rotate(tr.ang);
        for (let c = 0; c < 3; c++) {
          ctx.fillStyle = 'rgba(14,18,24,0.3)'; ctx.fillRect(-14 + c*30, -3, 28, 7);
          ctx.fillStyle = c === 0 ? '#5a6b8c' : '#7a8496';
          ctx.fillRect(-13 + c*30, -6, 26, 12);
          ctx.fillStyle = 'rgba(210,235,245,0.8)';
          for (let i = 0; i < 3; i++) ctx.fillRect(-10 + c*30 + i*8, -4, 5, 4);
        }
        ctx.restore();
        R.glows.push({ x:tr.x, y:tr.y, r:34, c:'220,235,255', a:0.3*R.darkness });
      }});
    }

    for (const b of AGENTS.birds) {
      if (b.vis < 0.15) continue;
      if (b.x < V.x0 || b.x > V.x1 || b.y < V.y0 || b.y > V.y1) continue;
      D.push({ y: b.y + 1800, f: (ctx) => {
        const p = lift(b.x, b.y, b.z);
        ctx.strokeStyle = 'rgba(30,34,44,' + (0.35 * b.vis) + ')'; ctx.lineWidth = 1.2;
        const f = Math.sin(b.ph * 3) * 2.4;
        ctx.beginPath();
        ctx.moveTo(p[0]-3.5, p[1]+f); ctx.lineTo(p[0], p[1]-1); ctx.lineTo(p[0]+3.5, p[1]+f);
        ctx.stroke();
      }});
    }
  }

  function collectLamps(D, S, V, z) {
    if (!S.on.lights || !S.d.isNight) return;
    const p = clamp01(S.d.served * 1.3);
    if (p < 0.12) return;
    const detail = z > 0.72;
    ['ring','high','artery','indus','stationrd'].forEach(id => {
      const r = AGENTS.roadById[id];
      if (!r) return;
      for (let sPos = 0; sPos < r.total; sPos += 96) {
        const q = AGENTS.sampleRoad(r, sPos);
        const x = q.x - Math.sin(q.ang) * 12, y = q.y + Math.cos(q.ang) * 12;
        if (x < V.x0 || x > V.x1 || y < V.y0 || y > V.y1) continue;
        D.push({ y: y, f: (ctx) => {
          const top = lift(x, y, 26);
          if (detail) {
            ctx.strokeStyle = 'rgba(122,130,142,0.8)'; ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(top[0], top[1]); ctx.stroke();
          }
          ctx.fillStyle = 'rgba(255,218,148,0.95)';
          ctx.beginPath(); ctx.arc(top[0], top[1], 2.1, 0, TAU); ctx.fill();
          R.glows.push({ x: top[0], y: top[1], r: 38, c: '255,205,130', a: 0.34 * p });
        }});
      }
    });
  }

  function collectParticles(D, S, V, z) {
    for (const p of AGENTS.smoke) {
      if (p.x < V.x0 - 300 || p.x > V.x1 + 300) continue;
      D.push({ y: p.y + 2600, f: (ctx) => {
        const q = lift(p.x, p.y, p.z);
        const col = p.tint === 'fire' ? '92,68,54' : p.tint === 'coal' ? '112,110,110' : '146,142,132';
        ctx.fillStyle = 'rgba(' + col + ',' + (p.life * p.life * 0.20) + ')';
        ctx.beginPath(); ctx.arc(q[0], q[1], p.r, 0, TAU); ctx.fill();
      }});
    }
    for (const p of AGENTS.spray) {
      D.push({ y: p.y + 1200, f: (ctx) => {
        const q = lift(p.x, p.y, p.z);
        ctx.fillStyle = 'rgba(216,240,248,' + (p.life * 0.5) + ')';
        ctx.beginPath(); ctx.arc(q[0], q[1], p.r, 0, TAU); ctx.fill();
      }});
    }
    for (const e of AGENTS.embers) {
      D.push({ y: e.y + 2800, f: (ctx) => {
        const q = lift(e.x, e.y, e.z);
        ctx.fillStyle = 'rgba(255,' + ((120 + e.life*100)|0) + ',60,' + e.life + ')';
        ctx.fillRect(q[0], q[1], 2, 2);
        R.glows.push({ x:q[0], y:q[1], r:11, c:'255,140,50', a:0.4*e.life });
      }});
    }
    for (const l of AGENTS.leaves) {
      D.push({ y: l.y + 900, f: (ctx) => {
        const q = lift(l.x, l.y, l.z);
        ctx.fillStyle = l.tint; ctx.globalAlpha = l.life * 0.8;
        ctx.beginPath(); ctx.ellipse(q[0], q[1], 2.4, 1.2, l.ph, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }});
    }
  }

  /* ═══════════════════════ overlays ═══════════════════════ */

  function drawHaze(ctx, S, R2) {
    const a = clamp01((S.aqi - 45) / 250) * 0.60 + S.fire * 0.12;
    if (a < 0.015) return;
    ctx.setTransform(R2.dpr, 0, 0, R2.dpr, 0, 0);
    const brown = mixRGB([186,176,152], [122,92,66], clamp01((S.aqi - 120) / 220));
    ctx.fillStyle = css(brown, a); ctx.fillRect(0, 0, R2.w, R2.h);
    const g = ctx.createLinearGradient(0, R2.h * 0.35, 0, R2.h);
    g.addColorStop(0, css(brown, 0)); g.addColorStop(1, css(brown, a * 0.55));
    ctx.fillStyle = g; ctx.fillRect(0, 0, R2.w, R2.h);
  }

  function drawRain(ctx, S, R2) {
    const n = Math.round(S.rain * 460);
    const t = R2.time;
    const slant = (0.25 + S.wind * 1.5) * Math.cos(S.windDir);
    ctx.strokeStyle = 'rgba(180,205,230,' + (0.16 + S.rain * 0.3) + ')';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const seed = i * 91.7;
      const speed = 900 + (i % 7) * 130;
      const x = ((seed * 13.37) % R2.w + t * speed * slant * 0.25) % R2.w;
      const y = ((seed * 7.13 + t * speed) % (R2.h + 120)) - 60;
      const len = 9 + (i % 5) * 4;
      ctx.moveTo(x, y); ctx.lineTo(x + slant * len, y + len);
    }
    ctx.stroke();
    if (S.rain > 0.55) {
      ctx.fillStyle = 'rgba(170,195,225,' + ((S.rain - 0.55) * 0.14) + ')';
      ctx.fillRect(0, 0, R2.w, R2.h);
    }
  }

  const WIND_BUCKETS = 5;
  const windSegs = [];
  for (let i = 0; i < WIND_BUCKETS; i++) windSegs.push([]);

  function drawWindField(ctx, S, t, V) {
    const step = Math.max(130, 150 / Math.max(R.cam.z, 0.22));
    const mag = S.wind;
    const len = 30 + mag * 70;
    const aMax = 0.10 + mag * 0.34;
    for (let i = 0; i < WIND_BUCKETS; i++) windSegs[i].length = 0;
    for (let y = Math.floor(V.y0 / step) * step; y < V.y1; y += step) {
      for (let x = Math.floor(V.x0 / step) * step; x < V.x1; x += step) {
        const c = NZ.curl(x / 800 + t * 0.02, y / 800, 0);
        const ang = Math.atan2(c.y, c.x) * 0.4 + S.windDir;
        const ph = ((((t * (0.4 + mag) * 60 + x * 0.3 + y * 0.17) % 140) + 140) % 140) / 140;
        const sx = x + Math.cos(ang) * len * (ph - 0.5) * 2;
        const sy = y + Math.sin(ang) * len * (ph - 0.5) * 2;
        const bi = clamp((Math.sin(ph * Math.PI) * WIND_BUCKETS) | 0, 0, WIND_BUCKETS - 1);
        windSegs[bi].push(sx, sy, sx + Math.cos(ang)*len*0.42, sy + Math.sin(ang)*len*0.42);
      }
    }
    ctx.lineCap = 'round'; ctx.lineWidth = 1.6 + mag * 1.8;
    for (let b = 0; b < WIND_BUCKETS; b++) {
      const arr = windSegs[b];
      if (!arr.length) continue;
      ctx.strokeStyle = 'rgba(200,228,255,' + (((b + 0.5) / WIND_BUCKETS) * aMax).toFixed(3) + ')';
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i], arr[i+1]); ctx.lineTo(arr[i+2], arr[i+3]); }
      ctx.stroke();
    }
  }

  function drawHeat(ctx, S) {
    const island = clamp01(((1 - S.canopy) * 5.2 + (S.on.factory ? 1.5 : 0) + (S.on.coal ? 1.1 : 0)) / 7);
    const spots = [[2700, 1550, 900], [3900, 1200, 620], [1800, 400, 420]];
    ctx.globalCompositeOperation = 'lighter';
    spots.forEach((sp, i) => {
      const k = i === 2 ? (1 - S.reservoir) * 0.4 : island;
      if (k < 0.02) return;
      const g = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], sp[2]);
      g.addColorStop(0, 'rgba(255,90,60,' + (0.26 * k) + ')');
      g.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sp[0], sp[1], sp[2], 0, TAU); ctx.fill();
    });
    const g2 = ctx.createRadialGradient(820, 1400, 0, 820, 1400, 800);
    g2.addColorStop(0, 'rgba(60,150,255,' + (0.20 * S.canopy) + ')');
    g2.addColorStop(1, 'rgba(60,150,255,0)');
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(820, 1400, 800, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function edgeAnchor(n) { return [n.x + n.h * LX * 0.5, n.y - n.h * LY * 0.55]; }

  function drawLinks(ctx, S, t, R2) {
    const focus = R2.selected || R2.hover;
    W.edges.forEach((e, i) => {
      const A = W.byId[e.f], B = W.byId[e.t];
      const a = edgeAnchor(A), b = edgeAnchor(B);
      const live = S.on[e.f] && S.on[e.t];
      const rel = !focus || focus.id === e.f || focus.id === e.t;
      const col = EDGE_COLOR[e.k] || '#8fb4ff';
      const mx = (a[0]+b[0])/2, my = (a[1]+b[1])/2 - Math.hypot(b[0]-a[0], b[1]-a[1]) * 0.16;
      ctx.strokeStyle = css(hex2rgb(col), (rel ? (live ? 0.42 : 0.16) : 0.05));
      ctx.lineWidth = rel ? (e.s < 0 ? 1.6 : 2.4) : 1.1;
      if (e.s < 0) ctx.setLineDash([6, 7]); else ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(mx, my, b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      if (live && rel) {
        const k = ((t * 0.35 + i * 0.13) % 1), u = 1 - k;
        ctx.fillStyle = css(hex2rgb(col), 0.9);
        ctx.beginPath();
        ctx.arc(u*u*a[0] + 2*u*k*mx + k*k*b[0], u*u*a[1] + 2*u*k*my + k*k*b[1],
                focus ? 4 : 2.8, 0, TAU);
        ctx.fill();
      }
    });
  }

  function drawRipple(ctx, S) {
    const rp = SIM.ripple;
    const o = edgeAnchor(W.byId[rp.origin]);
    const col = rp.off ? [255, 95, 109] : [84, 217, 140];
    for (let k = 0; k < 3; k++) {
      const tt = rp.t - k * 0.35;
      if (tt < 0) continue;
      const a = clamp01(1 - tt / 2.6) * 0.5;
      if (a <= 0) continue;
      ctx.strokeStyle = css(col, a); ctx.lineWidth = 4.5 - k;
      ctx.beginPath(); ctx.arc(o[0], o[1], tt * 900, 0, TAU); ctx.stroke();
    }
    Object.keys(rp.depth).forEach(id => {
      const tt = rp.t - rp.depth[id] * 0.42;
      if (tt < 0 || tt > 1.5) return;
      const n = W.byId[id], p = edgeAnchor(n);
      const a = Math.sin(clamp01(tt / 1.5) * Math.PI) * 0.85;
      ctx.strokeStyle = css(col, a); ctx.lineWidth = 3;
      const r = 26 + Math.max(n.w, n.d) * 0.34 + tt * 18;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, TAU); ctx.stroke();
      R.glows.push({ x:p[0], y:p[1], r:r*1.6, c:col.join(','), a:a*0.25 });
    });
    W.edges.forEach(e => {
      const df = rp.depth[e.f], dt2 = rp.depth[e.t];
      if (df === undefined || dt2 === undefined || dt2 !== df + 1) return;
      const tt = rp.t - df * 0.42;
      if (tt < 0 || tt > 1.2) return;
      const A = edgeAnchor(W.byId[e.f]), B = edgeAnchor(W.byId[e.t]);
      const k = clamp01(tt / 0.7);
      ctx.strokeStyle = css(col, (1 - k) * 0.8); ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]);
      ctx.lineTo(mix(A[0], B[0], k), mix(A[1], B[1], k)); ctx.stroke();
    });
  }

  function drawSelection(ctx, R2) {
    const draw = (n, col, w) => {
      const x0 = n.x - n.w/2 - 10, x1 = n.x + n.w/2 + 10;
      const y0 = n.y - n.d/2 - 10, y1 = n.y + n.d/2 + 10;
      const c = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash([]);
      const L = Math.min(34, Math.min(n.w, n.d) * 0.5 + 12);
      ctx.beginPath();
      c.forEach((p, i) => {
        const nx = c[(i+1)%4], pv = c[(i+3)%4];
        ctx.moveTo(p[0] + Math.sign(nx[0]-p[0])*L, p[1] + Math.sign(nx[1]-p[1])*L);
        ctx.lineTo(p[0], p[1]);
        ctx.lineTo(p[0] + Math.sign(pv[0]-p[0])*L, p[1] + Math.sign(pv[1]-p[1])*L);
      });
      ctx.stroke();
      const t2 = lift(n.x, n.y - n.d/2, n.h + 16);
      ctx.beginPath(); ctx.arc(t2[0], t2[1], 3.6, 0, TAU); ctx.fillStyle = col; ctx.fill();
    };
    if (R2.hover && (!R2.selected || R2.selected.id !== R2.hover.id))
      draw(R2.hover, 'rgba(255,255,255,0.55)', 2);
    if (R2.selected) {
      const col = CAT_COLOR[R2.selected.cat];
      draw(R2.selected, col, 2.6);
      R.glows.push({ x:R2.selected.x, y:R2.selected.y, r:150, c:hex2rgb(col).join(','), a:0.10 });
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawLabels(ctx, S, R2, z) {
    ctx.textAlign = 'center';
    if (z < 0.34) {
      const a = clamp01((0.34 - z) / 0.12);
      W.districts.forEach(d => {
        ctx.font = '700 ' + (26 / z) + 'px Inter, sans-serif';
        ctx.fillStyle = 'rgba(240,246,255,' + (a * 0.7) + ')';
        ctx.fillText(d.name, d.x, d.y);
        ctx.font = '500 ' + (15 / z) + 'px Inter, sans-serif';
        ctx.fillStyle = 'rgba(180,196,220,' + (a * 0.58) + ')';
        ctx.fillText(d.sub, d.x, d.y + 24 / z);
      });
    }
    if (z > 0.32) {
      const a = clamp01((z - 0.32) / 0.14);
      const V = R2.viewBounds();
      W.nodes.forEach(n => {
        if (n.x < V.x0 || n.x > V.x1 || n.y < V.y0 || n.y > V.y1) return;
        const isFocus = (R2.hover && R2.hover.id === n.id) || (R2.selected && R2.selected.id === n.id);
        const p = lift(n.x, n.y - n.d/2, n.h + 30);
        const status = SIM.nodeStatus(n.id);
        const col = status === 'off' ? '#ff5f6d' : status === 'strain' ? '#ffc857' : CAT_COLOR[n.cat];
        ctx.font = '600 ' + (11 / z) + 'px Inter, sans-serif';
        const txt = n.short;
        const wTxt = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(6,10,18,' + (a * (isFocus ? 0.88 : 0.55)) + ')';
        roundRect(ctx, p[0] - wTxt/2 - 5/z, p[1] - 10/z, wTxt + 10/z, 14/z, 4/z);
        ctx.fill();
        ctx.fillStyle = css(hex2rgb(col), a * (isFocus ? 1 : 0.8));
        ctx.fillText(txt, p[0], p[1] + 1/z);
        ctx.beginPath(); ctx.arc(p[0] - wTxt/2 - 9/z, p[1] - 3/z, 2.4/z, 0, TAU);
        ctx.fillStyle = css(hex2rgb(col), a); ctx.fill();
      });
    }
    ctx.textAlign = 'left';
  }

  R.CAT_COLOR = CAT_COLOR;
  R.EDGE_COLOR = EDGE_COLOR;
  R.lift = lift;
  R.quadOf = quadOf;
  global.RENDER = R;
})(window);
