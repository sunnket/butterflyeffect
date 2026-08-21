/* ═══════════════════════════════════════════════════════════
   scenarios.js — perturbations you can drop on the valley.
   A scenario only ever touches *initial conditions and forcings*
   (rain, wind, temperature, demand, emissions). Everything that
   follows is the model's own doing — which is the whole point.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const BASE_MOD = { rain: 1, wind: 1, temp: 0, demand: 1, emit: 1, ignite: 0 };

  const LIST = [
    { id:'monsoon', name:'Monsoon Front', icon:'🌧', hours:34,
      desc:'A wet wall rolls up the valley',
      mod:{ rain:2.7, wind:1.35, temp:-3 },
      enter:'A monsoon front has arrived. The catchment is filling fast — watch the crest gauge.',
      leave:'The front has passed east. Skies clearing over Hollow Ridge.' },

    { id:'drought', name:'Long Drought', icon:'🏜', hours:210,
      desc:'Weeks with no rain at all',
      mod:{ rain:0.04, temp:5.5, wind:0.75 },
      enter:'Rain has failed. Reservoir drawdown begins; the soil will go first, then the harvest.',
      leave:'The drought has broken. Soil recovery will lag the rain by days.' },

    { id:'heatwave', name:'Heatwave', icon:'🔥', hours:60,
      desc:'+11°C — cooling demand spikes',
      mod:{ temp:11, rain:0.25, wind:0.55 },
      enter:'Heatwave. Every air conditioner in the Hollow just became a load on the grid.',
      leave:'Temperatures back to seasonal. Peak demand easing.' },

    { id:'gale', name:'Ridge Gale', icon:'🌪', hours:22,
      desc:'Wind so strong the turbines stop',
      mod:{ wind:2.1, rain:1.5, temp:-4 },
      enter:'Gale warning on the ridge. Above cut-out speed the turbines feather — wind power goes to zero.',
      leave:'Wind back within operating band. Turbines spinning up.' },

    { id:'calmweek', name:'Windless Week', icon:'🍃', hours:96,
      desc:'Dead air — no wind, no dispersal',
      mod:{ wind:0.10, rain:0.35 },
      enter:'A stagnant high has parked over the valley. No wind means no turbines and no dispersion.',
      leave:'The air is moving again. Pollutants should flush out within a day.' },

    { id:'boom', name:'Industrial Boom', icon:'📈', hours:110,
      desc:'Works runs hot: +35% load, +50% emissions',
      mod:{ demand:1.35, emit:1.55 },
      enter:'Ironleaf Works has taken a large order. Three shifts, more power, more smoke.',
      leave:'The order is filled. The works falls back to a single shift.' },

    { id:'surge', name:'Population Surge', icon:'👥', hours:0, instant:true,
      desc:'2,400 new arrivals overnight',
      enter:'Two thousand four hundred people have arrived. Same pipes, same wires, same fields.',
      run(S) { S.pop = Math.min(S.pop + 2400, SIM.POP0 * 1.5); } },

    { id:'blackout', name:'Substation Fault', icon:'⚫', hours:9,
      desc:'The grid drops for nine hours',
      enter:'A busbar fault has taken the central substation offline. Everything electric stops now.',
      leave:'Substation re-energised. Systems restarting in priority order.',
      run(S) { S.on.grid = false; },
      undo(S) { S.on.grid = true; SIM.bumpCache(); } },

    { id:'planting', name:'The Great Planting', icon:'🌱', hours:0, instant:true,
      desc:'40,000 saplings on the western slopes',
      enter:'Forty thousand saplings go in across the western slopes. The effects arrive slowly, then all at once.',
      run(S) { S.on.forest = true; S.on.park = true; S.canopy = Math.max(S.canopy, 0.98); S.soil = Math.min(1, S.soil + 0.12); SIM.bumpCache(); } },

    { id:'felling', name:'Clear the Slopes', icon:'🪓', hours:0, instant:true,
      desc:'Log the forest for timber revenue',
      enter:'The felling licences are signed. Short-term timber revenue, long-term everything else.',
      run(S) { S.on.forest = false; S.canopy = Math.min(S.canopy, 0.30); SIM.bumpCache(); } }
  ];

  const byId = {};
  LIST.forEach(s => { byId[s.id] = s; });

  function apply(id) {
    const S = SIM.state;
    const s = byId[id];
    if (!s) return;

    // a running timed scenario is replaced, not stacked
    if (S.scen && S.scen !== id) expire(S, true);

    if (s.run) s.run(S);
    if (s.mod) Object.keys(s.mod).forEach(k => { S.mod[k] = s.mod[k]; });
    if (!s.instant) { S.scen = id; S.scenLeft = s.hours; }
    SIM.bumpCache();
    SIM_LOG(S, '<b>' + s.name + '</b> — ' + s.enter, s.id === 'planting' ? 'good' : 'bad', 'civic');
    return s;
  }

  function expire(S, quiet) {
    const s = byId[S.scen];
    S.scen = null; S.scenLeft = 0;
    Object.assign(S.mod, BASE_MOD);
    if (s) {
      if (s.undo) s.undo(S);
      if (!quiet && s.leave) SIM_LOG(S, '<b>' + s.name + ' over.</b> ' + s.leave, 'good', 'civic');
    }
    SIM.bumpCache();
  }

  function calm() {
    const S = SIM.state;
    if (S.scen) expire(S, true);
    Object.assign(S.mod, BASE_MOD);
    S.on.grid = true;
    SIM.bumpCache();
    SIM_LOG(S, 'Forcings reset — the valley returns to its ordinary weather.', 'good', 'civic');
  }

  global.SCEN = { LIST, byId, apply, expire, calm, BASE_MOD };
})(window);
