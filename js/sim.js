/* ═══════════════════════════════════════════════════════════
   sim.js — the coupled model of Verdant Hollow.

   One `step(S, dt)` advances every stock in the valley by dt
   simulated hours. The function is *pure enough* to be run on a
   cloned state, which is how the "what happens if I switch this
   off?" forecasts are produced: we fork the world, flip one bit,
   run both futures 36 hours forward and diff them.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { clamp, clamp01, smoothstep, mix, approach, fbm, makeRNG } = NZ;
  const W = WORLD;

  const RES_CAP   = 1200;   // reservoir capacity, ML
  const COAL_CAP  = 20;     // MW — deliberately not enough to cover a bad day alone
  const HYDRO_CAP = 18;     // MW
  const WIND_CAP  = 14;     // MW
  const SOLAR_CAP = 11;     // MW
  const POP0      = 11800;
  const TANK_CAP  = 90;     // ML held in the water tower

  const SEASONS = ['Spring', 'Monsoon', 'Autumn', 'Winter'];
  const SEASON_RAIN = [0.46, 1.00, 0.34, 0.20];
  const SEASON_TEMP = [21, 27, 17, 8];

  /* ───────────────────────── state ───────────────────────── */

  function freshState() {
    const on = {};
    W.nodes.forEach(n => { on[n.id] = true; });
    return {
      hours: 6, seed: 4471, proj: false,
      on,
      // scenario modifiers
      mod: { rain: 1, wind: 1, temp: 0, demand: 1, emit: 1, ignite: 0 },
      scen: null, scenLeft: 0,

      // ── weather (derived from clock, held for smoothing) ──
      rain: 0.12, cloud: 0.35, wind: 0.34, windDir: 0.9, temp: 21, sun: 0,

      // ── stocks ──
      reservoir: 0.66,   // fraction of RES_CAP
      soil: 0.56,
      canopy: 0.90,      // forest canopy fraction
      marshHp: 0.92,
      aqi: 46,
      waterQ: 80,
      yield: 0.68,
      feed: 0.6,         // recycled feedstock available to the works
      tank: 0.86,        // water tower fill, fraction of TANK_CAP
      skill: 0.70,
      health: 78, econ: 62, happy: 70, pop: POP0,
      reliab: 1,
      fire: 0, fireCool: 0,
      floodRisk: 0,
      d: {}              // derived readouts, rebuilt every step
    };
  }

  function cloneState(S) {
    const c = Object.assign({}, S);
    c.on = Object.assign({}, S.on);
    c.mod = Object.assign({}, S.mod);
    c.d = {};
    return c;
  }

  /* ───────────────────────── weather ─────────────────────────
     Purely a function of the clock + seed + scenario modifiers,
     so a forked timeline always gets identical weather. */

  /** Rainfall at an arbitrary clock time. Pure, so the weather station can
      legitimately look six hours into the future the way a real one does. */
  function rainAt(S, t) {
    const seasonPhase = ((t / 24) / 6) % 4;
    const si = Math.floor(seasonPhase) % 4;
    const sn = (si + 1) % 4;
    const blend = seasonPhase - Math.floor(seasonPhase);
    const rainBias = mix(SEASON_RAIN[si], SEASON_RAIN[sn], smoothstep(0.7, 1, blend));
    const front = fbm(t / 26 + S.seed * 0.001, 3.7, 3) * 0.5 + 0.5;
    const squall = fbm(t / 3.1, 11.3, 2) * 0.5 + 0.5;
    const transp = S.canopy * 0.10;                 // a wooded catchment makes its own weather
    let r = clamp01((front - 0.46) * 2.35) * rainBias + transp * clamp01(front - 0.3);
    r *= (0.55 + squall * 0.75);
    return clamp01(r * S.mod.rain);
  }

  function weather(S) {
    const t = S.hours;
    const seasonPhase = ((t / 24) / 6) % 4;         // 6 sim-days per season
    const si = Math.floor(seasonPhase) % 4;
    const sn = (si + 1) % 4;
    const blend = seasonPhase - Math.floor(seasonPhase);
    const tempBias = mix(SEASON_TEMP[si], SEASON_TEMP[sn], smoothstep(0.7, 1, blend));

    S.rain = rainAt(S, t);

    const gust = fbm(t / 1.7, 27.1, 2) * 0.5 + 0.5;
    S.wind = clamp01((0.20 + (fbm(t / 8, 5.5, 3) * 0.5 + 0.5) * 0.5 + gust * 0.16 + S.rain * 0.14) * S.mod.wind);
    S.windDir = 0.75 + fbm(t / 40, 17, 2) * 1.1;

    S.cloud = clamp01(0.16 + S.rain * 1.7 + (fbm(t / 11, 9.9, 3) * 0.5 + 0.5) * 0.45);

    const hod = t % 24;
    S.sun = clamp01(Math.sin(Math.PI * (hod - 6) / 12)) * (1 - S.cloud * 0.72);

    const diurnal = Math.sin(Math.PI * (hod - 7.5) / 12) * 5.2;
    const heatIsland = (1 - S.canopy) * 5.2 + (S.on.factory ? 1.5 : 0) + (S.on.coal ? 1.1 : 0)
                     + clamp01((S.aqi - 60) / 260) * 2.2 - S.wind * 2.6;
    S.temp = tempBias + diurnal - S.rain * 4.2 - S.cloud * 1.6 + heatIsland + S.mod.temp + S.fire * 3;

    S.d.season = SEASONS[si];
    S.d.seasonIdx = si;
    S.d.hod = hod;
    S.d.isNight = hod < 6.2 || hod > 19.2;
  }

  /* ───────────────────────── one tick ───────────────────────── */

  function step(S, dt) {
    S.hours += dt;
    if (S.scenLeft > 0) {
      S.scenLeft -= dt;
      if (S.scenLeft <= 0) SCEN.expire(S);
    }
    weather(S);

    const on = S.on;
    const D = S.d;
    const night = D.isNight;

    /* ═══ 1. HYDROLOGY ═══════════════════════════════════════ */
    const catchQuality = 0.55 + 0.45 * S.canopy;          // wooded slopes capture, bare slopes flash off
    const inflow = S.rain * 112 * catchQuality + 6 + 6 * S.canopy;    // ML/h
    const evap = 0.9 * clamp01(S.temp / 30) * (1 - S.cloud * 0.6) * (0.4 + S.reservoir);

    // How hard the grid is leaning on hydro right now (set last tick)
    const pressure = clamp01(D.deficitPrev || 0);
    const dryness = clamp01(1 - S.soil);
    const irrigWant = (on.canal && on.farms) ? clamp(3 + 13 * dryness, 0, 16) : 0;

    let release = 0, spill = 0, envFlow = 0, uncontrolled = 0;

    if (on.dam) {
      const avail = clamp01(S.reservoir / 0.10);
      // the gate must pass at least what the canal is asking for; the turbines
      // take whatever goes through, so irrigation and electricity share a river
      const turbWant = on.hydro ? (12 + 12 * pressure) : 0;
      release = Math.max(turbWant, irrigWant + 1.5) * avail;
      // With warning of an incoming front the operators draw the level down
      // *through the turbines* instead of losing it over the crest unused.
      const forecast = on.weather ? rainAt(S, S.hours + 6) : 0;
      if (on.weather && S.reservoir > 0.80 && forecast > 0.32) release += 7 * avail;
      D.forecastRain = forecast;
      envFlow = 3.5 * avail;
      if (S.reservoir > 0.985) spill = Math.max(0, inflow - release - envFlow) + 18;
    } else {
      // gates gone: the river runs as it likes, storage bleeds away
      uncontrolled = inflow + S.reservoir * RES_CAP * 0.055;
      envFlow = uncontrolled;
    }

    const totalDown = on.dam ? (release + spill + envFlow) : uncontrolled;

    // abstractions
    const canalDraw = Math.min(irrigWant, totalDown * 0.75);
    const cityWaterNeed = (6 + (S.pop / POP0) * 9 + (on.factory ? 5.5 : 0)) * S.mod.demand;

    S.reservoir = clamp01(S.reservoir + (inflow - release - spill - envFlow - uncontrolled - evap) * dt / RES_CAP);

    const marshFlow = Math.max(0, totalDown - canalDraw);
    const marshTarget = on.marsh
      ? clamp01(smoothstep(0, 14, marshFlow) * 0.55 + S.canopy * 0.3 + 0.15 - (on.factory ? 0.18 : 0))
      : 0;
    S.marshHp = approach(S.marshHp, marshTarget, on.marsh ? 0.09 : 0.5, dt);

    /* ═══ 2. ELECTRICITY ═════════════════════════════════════ */
    const head = 0.55 + 0.45 * S.reservoir;
    const hydroMW = (on.hydro && on.dam) ? Math.min(HYDRO_CAP, release * 0.92 * head) : 0;

    const v = S.wind;
    let wcurve = 0;
    if (v > 0.10 && v < 0.94) wcurve = clamp01(Math.pow((v - 0.10) / 0.48, 3));
    else if (v >= 0.94) wcurve = 0;                        // storm shutdown
    const windMW = on.wind ? WIND_CAP * wcurve : 0;

    const haze = clamp01((S.aqi - 40) / 400) * 0.55;
    const solarMW = on.solar ? SOLAR_CAP * S.sun * (1 - haze) : 0;

    // demand
    const popF = S.pop / POP0;
    const cooling = clamp01((S.temp - 24) / 11) * 1.25;
    const heating = clamp01((9 - S.temp) / 14) * 0.7;
    const homeUnit = id => (on[id] ? 1 : 0) * popF * (1 + cooling + heating) * (night ? 1.16 : 0.86);
    let demand = 0;
    demand += homeUnit('homeA') * 1.00;
    demand += homeUnit('homeB') * 1.30;
    demand += homeUnit('homeC') * 1.05;
    const factoryWant = on.factory ? 9 : 0;
    demand += factoryWant;
    demand += on.market ? 2.0 : 0;
    demand += on.hospital ? 3.0 : 0;
    demand += on.school ? (night ? 0.3 : 1.9) : 0;
    demand += on.pump ? 2.6 : 0;
    demand += on.treat ? 1.8 : 0;
    demand += on.tram ? (night ? 0.8 : 2.2) : 0;
    demand += on.lights ? (night ? 1.5 : 0.06) : 0;
    demand += on.recycle ? 1.3 : 0;
    demand += on.fire ? 0.4 : 0;
    demand *= S.mod.demand;
    demand = Math.max(0.4, demand);

    const renew = hydroMW + windMW + solarMW;
    const gap = demand - renew;
    // without a forecast the thermal plant chases the gap and carries more
    // spinning reserve than it needs — which the valley pays for in particulates
    const coalMW = on.coal ? clamp(gap * (on.weather ? 1.0 : 1.12), 0, COAL_CAP) : 0;
    const supply = renew + coalMW;
    const served = on.grid ? clamp01(supply / demand) : 0;
    const deficit = 1 - served;
    D.deficitPrev = deficit;
    S.reliab = approach(S.reliab, served, 0.5, dt);

    const hospEff = on.hospital ? clamp01(served * 1.4) : 0;   // priority feeder
    const pumpEff = on.pump ? served : 0;
    const treatEff = on.treat ? served * clamp01(pumpEff * 0.75 + 0.25) : 0;
    const factUtil = on.factory
      ? served * (0.52 + 0.26 * S.skill + 0.22 * S.feed) * (on.tram ? 1 : 0.86) * (on.homeA ? 1 : 0.72)
        * (on.bridge ? 1 : 0.78)          // half the workforce lives across the river
        * (on.station ? 1 : 0.88)         // and the finished goods leave by rail
      : 0;

    // What the works can actually push into the mains this hour.
    const mains = (pumpEff * 0.6 + 0.4) * cityWaterNeed * (on.treat ? 1 : 0.30) * (treatEff > 0.15 ? 1 : 0.45);
    let supplied = Math.min(cityWaterNeed, mains);
    let shortfall = Math.max(0, cityWaterNeed - supplied);
    let tankDraw = 0;
    if (on.tower) {
      // gravity feed: the tank covers the gap until it runs out
      tankDraw = Math.min(shortfall, S.tank * TANK_CAP * 0.55);
      supplied += tankDraw;
      const surplus = Math.max(0, mains - cityWaterNeed);
      S.tank = clamp01(S.tank + (Math.min(surplus, TANK_CAP * 0.20) * 0.85 - tankDraw) * dt / TANK_CAP);
    } else {
      S.tank = approach(S.tank, 0, 0.8, dt);
    }
    const waterCover = clamp01(supplied / Math.max(cityWaterNeed, 0.01));

    /* ═══ 3. AIR ═════════════════════════════════════════════ */
    const traffic = popF * (on.tram ? 0.6 : 1.0) * (night ? 0.35 : 1.0) * (on.market ? 1 : 0.85)
                  * (on.station ? 0.92 : 1.08);   // freight by rail, or by lorry
    const emissions = (coalMW * 1.30 + factUtil * 15 + traffic * 9 + S.fire * 135
                      + (on.recycle ? 0 : 8)) * S.mod.emit;
    // Uptake and dispersal are *rates*, proportional to how much is up there —
    // which is why a bare valley on a still day is so much worse than the sum
    // of its emissions would suggest.
    const sink     = S.canopy * 0.30 * (0.6 + S.soil * 0.4) + (on.park ? 0.07 : 0)
                   + (on.orchard ? 0.045 : 0) + S.marshHp * 0.03;
    const disperse = 0.04 + S.wind * 0.30;
    const washout  = S.rain * 0.55;
    const clearing = (sink + disperse + washout) * (S.aqi - 12);
    const absorb   = sink * (S.aqi - 12);
    S.aqi = clamp(S.aqi + (emissions * 0.85 - clearing) * dt * 0.55, 6, 500);

    /* ═══ 4. LAND, FIRE & FOREST ═════════════════════════════ */
    const irrig = clamp01(canalDraw / 16);
    const soilTarget = clamp01(S.rain * 2.0 + irrig * 0.42 + S.canopy * 0.16 + 0.08
                             - clamp01((S.temp - 25) / 18) * 0.35);
    S.soil = approach(S.soil, soilTarget, 0.10, dt);

    // ignition
    const fireRisk = clamp01((0.55 - S.soil) * 2.2) * clamp01((S.temp - 22) / 12) * clamp01(S.canopy * 1.4);
    if (!S.proj) {
      const r = makeRNG((S.hours * 1000) | 0)();
      if (S.fire <= 0.001 && S.fireCool <= 0 && r < (fireRisk * 0.035 + S.mod.ignite) * dt) {
        S.fire = 0.22;
        LOG(S, 'Fire has broken out in the pines — tinder-dry litter, ' + S.temp.toFixed(0) + '°C.', 'bad', 'nature');
      }
    }
    // With no fire cover, dry ground smoulders on its own — no dice roll needed.
    if (!on.fire && fireRisk > 0.18) S.fire = Math.max(S.fire, (fireRisk - 0.18) * 0.55);
    if (S.fire > 0) {
      const suppress = (on.fire ? 0.30 * clamp01(served * 1.2) * (on.bridge ? 1 : 0.55) : 0)
                     + (on.weather ? 0.07 : 0) + S.rain * 0.9 + 0.04;
      const spread = fireRisk * 0.42 + S.wind * 0.16;
      S.fire = clamp(S.fire + (spread - suppress) * dt * 0.6, 0, 1);
      if (S.fire < 0.012) { S.fire = 0; S.fireCool = 40; if (!S.proj) LOG(S, 'The fire is out. The burn scar will take seasons to close.', 'good', 'nature'); }
    } else if (S.fireCool > 0) S.fireCool -= dt;

    let canopyTarget;
    if (!on.forest) canopyTarget = 0.04;                    // clear-felled
    else canopyTarget = clamp01(0.35 + S.soil * 0.7 - clamp01((S.aqi - 130) / 320) * 0.4
                              - (on.coal ? 0.05 : 0) + 0.15);
    const growRate = on.forest ? (canopyTarget > S.canopy ? 0.012 : 0.05) : 0.30;
    S.canopy = clamp01(approach(S.canopy, canopyTarget, growRate, dt) - S.fire * 0.022 * dt);

    /* ═══ 5. WATER QUALITY ═══════════════════════════════════ */
    const wqTarget = clamp(26 + treatEff * 40 + S.marshHp * 18 + S.canopy * 9
                         - factUtil * 15 - (1 - S.soil) * 5 - S.fire * 12, 0, 100);
    S.waterQ = approach(S.waterQ, wqTarget, 0.14, dt);

    /* ═══ 6. AGRICULTURE ═════════════════════════════════════ */
    const beeIdx = on.bees
      ? clamp01(0.24 + S.canopy * 0.46 + (on.farms ? 0.16 : 0) + (on.orchard ? 0.14 : 0)
                - clamp01((S.aqi - 150) / 300) * 0.25)
      : 0.36;
    const airIdx = 1 - clamp01((S.aqi - 70) / 260) * 0.38;
    const laborIdx = on.homeC ? 1 : 0.62;
    const waterIdx = on.canal ? clamp01(canalDraw / 13) * 0.85 + 0.15 : 0.18;
    const yTarget = on.farms
      ? clamp01(S.soil * 0.34 + waterIdx * 0.30 + beeIdx * 0.24 + 0.12) * airIdx * laborIdx * (1 - S.fire * 0.4)
      : 0.02;
    S.yield = approach(S.yield, yTarget, 0.075, dt);

    S.feed = approach(S.feed, on.recycle ? clamp01(0.35 + served * 0.55) : 0.12, 0.09, dt);
    S.skill = clamp01(approach(S.skill, on.school ? clamp01(0.55 + served * 0.4) : 0.30, 0.010, dt));

    /* ═══ 7. PEOPLE ══════════════════════════════════════════ */
    const orchIdx = on.orchard
      ? clamp01(0.30 + beeIdx * 0.42 + (on.canal ? clamp01(canalDraw / 13) * 0.28 : 0.04)) * airIdx
      : 0;
    const foodIdx = clamp01(S.yield * 0.62 + orchIdx * 0.14 + (on.market ? 0.26 : 0.05));
    const heatStress = clamp01((S.temp - 33) / 12);
    const healthTarget = clamp(100 - S.aqi / 5.0 - (100 - S.waterQ) / 2.5 - (1 - foodIdx) * 24
                             - (1 - hospEff) * 17 - heatStress * 12 - S.fire * 14, 0, 100);
    S.health = approach(S.health, healthTarget, 0.10, dt);

    const tourism = clamp01(S.canopy * 0.55 + (1 - clamp01(S.aqi / 200)) * 0.5)
                  * (on.park ? 1 : 0.82) * (on.station ? 1 : 0.80);   // visitors arrive by train
    // a market with no streetlights loses its evening entirely, and a market
    // cut off from the west bank loses a third of its custom
    const marketIdx = on.market ? (night && !on.lights ? 0.5 : 1) * (on.bridge ? 1 : 0.78) : 0;
    const econTarget = clamp(100 * (0.28 * factUtil + 0.14 * marketIdx + 0.17 * S.yield
                        + 0.06 * orchIdx + 0.12 * tourism + 0.11 * (on.school ? S.skill : 0.2)
                        + 0.07 * (on.recycle ? 1 : 0.25) + 0.05 * (on.station ? 1 : 0.2))
                        * (0.5 + 0.5 * S.reliab), 0, 100);
    S.econ = approach(S.econ, econTarget, 0.09, dt);

    const green = clamp01(S.canopy * 0.6 + (on.park ? 0.3 : 0) + S.marshHp * 0.1);
    const noise = clamp01(traffic * 0.4 + factUtil * 0.35 + (on.tram ? 0.05 : 0.15));
    const safety = (on.lights ? 0.58 : 0.30) + (on.fire ? 0.42 : 0.12);
    const happyTarget = clamp(0.30 * S.health + 0.23 * S.econ + 0.15 * S.reliab * 100
                        + 0.11 * green * 100 + 0.10 * S.waterQ * waterCover
                        + 0.06 * (1 - noise) * 100 + 0.05 * safety * 100, 0, 100);
    S.happy = approach(S.happy, happyTarget, 0.085, dt);

    const homesOpen = (on.homeA ? 0.34 : 0) + (on.homeB ? 0.34 : 0) + (on.homeC ? 0.32 : 0);
    const capacity = POP0 * homesOpen * 1.02;
    const drift = (S.happy - 56) / 56 * 0.0016 + (capacity - S.pop) / POP0 * 0.02;
    S.pop = clamp(S.pop * (1 + drift * dt), 900, POP0 * 1.5);

    S.floodRisk = clamp01((on.dam ? 0 : S.rain * 1.4) + (spill > 0 ? 0.5 : 0) + (1 - S.canopy) * S.rain * 0.6);

    /* ═══ readouts for the UI ════════════════════════════════ */
    D.inflow = inflow; D.release = release; D.spill = spill; D.envFlow = envFlow;
    D.riverFlow = totalDown; D.canalDraw = canalDraw; D.marshFlow = marshFlow;
    D.evap = evap; D.uncontrolled = uncontrolled;
    D.hydroMW = hydroMW; D.windMW = windMW; D.solarMW = solarMW; D.coalMW = coalMW;
    D.renew = renew; D.supply = supply; D.demand = demand; D.served = served; D.deficit = deficit;
    D.head = head; D.wcurve = wcurve; D.haze = haze;
    D.hospEff = hospEff; D.pumpEff = pumpEff; D.treatEff = treatEff; D.factUtil = factUtil;
    D.waterNeed = cityWaterNeed; D.waterCover = waterCover;
    D.mains = mains; D.tankDraw = tankDraw; D.orchIdx = orchIdx;
    D.traffic = traffic; D.emissions = emissions; D.absorb = absorb;
    D.beeIdx = beeIdx; D.foodIdx = foodIdx; D.tourism = tourism;
    D.green = green; D.noise = noise; D.fireRisk = fireRisk; D.irrig = irrig;
    D.renewShare = supply > 0.01 ? renew / supply : 0;
    D.co2 = coalMW * 0.92 + factUtil * 4.1 + traffic * 1.3;
    return S;
  }

  /* ───────────────────────── event log ───────────────────────── */
  function LOG(S, text, sev, cat) {
    if (S.proj) return;
    SIM.events.unshift({
      t: S.hours, text, sev: sev || 'info', cat: cat || 'civic',
      stamp: fmtClock(S.hours), day: Math.floor(S.hours / 24) + 1
    });
    if (SIM.events.length > 90) SIM.events.pop();
    SIM.eventsDirty = true;
  }

  function fmtClock(h) {
    const hod = ((h % 24) + 24) % 24;
    const hh = Math.floor(hod), mm = Math.floor((hod - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  /* ───────────────────── counterfactual engine ─────────────────────
     Fork the world, flip one switch, run both futures forward at a
     coarse step and diff the outcomes. This is what makes the hover
     card honest: nothing about it is written by hand. */

  const METRICS = [
    { k:'power',  label:'Power met',   unit:'%',   get:S => S.d.served * 100,        good: 1 },
    { k:'aqi',    label:'Air (AQI)',   unit:'',    get:S => S.aqi,                   good:-1 },
    { k:'water',  label:'Water',       unit:'%',   get:S => S.d.waterCover * 100,    good: 1 },
    { k:'res',    label:'Reservoir',   unit:'%',   get:S => S.reservoir * 100,       good: 1 },
    { k:'yield',  label:'Harvest',     unit:'%',   get:S => S.yield * 100,           good: 1 },
    { k:'health', label:'Health',      unit:'',    get:S => S.health,                good: 1 },
    { k:'econ',   label:'Economy',     unit:'',    get:S => S.econ,                  good: 1 },
    { k:'happy',  label:'Wellbeing',   unit:'',    get:S => S.happy,                 good: 1 },
    { k:'canopy', label:'Canopy',      unit:'%',   get:S => S.canopy * 100,          good: 1 },
    { k:'temp',   label:'Temperature', unit:'°C',  get:S => S.temp,                  good:-1 }
  ];

  /* Some systems are insurance: they cost nothing visible until the day they
     matter. Rather than fake a number, say so. */
  const LATENT = {
    fire:    'Contingent value: nothing moves while the ground is damp. The moment soil moisture drops and the temperature climbs, this is the only thing standing between the pines and the valley\'s air.',
    weather: 'Quiet until it matters. Its whole job is the six hours of warning before a front arrives: with it, a full reservoir is drawn down through the turbines; without it, the same water goes over the crest as spill and generates nothing.',
    school:  'The skill stock decays over seasons, not hours. Switch it off and the works keeps running on the people it already trained — until they retire.',
    bees:    'Pollination shows up at harvest, not tomorrow. The colony index falls first; the yield follows a season later.',
    tower:   'Full tank, full mains — so nothing moves while the pumps are running. Its entire purpose is the gap: cut the power and the tower is the only reason the taps keep running for the next five hours.',
    bridge:  'It carries no water and no power, so nothing moves the instant you close it. What it costs is measured in journeys: the works loses its west-bank shift, the market loses a fifth of its custom, and the fire crews take the long way round to the pines.',
    park:    'Small lungs. The air barely notices in a day — the wellbeing figure notices sooner than the AQI does.'
  };

  function project(S0, hours, flipId) {
    const S = cloneState(S0);
    S.proj = true;
    if (flipId) S.on[flipId] = !S.on[flipId];
    const stepH = 0.4;
    const n = Math.round(hours / stepH);
    // Track the worst point reached, not just the endpoint. Some systems are
    // buffers — a water tower changes nothing about where you end up, and
    // everything about how bad it gets on the way there.
    const worst = {};
    for (let i = 0; i < n; i++) {
      step(S, stepH);
      for (let k = 0; k < METRICS.length; k++) {
        const m = METRICS[k], v = m.get(S);
        if (worst[m.k] === undefined) worst[m.k] = v;
        else worst[m.k] = m.good > 0 ? Math.min(worst[m.k], v) : Math.max(worst[m.k], v);
      }
    }
    step(S, 0.1);
    S._worst = worst;
    return S;
  }

  const wiCache = new Map();
  let cacheStamp = 0;
  function bumpCache() { cacheStamp++; wiCache.clear(); }

  /**
   * What changes if node `id` is flipped?
   * Returns { deltas:[{k,label,unit,from,to,d,good}], chain:[ids], severity }
   */
  function whatIf(id) {
    const key = id + '@' + cacheStamp;
    if (wiCache.has(key)) return wiCache.get(key);

    const HOURS = 34;
    const base = project(SIM.state, HOURS, null);
    const alt  = project(SIM.state, HOURS, id);

    const deltas = METRICS.map(m => {
      const from = m.get(base), to = m.get(alt);
      const dEnd = to - from;
      const dWorst = (alt._worst[m.k] || 0) - (base._worst[m.k] || 0);
      const transient = Math.abs(dWorst) > Math.abs(dEnd) * 1.6 + 0.5;
      const d = Math.abs(dWorst) > Math.abs(dEnd) ? dWorst : dEnd;
      return { k: m.k, label: m.label, unit: m.unit, from, to, d, good: m.good, transient };
    }).filter(x => Math.abs(x.d) > (x.unit === '°C' ? 0.25 : 0.8));

    deltas.sort((a, b) => {
      const na = Math.abs(a.d) / (a.k === 'aqi' ? 1.4 : 1);
      const nb = Math.abs(b.d) / (b.k === 'aqi' ? 1.4 : 1);
      return nb - na;
    });

    let severity = 0;
    deltas.forEach(x => {
      const hurt = (x.d * x.good) < 0;
      const mag = Math.min(1, Math.abs(x.d) / (x.k === 'aqi' ? 90 : 32));
      severity += hurt ? mag : -mag * 0.55;
    });
    severity = clamp(severity / 2.4, -1, 1);

    const res = { deltas, chain: cascade(id), severity, turningOff: SIM.state.on[id] };
    if (!deltas.length) res.note = LATENT[id] || 'Nothing shifts by more than noise inside the 34-hour window — this one works on a slower clock than the forecast.';
    wiCache.set(key, res);
    return res;
  }

  /* How load-bearing each link is. The graph has plenty of true-but-minor
     couplings (the forest shading the town lowers the cooling peak); without
     weights the cascade tracer keeps wandering down them instead of following
     the spine of the valley. */
  const EDGE_WEIGHT = {
    'forest>dam': 2.6, 'dam>hydro': 2.8, 'hydro>grid': 2.5, 'dam>canal': 2.3,
    'canal>farms': 2.5, 'farms>market': 2.1, 'bees>farms': 2.3, 'forest>bees': 2.0,
    'forest>marsh': 1.9, 'marsh>treat': 1.9, 'grid>pump': 2.2, 'pump>treat': 2.3,
    'treat>homeA': 2.1, 'treat>homeB': 1.6, 'treat>homeC': 1.6, 'treat>hospital': 1.8,
    'grid>factory': 1.9, 'factory>market': 1.9, 'grid>treat': 1.7, 'dam>pump': 1.8,
    'recycle>factory': 1.6, 'school>factory': 1.4, 'market>homeA': 1.4,
    'forest>grid': 0.20, 'forest>solar': 0.22, 'coal>forest': 0.30,
    'coal>solar': 0.32, 'factory>solar': 0.38, 'farms>bees': 0.5,
    'weather>fire': 0.6, 'factory>marsh': 0.7, 'canal>marsh': 0.7
  };

  /** Walk the dependency graph for the most consequential downstream path. */
  function cascade(id, maxDepth) {
    maxDepth = maxDepth || 4;
    const seen = { [id]: true };
    const path = [id];
    let cur = id;
    for (let d = 0; d < maxDepth; d++) {
      const outs = (W.outEdges[cur] || []).filter(e => !seen[e.t] && SIM.state.on[e.t]);
      if (!outs.length) break;
      const rank = e => (EDGE_WEIGHT[e.f + '>' + e.t] || 1)
                      * ((e.s > 0 ? 1.6 : 0.6)
                       + (e.k === 'power' ? 1.0 : e.k === 'water' ? 0.95 : e.k === 'matter' ? 0.7 : 0.5));
      outs.sort((a, b) => rank(b) - rank(a));
      cur = outs[0].t; seen[cur] = true; path.push(cur);
    }
    return path;
  }

  /** All nodes reachable downstream, with hop depth — used for the ripple wave. */
  function downstream(id, maxDepth) {
    maxDepth = maxDepth || 5;
    const depth = { [id]: 0 };
    let frontier = [id];
    for (let d = 1; d <= maxDepth; d++) {
      const next = [];
      frontier.forEach(f => (W.outEdges[f] || []).forEach(e => {
        if (depth[e.t] === undefined) { depth[e.t] = d; next.push(e.t); }
      }));
      frontier = next;
      if (!frontier.length) break;
    }
    return depth;
  }

  /* ───────────────────── per-node live readings ───────────────────── */

  function nodeStats(id) {
    const S = SIM.state, D = S.d, on = S.on[id];
    const pct = v => (v * 100).toFixed(0) + '%';
    const mw = v => v.toFixed(1) + ' MW';
    const T = {
      dam:     () => [['Storage', (S.reservoir * RES_CAP).toFixed(0) + ' ML'], ['Capacity', pct(S.reservoir)],
                      ['Inflow', D.inflow.toFixed(1) + ' ML/h'], ['Release', D.release.toFixed(1) + ' ML/h'],
                      ['Spilling', D.spill > 0.5 ? 'YES' : 'no'], ['Head factor', D.head.toFixed(2) + '×']],
      hydro:   () => [['Output', mw(D.hydroMW)], ['Of capacity', pct(D.hydroMW / HYDRO_CAP)],
                      ['Through-flow', D.release.toFixed(1) + ' ML/h'], ['Head', D.head.toFixed(2) + '×'],
                      ['Share of grid', pct(D.supply ? D.hydroMW / D.supply : 0)], ['Fuel cost', 'none']],
      wind:    () => [['Output', mw(D.windMW)], ['Wind', (S.wind * 26).toFixed(0) + ' km/h'],
                      ['Curve point', pct(D.wcurve)], ['Turbines', S.wind >= 0.94 ? '0 / 5 (storm)' : '5 / 5'],
                      ['Of capacity', pct(D.windMW / WIND_CAP)], ['Share of grid', pct(D.supply ? D.windMW / D.supply : 0)]],
      solar:   () => [['Output', mw(D.solarMW)], ['Irradiance', pct(S.sun)],
                      ['Cloud loss', pct(S.cloud * 0.72)], ['Haze loss', pct(D.haze)],
                      ['Of capacity', pct(D.solarMW / SOLAR_CAP)], ['Share of grid', pct(D.supply ? D.solarMW / D.supply : 0)]],
      coal:    () => [['Output', mw(D.coalMW)], ['Of capacity', pct(D.coalMW / COAL_CAP)],
                      ['Emitting', (D.coalMW * 1.30).toFixed(0) + ' u/h'], ['CO₂', (D.coalMW * 0.92).toFixed(1) + ' t/h'],
                      ['Covering gap', pct(D.demand ? D.coalMW / D.demand : 0)], ['Role', 'dispatchable']],
      grid:    () => [['Demand', mw(D.demand)], ['Supply', mw(D.supply)],
                      ['Demand met', pct(D.served)], ['Renewable', pct(D.renewShare)],
                      ['Reliability', pct(S.reliab)], ['Margin', mw(D.supply - D.demand)]],
      pump:    () => [['Lift rate', (D.waterNeed * D.pumpEff).toFixed(1) + ' ML/h'], ['Power draw', '2.6 MW'],
                      ['Efficiency', pct(D.pumpEff)], ['River flow', D.riverFlow.toFixed(1) + ' ML/h'],
                      ['Town need', D.waterNeed.toFixed(1) + ' ML/h'], ['Coverage', pct(D.waterCover)]],
      treat:   () => [['Throughput', pct(D.treatEff)], ['Output quality', S.waterQ.toFixed(0) + ' / 100'],
                      ['Marsh assist', pct(S.marshHp)], ['Power draw', '1.8 MW'],
                      ['Homes served', D.waterCover > 0.6 ? '3 / 3' : D.waterCover > 0.3 ? '2 / 3' : '0 / 3'],
                      ['Chlorine', D.treatEff > 0.4 ? 'nominal' : 'low']],
      canal:   () => [['Diverting', D.canalDraw.toFixed(1) + ' ML/h'], ['Field soak', pct(D.irrig)],
                      ['Soil moisture', pct(S.soil)], ['Left for marsh', D.marshFlow.toFixed(1) + ' ML/h'],
                      ['Gate', on ? 'open' : 'shut'], ['Demand', (1 - S.soil > 0.5 ? 'high' : 'moderate')]],
      marsh:   () => [['Wetland health', pct(S.marshHp)], ['Inflow', D.marshFlow.toFixed(1) + ' ML/h'],
                      ['Filtration credit', (S.marshHp * 18).toFixed(0) + ' pts'], ['Water quality', S.waterQ.toFixed(0)],
                      ['Habitat', S.marshHp > 0.6 ? 'thriving' : S.marshHp > 0.3 ? 'stressed' : 'collapsing'],
                      ['Saves', (S.marshHp * 1.1).toFixed(1) + ' MW of treatment']],
      forest:  () => [['Canopy cover', pct(S.canopy)], ['CO₂/PM uptake', D.absorb.toFixed(0) + ' u/h'],
                      ['Catchment gain', pct(0.55 + 0.45 * S.canopy)], ['Cooling', '−' + ((S.canopy) * 5.2).toFixed(1) + '°C'],
                      ['Fire risk', pct(D.fireRisk)], ['Burning', S.fire > 0 ? pct(S.fire) : 'no']],
      park:    () => [['Trees', '≈340'], ['Uptake', '5 u/h'], ['Amenity', pct(D.green)],
                      ['Cooling', '−0.6°C local'], ['Visits/day', Math.round(S.pop * 0.08 * (S.aqi < 90 ? 1 : 0.5))],
                      ['Wellbeing', '+' + (D.green * 11).toFixed(1) + ' pts']],
      bees:    () => [['Colony strength', pct(D.beeIdx)], ['Forage', S.canopy > 0.5 ? 'forest + fields' : 'fields only'],
                      ['Pollination', '+' + (D.beeIdx * 24).toFixed(0) + '% yield'], ['Hives', Math.round(60 * D.beeIdx)],
                      ['Air stress', S.aqi > 150 ? 'high' : 'low'], ['Honey', (D.beeIdx * 42).toFixed(0) + ' kg/wk']],
      factory: () => [['Utilisation', pct(D.factUtil)], ['Power draw', mw(9 * (S.on.factory ? 1 : 0))],
                      ['Skilled labour', pct(S.skill)], ['Feedstock', pct(S.feed)],
                      ['Emissions', (D.factUtil * 15).toFixed(0) + ' u/h'], ['Jobs', Math.round(1800 * D.factUtil)]],
      market:  () => [['Trade index', pct(clamp01(S.econ / 100 + 0.1))], ['Produce in', pct(S.yield)],
                      ['Goods in', pct(D.factUtil)], ['Evening trade', S.on.lights ? 'open' : 'closed at dusk'],
                      ['Footfall', Math.round(S.pop * 0.22)], ['Food security', pct(D.foodIdx)]],
      farms:   () => [['Yield index', pct(S.yield)], ['Soil moisture', pct(S.soil)],
                      ['Irrigation', D.canalDraw.toFixed(1) + ' ML/h'], ['Pollination', pct(D.beeIdx)],
                      ['Air penalty', '−' + (clamp01((S.aqi - 70) / 260) * 38).toFixed(0) + '%'],
                      ['Feeds', Math.round(S.pop * S.yield * 1.3) + ' people']],
      recycle: () => [['Recovery', pct(S.feed)], ['Feeds works', pct(S.feed)],
                      ['Power draw', '1.3 MW'], ['Diverted', (S.pop * 0.0009).toFixed(1) + ' t/h'],
                      ['If closed', 'open burning +8 u/h'], ['Landfill', S.on.recycle ? 'minimal' : 'growing']],
      hospital:() => [['Capacity', pct(D.hospEff)], ['Public health', S.health.toFixed(0) + ' / 100'],
                      ['AQI caseload', (clamp01((S.aqi - 50) / 150) * 100).toFixed(0) + '%'],
                      ['Power draw', '3.0 MW'], ['Beds', Math.round(40 * D.hospEff)],
                      ['Water', S.waterQ > 55 ? 'sterile' : 'compromised']],
      school:  () => [['Attendance', pct(S.on.school ? clamp01(D.served * 1.1) : 0)], ['Skill stock', pct(S.skill)],
                      ['Feeds works', '+' + (S.skill * 26).toFixed(0) + '% output'], ['Power draw', '1.9 MW'],
                      ['Pupils', Math.round(S.pop * 0.14)], ['Lag', '~2 seasons']],
      fire:    () => [['Readiness', pct(clamp01(D.served * 1.2))], ['Valley fire risk', pct(D.fireRisk)],
                      ['Active fire', S.fire > 0 ? pct(S.fire) : 'none'], ['Suppression', '0.30 /h'],
                      ['Power draw', '0.4 MW'], ['Crews', S.on.fire ? '2 engines + forest team' : 'stood down']],
      tram:    () => [['Ridership', pct(S.on.tram ? clamp01(D.served) * 0.8 + 0.1 : 0)],
                      ['Cars avoided', pct(S.on.tram ? 0.4 : 0)], ['Traffic index', pct(D.traffic)],
                      ['Power draw', mw(S.d.isNight ? 0.8 : 2.2)], ['Emissions saved', (D.traffic * 6).toFixed(0) + ' u/h'],
                      ['Workers moved', Math.round(S.pop * 0.19)]],
      lights:  () => [['Lamps lit', S.d.isNight ? Math.round(900 * clamp01(D.served)) : '0 (daylight)'],
                      ['Power draw', mw(S.d.isNight ? 1.5 : 0.06)], ['Night trade', S.on.lights ? 'active' : 'shut'],
                      ['Safety index', pct(S.on.lights ? 1 : 0.7)], ['Wellbeing', '+5 pts'],
                      ['Circuit', S.on.lights ? 'energised' : 'open']],
      tower:   () => [['Tank level', pct(S.tank)], ['Stored', (S.tank * TANK_CAP).toFixed(0) + ' ML'],
                      ['Drawing', D.tankDraw > 0.05 ? D.tankDraw.toFixed(1) + ' ML/h' : 'no — refilling'],
                      ['Autonomy', D.waterNeed > 0 ? (S.tank * TANK_CAP / D.waterNeed).toFixed(1) + ' h' : '—'],
                      ['Head', '24 m gravity'], ['Coverage', pct(D.waterCover)]],
      bridge:  () => [['Status', on ? 'open' : 'closed'], ['Crossings/day', on ? Math.round(S.pop * 0.31).toLocaleString() : '0'],
                      ['Works labour', on ? 'full' : '−22%'], ['Market custom', on ? 'full' : '−22%'],
                      ['Fire access', on ? 'direct' : 'long way round'], ['Next crossing', '11 miles']],
      station: () => [['Services/day', on ? '4' : '0'], ['Freight', on ? pct(D.factUtil) : 'by road'],
                      ['Road traffic', pct(D.traffic)], ['Visitors', on ? Math.round(S.pop * 0.04) : '0'],
                      ['Power draw', '0.6 MW'], ['Line', on ? 'open' : 'lifted']],
      orchard: () => [['Orchard index', pct(D.orchIdx)], ['Standards', on ? '≈130' : 'grubbed out'],
                      ['Blossom → hives', on ? '+14% colony' : 'none'], ['Irrigation', D.canalDraw.toFixed(1) + ' ML/h'],
                      ['Cider', (D.orchIdx * 78).toFixed(0) + ' hl/yr'], ['Air uptake', on ? '0.045 /h' : '0']],
      homeA:   () => housing('homeA', 0.34, 'Old Town'),
      homeB:   () => housing('homeB', 0.34, 'Hillside'),
      homeC:   () => housing('homeC', 0.32, 'Riverside'),
      weather: () => [['Forecast +6h', (D.forecastRain || 0) > 0.32 ? 'front incoming' : S.wind > 0.6 ? 'high wind' : 'settled'],
                      ['Rain now', (S.rain * 24).toFixed(1) + ' mm/h'], ['Wind', (S.wind * 26).toFixed(0) + ' km/h'],
                      ['Temp', S.temp.toFixed(1) + '°C'], ['Fire danger', pct(D.fireRisk)],
                      ['Warning time', S.on.weather ? '6 h' : 'none']]
    };
    function housing(hid, share, nm) {
      const people = Math.round(S.pop * share);
      return [['Residents', people.toLocaleString()], ['Power', mw((hid === 'homeB' ? 1.3 : hid === 'homeC' ? 1.05 : 1.0) * (S.pop / POP0) * (1 + clamp01((S.temp - 24) / 13) * 0.9))],
              ['Water', ((6 + (S.pop / POP0) * 9) * share).toFixed(1) + ' ML/h'], ['Supplied', pct(D.waterCover)],
              ['Wellbeing', S.happy.toFixed(0) + ' / 100'], ['Air exposure', S.aqi.toFixed(0) + ' AQI']];
    }
    const f = T[id];
    const rows = f ? f() : [['Status', on ? 'operating' : 'offline']];
    return rows.map(r => ({ k: r[0], v: r[1] }));
  }

  function nodeStatus(id) {
    const S = SIM.state, D = S.d;
    if (!S.on[id]) return 'off';
    const strained = {
      grid:    () => D.served < 0.97,
      pump:    () => D.pumpEff < 0.9,
      treat:   () => D.treatEff < 0.85,
      hospital:() => D.hospEff < 0.95 || S.aqi > 140,
      factory: () => D.factUtil < 0.6,
      hydro:   () => D.hydroMW < 4,
      wind:    () => D.windMW < 1.5,
      solar:   () => D.solarMW < 1 && S.sun > 0.15,
      farms:   () => S.yield < 0.4,
      forest:  () => S.fire > 0 || S.canopy < 0.5,
      marsh:   () => S.marshHp < 0.45,
      bees:    () => D.beeIdx < 0.4,
      canal:   () => D.canalDraw < 3,
      dam:     () => S.reservoir < 0.18 || D.spill > 0.5,
      market:  () => D.foodIdx < 0.45,
      recycle: () => S.feed < 0.3,
      school:  () => D.served < 0.8,
      lights:  () => D.served < 0.8,
      fire:    () => S.fire > 0,
      tram:    () => D.served < 0.8,
      tower:   () => S.tank < 0.35,
      bridge:  () => false,
      station: () => D.served < 0.8,
      orchard: () => D.orchIdx < 0.4,
      homeA:   () => D.waterCover < 0.7 || D.served < 0.9,
      homeB:   () => D.waterCover < 0.7 || D.served < 0.9,
      homeC:   () => D.waterCover < 0.7 || D.served < 0.9
    }[id];
    return (strained && strained()) ? 'strain' : 'on';
  }

  /* ───────────────────────── public object ───────────────────────── */

  const SIM = {
    state: null,
    events: [],
    eventsDirty: true,
    history: [],
    ripple: null,
    RES_CAP, COAL_CAP, HYDRO_CAP, WIND_CAP, SOLAR_CAP, POP0, METRICS,

    init() {
      this.state = freshState();
      this.events = [];
      this.history = [];
      this.ripple = null;
      bumpCache();
      // let the world settle so the opening frame isn't a transient
      for (let i = 0; i < 110; i++) step(this.state, 0.4);
      this.state.hours = 8;
      weather(this.state);
      this.events = [];
      this._flags = {};
      LOG(this.state, 'Verdant Hollow wakes up. Every system nominal — for now.', 'good', 'civic');
      this.sample(true);
    },

    step(dt) {
      step(this.state, dt);
      this.sampleClock -= dt;
      if (this.sampleClock <= 0) { this.sample(); this.sampleClock = 0.5; }
      this.watch();
      if (Math.floor(this.state.hours / 6) !== this.lastStamp) { this.lastStamp = Math.floor(this.state.hours / 6); bumpCache(); }
    },
    sampleClock: 0.5,
    lastStamp: 0,

    sample(force) {
      const S = this.state, D = S.d;
      this.history.push({
        h: S.hours, aqi: S.aqi, served: D.served, res: S.reservoir, happy: S.happy,
        canopy: S.canopy, yield: S.yield, health: S.health, econ: S.econ,
        supply: D.supply, demand: D.demand, temp: S.temp, pop: S.pop, waterQ: S.waterQ
      });
      if (this.history.length > 900) this.history.shift();
    },

    /* narrative watchdogs — these produce the cause→effect log */
    _flags: {},
    watch() {
      const S = this.state, D = S.d, F = this._flags;
      const trip = (key, cond, msg, sev, cat) => {
        if (cond && !F[key]) { F[key] = true; LOG(S, msg, sev, cat); }
        else if (!cond && F[key]) F[key] = false;
      };
      trip('blackout', D.served < 0.86,
        'Grid short by <b>' + ((D.demand - D.supply).toFixed(1)) + ' MW</b> — load shedding across the valley.', 'bad', 'power');
      trip('dry', S.reservoir < 0.16,
        'Reservoir below <b>16%</b>. Turbine release cut; the canal is next.', 'bad', 'water');
      trip('spill', D.spill > 0.5,
        'Reservoir full — <b>spilling</b> over the crest into the gorge.', 'info', 'water');
      trip('smog', S.aqi > 160,
        'Air quality <b>' + S.aqi.toFixed(0) + ' AQI</b>. Clinic admissions climbing; solar yield falling.', 'bad', 'air');
      trip('clean', S.aqi < 35,
        'Air down to <b>' + S.aqi.toFixed(0) + ' AQI</b> — the cleanest week on record.', 'good', 'air');
      trip('thirst', D.waterCover < 0.55,
        'Taps running dry in <b>' + (D.waterCover < 0.3 ? 'most' : 'some') + '</b> of town.', 'bad', 'water');
      trip('crop', S.yield < 0.3,
        'Harvest index down to <b>' + (S.yield * 100).toFixed(0) + '%</b> — the market is thinning out.', 'bad', 'econ');
      trip('bare', S.canopy < 0.35,
        'Canopy below <b>35%</b>. Runoff is flashier, the town is hotter, the air is worse.', 'bad', 'nature');
      trip('unhappy', S.happy < 42,
        'Wellbeing at <b>' + S.happy.toFixed(0) + '</b>. People are starting to leave.', 'bad', 'civic');
      trip('thriving', S.happy > 82,
        'Wellbeing at <b>' + S.happy.toFixed(0) + '</b> — the valley is thriving.', 'good', 'civic');
      trip('storm', S.wind >= 0.94,
        'Gale on the ridge — wind turbines <b>feathered and stopped</b> for safety.', 'info', 'power');
    },

    toggle(id, silent) {
      const S = this.state;
      const node = W.byId[id];
      S.on[id] = !S.on[id];
      bumpCache();
      this.ripple = { origin: id, t: 0, depth: downstream(id, 5), off: !S.on[id] };
      if (!silent) {
        LOG(S, '<b>' + node.name + '</b> ' + (S.on[id] ? 'brought back online' : 'switched off') + '. '
             + rippleSentence(id, S.on[id]), S.on[id] ? 'good' : 'bad', node.cat);
      }
      return S.on[id];
    },

    whatIf, cascade, downstream, nodeStats, nodeStatus, fmtClock, project, cloneState, bumpCache,
    log: (t, s, c) => LOG(SIM.state, t, s, c)
  };

  function rippleSentence(id, nowOn) {
    const chain = cascade(id, 3).slice(1).map(i => W.byId[i].short);
    if (!chain.length) return '';
    return (nowOn ? 'Recovery should reach ' : 'Expect it to travel to ') + chain.join(' → ') + '.';
  }

  global.SIM = SIM;
  global.SIM_LOG = LOG;
})(window);
