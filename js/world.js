/* ═══════════════════════════════════════════════════════════
   world.js — the geography of Verdant Hollow.

   A 4600 × 3400 valley: reservoir and dam in the northern gorge,
   the river running the length of it, old forest on the western
   slopes, the town on the eastern bank, the works beyond that,
   and the terraces in the south.

   The urban fabric is generated: districts are laid out as blocks
   separated by streets, and buildings are packed around each block
   facing outward, so the town reads as streets and frontages
   rather than as scattered boxes.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { fbm, clamp, clamp01, smoothstep, mix, makeRNG, TAU } = NZ;

  const W = { w: 4600, h: 3400 };

  /* ───────────────────────── water ───────────────────────── */

  W.lake = [
    [1146, 470], [1180, 336], [1290, 232], [1470, 172], [1690, 146], [1900, 158],
    [2100, 140], [2290, 176], [2430, 258], [2492, 372], [2470, 486], [2370, 566],
    [2210, 616], [2040, 648], [1960, 672], [1700, 678], [1560, 646], [1400, 610],
    [1250, 556]
  ];
  W.damRect = { x0: 1616, y0: 662, x1: 1992, y1: 706 };

  W.river = [
    [1804, 700], [1786, 806], [1848, 928], [1770, 1062], [1826, 1196], [1742, 1330],
    [1800, 1462], [1704, 1608], [1758, 1750], [1662, 1902], [1712, 2054], [1616, 2196],
    [1668, 2350], [1580, 2508], [1630, 2668], [1544, 2842], [1592, 3010], [1520, 3180],
    [1556, 3400]
  ];

  W.canal = [
    [1636, 2216], [1860, 2286], [2140, 2352], [2470, 2418], [2840, 2478],
    [3220, 2530], [3600, 2570], [3944, 2604]
  ];

  W.marsh = [
    [1372, 1922], [1500, 1876], [1636, 1918], [1704, 2032], [1690, 2186],
    [1596, 2288], [1440, 2296], [1338, 2196], [1312, 2050]
  ];

  /* ───────────────────── primary road network ───────────────────── */
  W.roads = [
    { id:'damrd',    w:20, pts:[[2062,772],[1978,706],[1804,690],[1618,712],[1420,772],[1258,872]] },
    { id:'westrd',   w:16, pts:[[1258,872],[1074,996],[940,1200],[880,1442],[912,1690],[1006,1950],[1152,2244],[1300,2596],[1424,2946]] },
    { id:'bridgerd', w:19, pts:[[1128,1536],[1330,1508],[1520,1500],[1704,1512],[1900,1530],[2086,1552]] },
    { id:'artery',   w:23, pts:[[2062,772],[2098,976],[2064,1194],[2104,1414],[2142,1652],[2112,1894],[2166,2172],[2268,2436],[2470,2618],[2772,2740]] },
    { id:'ring',     w:19, pts:[[2140,1096],[2400,1006],[2700,1018],[2960,1096],[3160,1264],[3238,1508],[3204,1780],[3072,2016],[2842,2166],[2570,2192],[2320,2098],[2178,1876],[2126,1596],[2140,1096]] },
    { id:'high',     w:17, pts:[[2334,1560],[2560,1512],[2790,1520],[3010,1572],[3186,1652]] },
    { id:'indus',    w:21, pts:[[3186,1652],[3410,1560],[3648,1450],[3888,1322],[4118,1152],[4262,996]] },
    { id:'ridge',    w:14, pts:[[3888,1322],[3856,1080],[3766,856],[3546,712],[3288,652]] },
    { id:'stationrd',w:17, pts:[[3010,1572],[3092,1786],[3158,2004],[3120,2240]] },
    { id:'southrd',  w:18, pts:[[2772,2740],[3110,2828],[3470,2782],[3818,2680],[4092,2572]] },
    { id:'farmlane', w:13, pts:[[2470,2618],[2606,2896],[2900,3046],[3266,3072],[3560,3010]] },
    { id:'orchlane', w:12, pts:[[2268,2436],[2126,2596],[2032,2820],[2076,3040]] }
  ];

  /* the railway — drawn as sleepers and rail, not a road */
  W.rail = [[3312,606],[3288,900],[3236,1240],[3196,1580],[3158,2004],[3122,2372],[3086,2760],[3050,3140],[3030,3400]];

  /* ───────────────────── geometry helpers ───────────────────── */

  function smoothPath(pts, step) {
    step = step || 18;
    const out = [];
    const P = i => pts[clamp(i, 0, pts.length - 1)];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const n = Math.max(2, Math.ceil(seg / step));
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
          0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
        ]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx*dx + dy*dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = clamp01(t);
    return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
  }

  function distToPath(px, py, pts) {
    let best = 1e9;
    for (let i = 1; i < pts.length; i++) {
      const d = distToSeg(px, py, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
      if (d < best) best = d;
    }
    return best;
  }

  function pathLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]);
    return L;
  }

  function pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /** A coarse scalar field with bilinear lookup. Distance queries against
      long polylines are far too slow to call per pixel, so we bake them. */
  function makeField(res, fn) {
    const gw = Math.ceil(W.w / res) + 2, gh = Math.ceil(W.h / res) + 2;
    const data = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++)
        data[j * gw + i] = fn(i * res, j * res);
    return function (x, y) {
      const fx = clamp(x / res, 0, gw - 1.001), fy = clamp(y / res, 0, gh - 1.001);
      const i = fx | 0, j = fy | 0, tx = fx - i, ty = fy - j;
      const a = data[j*gw+i], b = data[j*gw+i+1], c = data[(j+1)*gw+i], d = data[(j+1)*gw+i+1];
      return mix(mix(a, b, tx), mix(c, d, tx), ty);
    };
  }

  W.smoothRiver = smoothPath(W.river, 16);
  W.smoothCanal = smoothPath(W.canal, 18);
  W.smoothRail  = smoothPath(W.rail, 20);
  W.roads.forEach(r => { r.smooth = smoothPath(r.pts, 16); r.len = pathLength(r.smooth); });

  const riverDistF = makeField(28, (x, y) => distToPath(x, y, W.smoothRiver));
  const canalDistF = makeField(32, (x, y) => distToPath(x, y, W.smoothCanal));

  /* ───────────────────── terrain field ───────────────────── */

  function elevation(x, y) {
    let e = 0.34;
    e += smoothstep(920, 40, y) * 0.96;                       // northern range
    e += smoothstep(3860, 4600, x) * 0.44;                    // eastern ridge
    e += smoothstep(1020, 60, x) * 0.56;                      // western hills
    e += smoothstep(2500, 3400, y) * -0.06;                   // southern flats
    e += fbm(x / 900, y / 900, 5) * 0.20;
    e += fbm(x / 235, y / 235, 3) * 0.05;
    e -= smoothstep(320, 0, riverDistF(x, y)) * 0.23;         // the valley floor
    return clamp(e, 0, 1.5);
  }
  W.elevation = elevation;
  W.elevF = makeField(10, elevation);

  W.inLake  = (x, y) => pointInPoly(x, y, W.lake);
  W.inMarsh = (x, y) => pointInPoly(x, y, W.marsh);
  W.riverDist = riverDistF;
  W.canalDist = canalDistF;
  W.distToPath = distToPath;
  W.smoothPath = smoothPath;
  W.pointInPoly = pointInPoly;
  W.pathLength = pathLength;

  /* ───────────────────── structures (simulation nodes) ───────────────────── */
  W.nodes = [
    /* ---------- POWER ---------- */
    { id:'dam', name:'Hollow Ridge Dam', short:'Dam', cat:'power', icon:'🏞', kind:'dam',
      x:1804, y:684, w:376, d:44, h:62, toggleable:true,
      blurb:'A concrete arch holding back the monsoon. Its gates decide how much water reaches the turbines, the canal and the marsh downstream.' },

    { id:'hydro', name:'Turbine Hall', short:'Hydro', cat:'power', icon:'⚡', kind:'powerhouse',
      x:1926, y:800, w:104, d:74, h:48, toggleable:true,
      blurb:'Two Francis turbines in the tailrace. Output is the product of head and release — no rain upstream, no current downstream.' },

    { id:'wind', name:'Ridgeline Wind Array', short:'Wind', cat:'power', icon:'🌬', kind:'wind',
      x:3640, y:764, w:660, d:400, h:0, toggleable:true,
      blurb:'Six turbines strung along the exposed ridge. Power scales with the cube of wind speed, so a calm afternoon is worth almost nothing.' },

    { id:'solar', name:'Sunfield Array', short:'Solar', cat:'power', icon:'🔆', kind:'solar',
      x:4004, y:2790, w:400, d:260, h:10, toggleable:true,
      blurb:'Nine hectares of panels on the south slope. Cloud steals output — and so does haze, which is why the works upwind is quietly its enemy.' },

    { id:'coal', name:'Blackstack Thermal', short:'Thermal', cat:'power', icon:'🏭', kind:'coal',
      x:4276, y:906, w:190, d:140, h:92, toggleable:true,
      blurb:'The dispatchable one. It will cover any shortfall the weather leaves behind, and charge the valley for it in particulates.' },

    { id:'grid', name:'Central Substation', short:'Substation', cat:'power', icon:'🔌', kind:'substation',
      x:3336, y:1418, w:130, d:96, h:34, toggleable:true,
      blurb:'Every electron in the valley passes through these busbars. It is the single point of failure the town pretends not to think about.' },

    /* ---------- WATER ---------- */
    { id:'pump', name:'Riverside Pump Station', short:'Pumps', cat:'water', icon:'🚰', kind:'pump',
      x:1946, y:1120, w:96, d:74, h:42, toggleable:true,
      blurb:'Lifts raw river water up to the treatment works. Electrically hungry, and utterly dependent on the grid it does not control.' },

    { id:'treat', name:'Water Treatment Works', short:'Treatment', cat:'water', icon:'💧', kind:'treatment',
      x:1948, y:2118, w:190, d:140, h:32, toggleable:true,
      blurb:'Settling, filtration, chlorination. Its job gets easier the cleaner the marsh keeps the river, and impossible without power.' },

    { id:'tower', name:'Ridgeway Water Tower', short:'Tower', cat:'water', icon:'🗼', kind:'tower',
      x:2528, y:1204, w:56, d:56, h:104, toggleable:true,
      blurb:'Nine hundred cubic metres held eighty feet up. It is the only reason a power cut does not empty every tap in the Hollow within the hour.' },

    { id:'canal', name:'Canal Head Gate', short:'Canal', cat:'water', icon:'🛶', kind:'gate',
      x:1706, y:2244, w:76, d:52, h:24, toggleable:true,
      blurb:'Diverts river flow east to the terraces. Open it and the fields drink; open it too far and the marsh goes thirsty.' },

    { id:'marsh', name:'Heron Marsh', short:'Marsh', cat:'water', icon:'🪷', kind:'marsh',
      x:1508, y:2086, w:380, d:400, h:0, toggleable:true,
      blurb:'Reeds and silt doing for free what the treatment works does for megawatts. Drain it and every downstream cost goes up.' },

    { id:'bridge', name:'Millstone Bridge', short:'Bridge', cat:'water', icon:'🌉', kind:'bridge',
      x:1620, y:1504, w:170, d:38, h:24, toggleable:true,
      blurb:'Three stone arches, and the only crossing for eleven miles. Half the workforce and every fire engine bound for the pines goes over it.' },

    /* ---------- NATURE ---------- */
    { id:'forest', name:'Old Pine Forest', short:'Forest', cat:'nature', icon:'🌲', kind:'forest',
      x:820, y:1360, w:1120, d:1500, h:0, toggleable:true,
      blurb:'The valley\'s lung, sponge and thermostat. It scrubs the air, slows the runoff into the dam, shades the town and feeds the bees.' },

    { id:'park', name:'Commons Park', short:'Park', cat:'nature', icon:'🌳', kind:'park',
      x:2712, y:1830, w:300, d:230, h:0, toggleable:true,
      blurb:'Eleven acres of plane trees inside the ring road. Small lungs, large effect on whether anyone wants to live here.' },

    { id:'bees', name:'Meadow Apiary', short:'Apiary', cat:'nature', icon:'🐝', kind:'apiary',
      x:2262, y:2712, w:96, d:76, h:22, toggleable:true,
      blurb:'Sixty hives that forage the forest edge in spring and the terraces in summer. Two thirds of the harvest passes through them first.' },

    { id:'orchard', name:'Cider Orchard', short:'Orchard', cat:'nature', icon:'🍎', kind:'orchard',
      x:2050, y:2790, w:440, d:460, h:0, toggleable:true,
      blurb:'Two hundred year old standards on the river terrace. Blossom in April feeds the hives that go on to pollinate everything else.' },

    /* ---------- ECONOMY ---------- */
    { id:'factory', name:'Ironleaf Works', short:'Factory', cat:'econ', icon:'⚙️', kind:'factory',
      x:3874, y:1206, w:300, d:200, h:76, toggleable:true,
      blurb:'The largest employer and the largest emitter. Runs on power, trained hands and recycled feedstock — and dulls the solar farm downwind.' },

    { id:'market', name:'Market Square', short:'Market', cat:'econ', icon:'🏪', kind:'market',
      x:2646, y:1622, w:156, d:112, h:30, toggleable:true,
      blurb:'Where the harvest, the wages and the gossip all change hands. Trades late only if the streetlights are burning.' },

    { id:'farms', name:'Terrace Farms', short:'Farms', cat:'econ', icon:'🌾', kind:'farm',
      x:3220, y:2880, w:1600, d:600, h:0, toggleable:true,
      blurb:'Stepped fields on the southern flats. Needs canal water, pump-fed pressure, pollinators and air clean enough to let the leaves breathe.' },

    { id:'recycle', name:'Materials Recovery', short:'Recycling', cat:'econ', icon:'♻️', kind:'recycle',
      x:3620, y:1720, w:180, d:130, h:44, toggleable:true,
      blurb:'Sorts the valley\'s waste back into factory feedstock. Switch it off and the rest is burned at the edge of town — the sky notices within hours.' },

    { id:'station', name:'Hollow Halt', short:'Station', cat:'econ', icon:'🚉', kind:'station',
      x:3158, y:2004, w:180, d:100, h:44, toggleable:true,
      blurb:'One platform, four trains a day. It is how the works ships out, how the shops restock, and how anyone arrives who was not born here.' },

    /* ---------- CIVIC ---------- */
    { id:'hospital', name:'St. Cyprus Clinic', short:'Clinic', cat:'civic', icon:'🏥', kind:'hospital',
      x:2946, y:1912, w:200, d:140, h:66, toggleable:true,
      blurb:'Forty beds, one generator, no margin. Every point of air quality lost here arrives as an admission within a week.' },

    { id:'school', name:'Valley School', short:'School', cat:'civic', icon:'🎓', kind:'school',
      x:2450, y:1948, w:164, d:112, h:40, toggleable:true,
      blurb:'Turns children into the skilled hands the works depends on. The slowest feedback loop on the map, and the one with the longest reach.' },

    { id:'fire', name:'Fire & Rescue', short:'Fire Stn', cat:'civic', icon:'🚒', kind:'fire',
      x:2246, y:1690, w:130, d:96, h:44, toggleable:true,
      blurb:'Two engines and a forest crew. In a dry August it is the only thing standing between the pines and the whole valley\'s air.' },

    { id:'tram', name:'Tramline & Depot', short:'Tram', cat:'civic', icon:'🚋', kind:'tram',
      x:3086, y:1332, w:170, d:120, h:44, toggleable:true,
      blurb:'Electric, unglamorous, and responsible for a third of the trips that would otherwise be tailpipes on the ring road.' },

    { id:'lights', name:'Street Lighting', short:'Lighting', cat:'civic', icon:'💡', kind:'lights',
      x:2478, y:1440, w:56, d:44, h:46, toggleable:true,
      blurb:'Nine hundred lamps on one contactor. Cheap to run, and the difference between an evening economy and a curfew.' },

    { id:'homeA', name:'Old Town Terraces', short:'Old Town', cat:'civic', icon:'🏘', kind:'housing',
      x:2400, y:1310, w:560, d:420, h:0, toggleable:true,
      blurb:'The oldest quarter, closest to the river. Draws water, power and patience; supplies labour, custom and complaints.' },

    { id:'homeB', name:'Hillside Flats', short:'Hillside', cat:'civic', icon:'🏢', kind:'housing',
      x:2900, y:1160, w:620, d:340, h:0, toggleable:true,
      blurb:'Six storeys on the north slope. Higher density, higher cooling load — the first place a heatwave shows up in the demand curve.' },

    { id:'homeC', name:'Riverside & New Estate', short:'Riverside', cat:'civic', icon:'🏬', kind:'housing',
      x:2760, y:1990, w:1060, d:520, h:0, toggleable:true,
      blurb:'Newest housing, built on the floodplain because the view was good. The dam is the reason that was ever a defensible idea.' },

    { id:'weather', name:'Weather Station', short:'Weather', cat:'civic', icon:'📡', kind:'weather',
      x:1052, y:1042, w:56, d:48, h:64, toggleable:true,
      blurb:'Anemometer, rain gauge, and six hours of warning. It generates nothing — it just means every other decision is made with eyes open.' }
  ];

  /* ───────────────────── dependency graph ───────────────────── */
  W.edges = [
    { f:'forest',  t:'dam',      k:'water',  s: 1, l:'catchment holds the rain back' },
    { f:'dam',     t:'hydro',    k:'water',  s: 1, l:'head & release' },
    { f:'dam',     t:'canal',    k:'water',  s: 1, l:'regulated flow' },
    { f:'dam',     t:'marsh',    k:'water',  s: 1, l:'environmental release' },
    { f:'dam',     t:'pump',     k:'water',  s: 1, l:'keeps the river running' },

    { f:'hydro',   t:'grid',     k:'power',  s: 1, l:'baseload MW' },
    { f:'wind',    t:'grid',     k:'power',  s: 1, l:'ridge MW' },
    { f:'solar',   t:'grid',     k:'power',  s: 1, l:'daylight MW' },
    { f:'coal',    t:'grid',     k:'power',  s: 1, l:'dispatchable MW' },

    { f:'grid',    t:'pump',     k:'power',  s: 1, l:'pump motors' },
    { f:'grid',    t:'treat',    k:'power',  s: 1, l:'filtration' },
    { f:'grid',    t:'factory',  k:'power',  s: 1, l:'line power' },
    { f:'grid',    t:'hospital', k:'power',  s: 1, l:'theatre & wards' },
    { f:'grid',    t:'school',   k:'power',  s: 1, l:'lighting & heat' },
    { f:'grid',    t:'tram',     k:'power',  s: 1, l:'overhead line' },
    { f:'grid',    t:'lights',   k:'power',  s: 1, l:'lamp circuits' },
    { f:'grid',    t:'market',   k:'power',  s: 1, l:'cold storage' },
    { f:'grid',    t:'recycle',  k:'power',  s: 1, l:'sorting line' },
    { f:'grid',    t:'station',  k:'power',  s: 1, l:'signals & platform' },
    { f:'grid',    t:'homeA',    k:'power',  s: 1, l:'domestic supply' },
    { f:'grid',    t:'homeB',    k:'power',  s: 1, l:'domestic supply' },
    { f:'grid',    t:'homeC',    k:'power',  s: 1, l:'domestic supply' },
    { f:'grid',    t:'fire',     k:'power',  s: 1, l:'station & pumps' },

    { f:'pump',    t:'treat',    k:'water',  s: 1, l:'raw water lift' },
    { f:'marsh',   t:'treat',    k:'water',  s: 1, l:'pre-filtered inflow' },
    { f:'treat',   t:'tower',    k:'water',  s: 1, l:'fills the tank' },
    { f:'tower',   t:'homeA',    k:'water',  s: 1, l:'gravity supply' },
    { f:'tower',   t:'homeB',    k:'water',  s: 1, l:'gravity supply' },
    { f:'tower',   t:'homeC',    k:'water',  s: 1, l:'gravity supply' },
    { f:'tower',   t:'hospital', k:'water',  s: 1, l:'pressure through an outage' },
    { f:'treat',   t:'hospital', k:'water',  s: 1, l:'sterile water' },
    { f:'canal',   t:'farms',    k:'water',  s: 1, l:'irrigation' },
    { f:'canal',   t:'orchard',  k:'water',  s: 1, l:'terrace ditches' },

    { f:'forest',  t:'marsh',    k:'water',  s: 1, l:'silt & flow control' },
    { f:'forest',  t:'bees',     k:'matter', s: 1, l:'spring forage' },
    { f:'forest',  t:'grid',     k:'power',  s: 1, l:'shade cuts cooling peak' },
    { f:'forest',  t:'solar',    k:'power',  s: 1, l:'clears haze off the panels' },
    { f:'park',    t:'homeA',    k:'social', s: 1, l:'green amenity' },
    { f:'park',    t:'homeC',    k:'social', s: 1, l:'green amenity' },
    { f:'bees',    t:'farms',    k:'matter', s: 1, l:'pollination' },
    { f:'bees',    t:'orchard',  k:'matter', s: 1, l:'pollination' },
    { f:'orchard', t:'bees',     k:'matter', s: 1, l:'April blossom' },
    { f:'orchard', t:'market',   k:'matter', s: 1, l:'cider & fruit' },
    { f:'farms',   t:'bees',     k:'matter', s: 1, l:'summer forage' },
    { f:'farms',   t:'market',   k:'matter', s: 1, l:'produce' },
    { f:'factory', t:'market',   k:'matter', s: 1, l:'goods & wages' },
    { f:'recycle', t:'factory',  k:'matter', s: 1, l:'feedstock' },
    { f:'station', t:'factory',  k:'matter', s: 1, l:'freight out' },
    { f:'station', t:'market',   k:'matter', s: 1, l:'restocking & visitors' },
    { f:'school',  t:'factory',  k:'social', s: 1, l:'skilled labour' },
    { f:'tram',    t:'factory',  k:'social', s: 1, l:'workers on shift' },
    { f:'bridge',  t:'factory',  k:'social', s: 1, l:'west-bank workforce' },
    { f:'bridge',  t:'market',   k:'social', s: 1, l:'west-bank trade' },
    { f:'bridge',  t:'fire',     k:'social', s: 1, l:'engine access to the pines' },
    { f:'market',  t:'homeA',    k:'social', s: 1, l:'food & trade' },
    { f:'market',  t:'homeB',    k:'social', s: 1, l:'food & trade' },
    { f:'lights',  t:'market',   k:'social', s: 1, l:'evening trade' },
    { f:'lights',  t:'homeC',    k:'social', s: 1, l:'safe streets' },
    { f:'hospital',t:'homeA',    k:'social', s: 1, l:'care capacity' },
    { f:'hospital',t:'homeB',    k:'social', s: 1, l:'care capacity' },
    { f:'fire',    t:'forest',   k:'social', s: 1, l:'wildfire suppression' },
    { f:'weather', t:'dam',      k:'social', s: 1, l:'release forecasting' },
    { f:'weather', t:'fire',     k:'social', s: 1, l:'fire danger warning' },
    { f:'weather', t:'coal',     k:'social', s: 1, l:'demand forecasting' },
    { f:'homeA',   t:'factory',  k:'social', s: 1, l:'workforce' },
    { f:'homeB',   t:'market',   k:'social', s: 1, l:'custom' },
    { f:'homeC',   t:'farms',    k:'social', s: 1, l:'farm labour' },

    { f:'coal',    t:'solar',    k:'air',    s:-1, l:'plume hazes the array' },
    { f:'coal',    t:'hospital', k:'air',    s:-1, l:'respiratory admissions' },
    { f:'coal',    t:'forest',   k:'air',    s:-1, l:'acid deposition' },
    { f:'factory', t:'solar',    k:'air',    s:-1, l:'soot on the glass' },
    { f:'factory', t:'farms',    k:'air',    s:-1, l:'dulled leaf uptake' },
    { f:'factory', t:'hospital', k:'air',    s:-1, l:'air-quality caseload' },
    { f:'factory', t:'marsh',    k:'water',  s:-1, l:'process discharge' },
    { f:'canal',   t:'marsh',    k:'water',  s:-1, l:'diverted flow' },
    { f:'farms',   t:'bees',     k:'matter', s:-1, l:'spray drift' }
  ];

  W.districts = [
    { name:'HOLLOW RIDGE',   x:1800, y:400,  sub:'catchment & reservoir' },
    { name:'OLD PINE',       x:760,  y:1400, sub:'protected forest' },
    { name:'THE HOLLOW',     x:2660, y:1440, sub:'town core' },
    { name:'IRONLEAF',       x:3900, y:1120, sub:'industrial estate' },
    { name:'SOUTH TERRACES', x:3300, y:2960, sub:'agricultural belt' },
    { name:'HERON MARSH',    x:1420, y:2100, sub:'wetland reserve' },
    { name:'THE ORCHARDS',   x:2020, y:2830, sub:'river terrace' }
  ];

  W.byId = {};
  W.nodes.forEach(n => { W.byId[n.id] = n; });
  W.outEdges = {}; W.inEdges = {};
  W.edges.forEach(e => {
    (W.outEdges[e.f] = W.outEdges[e.f] || []).push(e);
    (W.inEdges[e.t]  = W.inEdges[e.t]  || []).push(e);
  });

  /* ═══════════════════ generated urban fabric ═══════════════════
     Districts are grids of blocks. Buildings are packed around each
     block's perimeter facing the street, with gardens, hedges and
     walls behind them. The streets are the gaps between blocks.
  ═══════════════════════════════════════════════════════════════ */

  W.buildings = [];
  W.streets   = [];
  W.props     = [];

  const HOUSE_KEYS = ['brick','brick2','render','render2','stone','slate','ochre','sage'];

  function rot2(px, py, cx, cy, a) {
    const s = Math.sin(a), c = Math.cos(a);
    const dx = px - cx, dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  /** Pack buildings shoulder to shoulder along one edge of a block. */
  function frontage(out, hedges, ax, ay, bx, by, cfg, rng, owner) {
    const len = Math.hypot(bx - ax, by - ay);
    const ang = Math.atan2(by - ay, bx - ax);
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    let s = cfg.margin + rng() * 10;
    while (s < len - cfg.margin - cfg.minW) {
      const wdt = cfg.minW + rng() * (cfg.maxW - cfg.minW);
      if (s + wdt > len - cfg.margin) break;
      const gap = cfg.terrace ? (rng() < 0.82 ? 1.5 : 5 + rng() * 9) : cfg.gapMin + rng() * cfg.gapVar;
      const dep = cfg.minD + rng() * (cfg.maxD - cfg.minD);
      const mid = s + wdt / 2;
      const cx = ax + Math.cos(ang) * mid - nx * (dep / 2 + cfg.setback);
      const cy = ay + Math.sin(ang) * mid - ny * (dep / 2 + cfg.setback);
      const storeys = cfg.minStorey + ((rng() * (cfg.maxStorey - cfg.minStorey + 1)) | 0);
      const pal = cfg.pal || HOUSE_KEYS[(rng() * HOUSE_KEYS.length) | 0];
      out.push({
        x: cx, y: cy, w: wdt, d: dep, rot: ang,
        h: storeys * cfg.storeyH, storeys,
        roof: cfg.roof === 'mixed' ? (rng() < 0.72 ? 'gable' : (rng() < 0.5 ? 'hip' : 'flat')) : cfg.roof,
        roofH: cfg.roof === 'flat' ? 0 : (7 + rng() * 7),
        pal, type: cfg.type, owner,
        chimney: cfg.chimney && rng() < 0.78,
        tone: rng(), lit: rng(), seedv: rng()
      });
      if (cfg.hedge && rng() < 0.7) {
        hedges.push({ x: ax + Math.cos(ang) * mid + nx * 3, y: ay + Math.sin(ang) * mid + ny * 3,
                      w: wdt * 0.94, rot: ang, h: 7 + rng() * 5,
                      kind: rng() < 0.62 ? 'hedge' : 'wall' });
      }
      s += wdt + gap;
    }
  }

  function layDistrict(cfg) {
    const rng = makeRNG(cfg.seed);
    const cx0 = cfg.x + (cfg.cols * (cfg.bw + cfg.gap)) / 2;
    const cy0 = cfg.y + (cfg.rows * (cfg.bh + cfg.gap)) / 2;
    const hedges = [];
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        if (cfg.skip && rng() < cfg.skip) continue;
        const bx = cfg.x + c * (cfg.bw + cfg.gap);
        const by = cfg.y + r * (cfg.bh + cfg.gap);
        const jx = (rng() - 0.5) * 12, jy = (rng() - 0.5) * 12;
        const corners = [[bx + jx, by + jy], [bx + cfg.bw + jx, by + jy],
                         [bx + cfg.bw + jx, by + cfg.bh + jy], [bx + jx, by + cfg.bh + jy]]
                        .map(p => rot2(p[0], p[1], cx0, cy0, cfg.rot));
        const raw = [];
        for (let e = 0; e < 4; e++) {
          const a = corners[e], b = corners[(e + 1) % 4];
          frontage(raw, hedges, a[0], a[1], b[0], b[1], cfg, rng, cfg.owner);
        }
        const ic = rot2(bx + cfg.bw / 2 + jx, by + cfg.bh / 2 + jy, cx0, cy0, cfg.rot);
        const gt = 2 + ((rng() * 4) | 0);
        for (let g = 0; g < gt; g++) {
          W.props.push({ kind:'gardentree', x: ic[0] + (rng() - .5) * cfg.bw * 0.5,
                         y: ic[1] + (rng() - .5) * cfg.bh * 0.5,
                         r: 8 + rng() * 8, h: 20 + rng() * 22, tone: rng(), owner: cfg.owner });
        }
        if (rng() < 0.5) W.props.push({ kind:'shed', x: ic[0] + (rng()-.5)*cfg.bw*0.4,
                         y: ic[1] + (rng()-.5)*cfg.bh*0.4, w: 14+rng()*10, d: 11+rng()*7,
                         h: 12+rng()*6, rot: cfg.rot + (rng()-.5)*0.5, owner: cfg.owner });
        raw.forEach(b => W.buildings.push(b));
        for (let e = 0; e < 4; e++) {
          W.streets.push({ a: corners[e], b: corners[(e + 1) % 4], w: cfg.streetW || 15 });
        }
      }
    }
    hedges.forEach(h => W.props.push(Object.assign({ owner: cfg.owner }, h)));
  }

  const TERRACE = { minW:26, maxW:38, minD:26, maxD:36, margin:16, setback:9, terrace:true,
                    gapMin:2, gapVar:4, storeyH:15, minStorey:2, maxStorey:3, roof:'gable',
                    chimney:true, hedge:true, streetW:15 };
  const DETACHED = { minW:30, maxW:44, minD:28, maxD:40, margin:22, setback:16, terrace:false,
                     gapMin:14, gapVar:16, storeyH:15, minStorey:1, maxStorey:2, roof:'mixed',
                     chimney:true, hedge:true, streetW:14 };
  const FLATS    = { minW:44, maxW:70, minD:34, maxD:48, margin:20, setback:12, terrace:false,
                     gapMin:16, gapVar:14, storeyH:14, minStorey:4, maxStorey:6, roof:'flat',
                     chimney:false, hedge:false, streetW:17 };
  const SHEDS    = { minW:64, maxW:120, minD:52, maxD:84, margin:24, setback:18, terrace:false,
                     gapMin:22, gapVar:26, storeyH:22, minStorey:1, maxStorey:2, roof:'shed',
                     chimney:false, hedge:false, pal:'shed', streetW:20 };

  layDistrict(Object.assign({}, TERRACE,  { x:2160, y:1130, cols:5, rows:3, bw:152, bh:112, gap:52,
                                            rot:-0.10, seed:1201, owner:'homeA', type:'terrace', skip:0.05 }));
  layDistrict(Object.assign({}, FLATS,    { x:2680, y:1006, cols:3, rows:3, bw:180, bh:122, gap:58,
                                            rot: 0.07, seed:2202, owner:'homeB', type:'flats', skip:0.05 }));
  layDistrict(Object.assign({}, DETACHED, { x:2632, y:1804, cols:5, rows:3, bw:168, bh:122, gap:58,
                                            rot: 0.03, seed:3303, owner:'homeC', type:'detached', skip:0.10 }));
  layDistrict(Object.assign({}, TERRACE,  { x:2180, y:1846, cols:4, rows:3, bw:150, bh:110, gap:50,
                                            rot:-0.05, seed:4404, owner:'homeC', type:'terrace', skip:0.07 }));
  layDistrict(Object.assign({}, SHEDS,    { x:3500, y:940,  cols:3, rows:2, bw:250, bh:180, gap:80,
                                            rot: 0.05, seed:5505, owner:'factory', type:'shed', skip:0.15 }));

  /* the high street: shopfronts facing the road on both sides */
  (function highStreet() {
    const rng = makeRNG(7707);
    const pts = smoothPath(W.roads.find(r => r.id === 'high').pts, 26);
    for (let side = -1; side <= 1; side += 2) {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i-1], b = pts[i];
        const seg = Math.hypot(b[0]-a[0], b[1]-a[1]);
        const ang = Math.atan2(b[1]-a[1], b[0]-a[0]);
        acc += seg;
        if (acc < 34) continue;
        acc = 0;
        if (rng() < 0.12) continue;
        const wdt = 28 + rng() * 16, dep = 30 + rng() * 16;
        const st = 2 + ((rng() * 2) | 0);
        const nx = -Math.sin(ang) * side, ny = Math.cos(ang) * side;
        W.buildings.push({
          x: b[0] + nx * (22 + dep / 2), y: b[1] + ny * (22 + dep / 2),
          w: wdt, d: dep, rot: ang, storeys: st, h: st * 15,
          roof: rng() < 0.7 ? 'gable' : 'flat', roofH: 6 + rng() * 6,
          pal: HOUSE_KEYS[(rng() * HOUSE_KEYS.length) | 0],
          type:'shop', owner: null, chimney: rng() < 0.5,
          awning: rng() < 0.65, tone: rng(), lit: rng(), seedv: rng()
        });
      }
    }
  })();

  /* landmarks placed by hand */
  W.landmarks = [
    { kind:'church',    x:2404, y:1414, rot:-0.08 },
    { kind:'townhall',  x:2846, y:1424, rot: 0.04 },
    { kind:'mill',      x:1742, y:1236, rot: 0.10 },
    { kind:'silo',      x:3436, y:2884, rot: 0 },
    { kind:'silo',      x:3492, y:2898, rot: 0 },
    { kind:'barn',      x:3326, y:2856, rot: 0.06 },
    { kind:'barn',      x:2566, y:2896, rot:-0.05 },
    { kind:'watermill', x:1686, y:1802, rot: 0 },
    { kind:'pylon',     x:3488, y:1332, rot: 0 },
    { kind:'pylon',     x:3660, y:1258, rot: 0 },
    { kind:'pylon',     x:3330, y:1176, rot: 0 },
    { kind:'pylon',     x:3226, y:1000, rot: 0 },
    { kind:'pylon',     x:3402, y:1640, rot: 0 },
    { kind:'pylon',     x:3430, y:1930, rot: 0 }
  ];

  /* ───────────────────── vegetation ───────────────────── */

  const roadDistF = makeField(22, (x, y) => {
    let best = 1e9;
    for (const r of W.roads) { const d = distToPath(x, y, r.smooth); if (d < best) best = d; }
    return best;
  });
  W.roadDist = roadDistF;

  const builtF = makeField(26, (x, y) => {
    let best = 1e9;
    for (const b of W.buildings) {
      const d = Math.abs(x - b.x) + Math.abs(y - b.y);
      if (d < best) { best = d; if (best < 40) break; }
    }
    return best;
  });
  W.builtDist = builtF;

  const forestBlobs = [
    [560,1020,340],[820,760,260],[420,1420,320],[760,1560,300],[980,1180,240],
    [300,900,220],[640,1900,280],[1060,1600,220],[880,2200,260],[520,2380,300],
    [1180,900,200],[400,600,200],[1240,1360,190],[700,2700,280],[420,2820,240],
    [980,2560,220],[1300,1800,180],[1120,2060,190]
  ];
  W.canopyBlobs = forestBlobs;
  const riparian = [[1800,1000,110],[1720,1560,110],[1640,2400,120],[1560,2900,130],[1580,3200,120]];
  const parkBlobs = [[2712,1830,130],[2790,1880,80],[2650,1782,70]];

  W.trees = [];
  (function plantTrees() {
    const rng = makeRNG(90210);
    function scatter(blobs, count, group, rankBias, kinds, rMin, rMax) {
      for (let i = 0; i < count; i++) {
        const b = blobs[(rng() * blobs.length) | 0];
        const a = rng() * TAU, r = Math.sqrt(rng()) * b[2];
        const x = b[0] + Math.cos(a) * r, y = b[1] + Math.sin(a) * r;
        if (x < 40 || y < 40 || x > W.w - 40 || y > W.h - 40) continue;
        if (W.inLake(x, y) || riverDistF(x, y) < 30 || roadDistF(x, y) < 24) continue;
        if (builtF(x, y) < 60) continue;
        const el = W.elevF(x, y);
        if (el > 1.30) continue;
        const dens = fbm(x / 300, y / 300, 3) * 0.5 + 0.5;
        if (rng() > 0.22 + dens * 0.88) continue;
        W.trees.push({
          x, y, group, r: rMin + rng() * (rMax - rMin),
          h: 18 + rng() * 26 + (1 - el) * 5,
          kind: kinds[(rng() * kinds.length) | 0],
          rank: clamp01(rankBias + rng() * (1 - rankBias) * 1.05),
          sway: rng() * TAU, tone: rng()
        });
      }
    }
    scatter(forestBlobs, 4600, 'forest', 0.02, ['pine','pine','pine','round','poplar'], 13, 26);
    scatter(riparian,     260, 'forest', 0.0,  ['willow','round'], 13, 23);
    scatter(parkBlobs,    170, 'park',   0.0,  ['round','round','poplar'], 15, 26);

    const orng = makeRNG(4242);
    for (let r = 0; r < 11; r++) for (let c = 0; c < 13; c++) {
      if (orng() < 0.10) continue;
      W.trees.push({ x: 1868 + c * 30 + (r % 2) * 12 + (orng()-.5)*7,
                     y: 2582 + r * 38 + (orng()-.5)*7, group:'orchard',
                     r: 11 + orng()*4, h: 20 + orng()*8, kind:'apple',
                     rank: 0, sway: orng()*TAU, tone: orng() });
    }

    const hrng = makeRNG(717);
    for (let i = 0; i < 240; i++) {
      const x = 1900 + hrng() * 2300, y = 2440 + hrng() * 820;
      if (riverDistF(x, y) < 40 || roadDistF(x, y) < 26) continue;
      if (x > 3760 && y > 2600 && y < 2960) continue;
      W.trees.push({ x, y, group:'hedgerow', r: 9 + hrng()*7, h: 20 + hrng()*16,
                     kind: hrng() < 0.5 ? 'round' : 'poplar', rank: 0,
                     sway: hrng()*TAU, tone: hrng() });
    }
    W.trees.sort((a, b) => a.y - b.y);
  })();

  /* ───────────────────── farmland ───────────────────── */
  W.fields = [];
  (function layFields() {
    const rng = makeRNG(5150);
    for (let i = 0; i < 78; i++) {
      const cx = 1960 + rng() * 2180, cy = 2470 + rng() * 810;
      if (riverDistF(cx, cy) < 110) continue;
      if (cx > 3700 && cy > 2440 && cy < 3040) continue;
      W.fields.push({
        x: cx, y: cy, w: 150 + rng() * 210, d: 100 + rng() * 130,
        rot: (rng() - 0.5) * 0.30, crop: rng(), rows: 6 + ((rng() * 6) | 0),
        hedge: rng() < 0.8
      });
    }
  })();

  W.turbines = [
    { x:3320, y:800, h:118, s:1.00 }, { x:3480, y:700, h:128, s:1.10 },
    { x:3646, y:640, h:112, s:0.94 }, { x:3812, y:720, h:124, s:1.06 },
    { x:3946, y:850, h:106, s:0.90 }, { x:3560, y:880, h:116, s:1.02 }
  ];

  W.panels = [];
  (function layPanels() {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 15; c++) {
      W.panels.push({ x: 3838 + c * 26, y: 2686 + r * 24 + (c % 2) * 3 });
    }
  })();

  /* parked cars, bins and benches through the streets */
  (function streetFurniture() {
    const rng = makeRNG(8181);
    ['ring','high','artery','stationrd'].forEach(id => {
      const r = W.roads.find(x => x.id === id);
      const pts = r.smooth;
      for (let i = 3; i < pts.length - 2; i += 2) {
        if (rng() < 0.45) continue;
        const a = pts[i-1], b = pts[i];
        const ang = Math.atan2(b[1]-a[1], b[0]-a[0]);
        const side = rng() < 0.5 ? -1 : 1;
        W.props.push({ kind:'parked', x: b[0] - Math.sin(ang)*side*(r.w/2+7),
                       y: b[1] + Math.cos(ang)*side*(r.w/2+7), rot: ang, tone: rng() });
      }
    });
    for (let i = 0; i < 110; i++) {
      const b = W.buildings[(rng() * W.buildings.length) | 0];
      if (!b) continue;
      W.props.push({ kind: rng() < 0.5 ? 'bin' : 'bench',
                     x: b.x + (rng()-.5)*44, y: b.y + (rng()-.5)*44, rot: b.rot, tone: rng() });
    }
  })();

  W.buildings.sort((a, b) => a.y - b.y);
  W.props.sort((a, b) => a.y - b.y);

  // chimney stack positions, so the houses can smoke in cold weather
  W.chimneys = W.buildings.filter(b => b.chimney)
    .map(b => ({ x: b.x, y: b.y, z: b.h + (b.roofH || 0) + 9, owner: b.owner }));

  /** First index whose y >= v, in a y-sorted array. */
  W.lowerBound = function (arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].y < v) lo = m + 1; else hi = m; }
    return lo;
  };

  global.WORLD = W;
})(window);
