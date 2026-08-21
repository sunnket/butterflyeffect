/* ═══════════════════════════════════════════════════════════
   agents.js — everything that moves: townsfolk, traffic, the
   tram, the branch-line train, smoke plumes, spillway spray,
   embers, birds and leaves. All of it is steered by simulation
   state, so the valley looks like whatever the numbers say.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { clamp, clamp01, makeRNG, TAU } = NZ;
  const W = WORLD;

  const rng = makeRNG(24601);

  /* ── arc-length parameterisation ── */
  function param(obj, pts) {
    obj.smooth = pts;
    obj.cum = [0];
    for (let i = 1; i < pts.length; i++)
      obj.cum.push(obj.cum[i-1] + Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]));
    obj.total = obj.cum[obj.cum.length - 1];
    return obj;
  }
  W.roads.forEach(r => param(r, r.smooth));
  const RAIL = param({ id: 'rail' }, W.smoothRail);

  function sampleRoad(r, s) {
    s = ((s % r.total) + r.total) % r.total;
    let lo = 0, hi = r.cum.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (r.cum[m] <= s) lo = m; else hi = m; }
    const seg = r.cum[hi] - r.cum[lo] || 1;
    const t = (s - r.cum[lo]) / seg;
    const a = r.smooth[lo], b = r.smooth[hi];
    return { x: a[0] + (b[0]-a[0]) * t, y: a[1] + (b[1]-a[1]) * t,
             ang: Math.atan2(b[1]-a[1], b[0]-a[0]) };
  }

  const WALKABLE = ['ring', 'high', 'artery', 'bridgerd', 'stationrd', 'damrd', 'orchlane'];
  const DRIVABLE = ['artery', 'ring', 'high', 'indus', 'damrd', 'southrd', 'ridge',
                    'bridgerd', 'farmlane', 'stationrd', 'westrd'];
  const roadById = {}; W.roads.forEach(r => roadById[r.id] = r);

  const SHIRTS = ['#e8734a', '#4aa3e8', '#6fd18b', '#e8c34a', '#c76fe0', '#e04a72',
                  '#48d6cf', '#d9dde6', '#8a7fe0', '#e09a4a'];

  const A = {
    people: [], cars: [], tram: null, train: null,
    smoke: [], spray: [], embers: [], birds: [], leaves: [],

    init() {
      this.people = []; this.cars = []; this.smoke = []; this.spray = [];
      this.embers = []; this.birds = []; this.leaves = [];

      for (let i = 0; i < 340; i++) {
        const r = roadById[WALKABLE[(rng() * WALKABLE.length) | 0]];
        this.people.push({
          road: r, s: rng() * r.total, dir: rng() < .5 ? 1 : -1,
          side: (rng() < .5 ? -1 : 1) * (r.w / 2 + 5 + rng() * 6),
          base: 11 + rng() * 8, phase: rng() * TAU,
          shirt: SHIRTS[(rng() * SHIRTS.length) | 0],
          bag: rng() < .22, idle: 0, active: true
        });
      }
      for (let i = 0; i < 76; i++) {
        const r = roadById[DRIVABLE[(rng() * DRIVABLE.length) | 0]];
        this.cars.push({
          road: r, s: rng() * r.total, dir: rng() < .5 ? 1 : -1,
          side: r.w * 0.26, base: 58 + rng() * 44,
          col: ['#d8dde6','#9aa6bb','#c4553f','#3f6fc4','#4d4f57','#c9a24b','#5a8a6a'][(rng()*7)|0]
        });
      }
      this.tram  = { road: roadById.ring, s: 0, dir: 1, speed: 46 };
      this.train = { s: 0, dir: 1, speed: 150, x: 0, y: 0, ang: 0, dwell: 0 };

      for (let i = 0; i < 40; i++) {
        this.birds.push({ x: 400 + rng() * 1400, y: 500 + rng() * 1600, ph: rng() * TAU,
                          z: 70 + rng() * 120, sp: 22 + rng() * 20, vis: 1 });
      }
    },

    /* dt is simulated hours; converted here to a pleasing motion rate */
    update(dt, S) {
      const D = S.d;
      const m = clamp(dt * 90, 0, 3.2);
      const night = D.isNight;

      /* ── townsfolk ── */
      const wantPeople = clamp(Math.round((S.pop / 11800) * 220 * (night ? 0.26 : 1)
                          * (0.45 + 0.55 * clamp01(S.happy / 80))
                          * (S.aqi > 190 ? 0.45 : 1) * (S.rain > 0.5 ? 0.55 : 1)), 6, this.people.length);
      const pace = 0.7 + 0.5 * clamp01(S.happy / 90) + (S.rain > 0.4 ? 0.5 : 0);
      for (let i = 0; i < this.people.length; i++) {
        const p = this.people[i];
        p.active = i < wantPeople;
        if (!p.active) continue;
        if (p.idle > 0) { p.idle -= m; continue; }
        if (rng() < 0.0012 * m) { p.idle = 8 + rng() * 30; continue; }
        p.s += p.dir * p.base * pace * m * 0.09;
        if (p.road.id !== 'ring') {
          if (p.s > p.road.total) { p.s = p.road.total; p.dir = -1; }
          if (p.s < 0) { p.s = 0; p.dir = 1; }
        }
        p.phase += m * 0.55;
      }

      /* ── traffic: fewer cars when the tram runs, more when it doesn't ── */
      const wantCars = clamp(Math.round(D.traffic * 70 * (night ? 0.35 : 1)), 3, this.cars.length);
      for (let i = 0; i < this.cars.length; i++) {
        const c = this.cars[i];
        c.active = i < wantCars;
        if (!c.active) continue;
        c.s += c.dir * c.base * m * 0.09;
        if (c.road.id !== 'ring') {
          if (c.s > c.road.total) { c.s = c.road.total; c.dir = -1; }
          if (c.s < 0) { c.s = 0; c.dir = 1; }
        }
      }

      if (S.on.tram) this.tram.s += this.tram.speed * m * 0.09 * clamp01(D.served * 1.2);

      /* ── the branch-line train, with a stop at the halt ── */
      const tr = this.train;
      if (S.on.station) {
        if (tr.dwell > 0) tr.dwell -= m;
        else {
          tr.s += tr.dir * tr.speed * m * 0.09;
          if (tr.s > RAIL.total - 40) { tr.s = RAIL.total - 40; tr.dir = -1; tr.dwell = 40; }
          if (tr.s < 40) { tr.s = 40; tr.dir = 1; tr.dwell = 40; }
          // pause at the platform
          const stationS = RAIL.total * 0.47;
          if (Math.abs(tr.s - stationS) < 26 && tr.lastStop !== tr.dir) {
            tr.dwell = 55; tr.lastStop = tr.dir;
          }
          if (Math.abs(tr.s - stationS) > 200) tr.lastStop = 0;
        }
        const q = sampleRoad(RAIL, tr.s);
        tr.x = q.x; tr.y = q.y; tr.ang = q.ang;
      }

      /* ── smoke from the stacks ── */
      const wind = S.wind, wd = S.windDir;
      const wx = Math.cos(wd) * (0.7 + wind * 4.4), wy = Math.sin(wd) * (0.7 + wind * 4.4);

      const emit = (x, y, z0, rate, size, tint) => {
        if (rng() < rate * m) {
          this.smoke.push({ x, y, z: z0, vx: (rng()-.5)*.5, vy: (rng()-.5)*.5,
                            r: size * (0.7 + rng() * .7), life: 1, tint });
        }
      };
      if (S.on.coal && D.coalMW > 0.4) {
        const rate = 0.20 + clamp01(D.coalMW / 20) * 0.7;
        emit(4228, 888, 110, rate, 14, 'coal');
        emit(4322, 896, 102, rate * 0.8, 13, 'coal');
      }
      if (S.on.factory && D.factUtil > 0.12) {
        const rate = 0.14 + D.factUtil * 0.6;
        emit(3782, 1134, 90, rate, 12, 'fact');
        emit(3928, 1126, 82, rate * 0.7, 11, 'fact');
      }
      if (S.fire > 0.02) {
        for (let k = 0; k < 3; k++) {
          const ang = rng() * TAU, rr = rng() * 380 * S.fire;
          emit(820 + Math.cos(ang) * rr, 1360 + Math.sin(ang) * rr, 16, 0.5 * S.fire, 26, 'fire');
        }
        if (rng() < S.fire * 0.7 * m) {
          const ang = rng() * TAU, rr = rng() * 340 * S.fire;
          this.embers.push({ x: 820 + Math.cos(ang)*rr, y: 1360 + Math.sin(ang)*rr,
                             z: 8 + rng()*26, life: 1, vx: (rng()-.5)*2, vy: (rng()-.5)*2 });
        }
      }
      for (let i = this.smoke.length - 1; i >= 0; i--) {
        const p = this.smoke[i];
        p.x += (p.vx + wx * 1.5) * m; p.y += (p.vy + wy * 1.5) * m;
        p.z += (p.tint === 'fire' ? 2.6 : 1.5) * m;
        p.r = Math.min(p.r + 0.30 * m, 52);
        p.life -= 0.013 * m * (1 + wind);
        if (p.life <= 0) this.smoke.splice(i, 1);
      }
      if (this.smoke.length > 320) this.smoke.splice(0, this.smoke.length - 320);

      for (let i = this.embers.length - 1; i >= 0; i--) {
        const e = this.embers[i];
        e.x += (e.vx + wx * 2.2) * m; e.y += (e.vy + wy * 2.2) * m;
        e.z += 1.2 * m; e.life -= 0.02 * m;
        if (e.life <= 0) this.embers.splice(i, 1);
      }

      /* ── spillway & tailrace spray ── */
      const spillA = (D.spill > 0.5 ? 1 : 0) + clamp01(D.release / 30) * 0.55 + (S.on.dam ? 0 : 0.8);
      if (spillA > 0.05 && rng() < spillA * 0.9 * m) {
        this.spray.push({ x: 1804 + (rng() - .5) * 240, y: 712, z: 22 + rng() * 14,
                          vx: (rng() - .5) * 1.2, vy: 1.6 + rng() * 1.4, life: 1, r: 4 + rng() * 6 });
      }
      for (let i = this.spray.length - 1; i >= 0; i--) {
        const p = this.spray[i];
        p.x += p.vx * m; p.y += p.vy * m; p.z -= 0.7 * m; p.r += 0.28 * m;
        p.life -= 0.022 * m;
        if (p.life <= 0) this.spray.splice(i, 1);
      }

      /* ── birds avoid bad air ── */
      const birdiness = clamp01(1 - (S.aqi - 60) / 160) * clamp01(1 - S.fire * 2);
      for (const b of this.birds) {
        b.ph += 0.06 * m;
        const c = NZ.curl(b.x / 1200, b.y / 1200, 0);
        b.x += (c.x * 34 + wx * 0.7 + Math.cos(b.ph) * 0.4) * m * 0.5;
        b.y += (c.y * 34 + wy * 0.7 + Math.sin(b.ph * 1.3) * 0.4) * m * 0.5;
        if (b.x < 80) b.x = W.w - 100; if (b.x > W.w - 80) b.x = 100;
        if (b.y < 80) b.y = W.h - 100; if (b.y > W.h - 80) b.y = 100;
        b.vis = birdiness;
      }

      /* ── leaves lifted off the canopy ── */
      if (wind > 0.3 && S.canopy > 0.15 && rng() < wind * 0.5 * m) {
        const t = W.trees[(rng() * W.trees.length) | 0];
        if (t && t.rank < S.canopy) {
          this.leaves.push({ x: t.x, y: t.y, z: t.h, life: 1, ph: rng() * TAU,
                             tint: S.canopy > .5 ? '#7fbf6a' : '#c9a24b' });
        }
      }
      for (let i = this.leaves.length - 1; i >= 0; i--) {
        const l = this.leaves[i];
        l.ph += 0.13 * m;
        l.x += (wx * 2.4 + Math.cos(l.ph) * 1.4) * m;
        l.y += (wy * 2.4 + Math.sin(l.ph * 0.7) * 0.8) * m;
        l.z -= 0.5 * m; l.life -= 0.008 * m;
        if (l.life <= 0 || l.z < 0) this.leaves.splice(i, 1);
      }

      if (SIM.ripple) {
        SIM.ripple.t += dt * 1.6;
        if (SIM.ripple.t > 3.4) SIM.ripple = null;
      }
    },

    sampleRoad, roadById, RAIL
  };

  global.AGENTS = A;
})(window);
