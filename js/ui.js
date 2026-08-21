/* ═══════════════════════════════════════════════════════════
   ui.js — HUD, hover forecast card, inspector dossier, charts
   and the cause-and-effect log.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { clamp, clamp01, mix } = NZ;
  const W = WORLD;
  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h !== undefined) e.innerHTML = h; return e; };

  const AQI_BANDS = [
    [50,  '#54d98c', 'Good'], [100, '#c9d94a', 'Moderate'], [150, '#ffb545', 'Unhealthy (sensitive)'],
    [200, '#ff8a4a', 'Unhealthy'], [300, '#ff5f6d', 'Very unhealthy'], [999, '#a24aff', 'Hazardous']
  ];
  function aqiBand(v) { for (const b of AQI_BANDS) if (v <= b[0]) return b; return AQI_BANDS[5]; }

  const METRIC_DEFS = [
    { k:'power',  label:'Power',      c:'#ffb545', unit:'%',
      get:S => S.d.served * 100, bar:S => S.d.served,
      sub:S => S.d.supply.toFixed(1) + '/' + S.d.demand.toFixed(1) + ' MW', alarm:S => S.d.served < 0.9 },
    { k:'water',  label:'Water',      c:'#3fd0e8', unit:'%',
      get:S => S.d.waterCover * 100, bar:S => S.d.waterCover,
      sub:S => 'Q ' + S.waterQ.toFixed(0), alarm:S => S.d.waterCover < 0.6 },
    { k:'air',    label:'Air (AQI)',  c:'#8fb4ff', unit:'',
      get:S => S.aqi, bar:S => clamp01(1 - S.aqi / 300), col:S => aqiBand(S.aqi)[1],
      sub:S => aqiBand(S.aqi)[2], alarm:S => S.aqi > 150, dp:0 },
    { k:'health', label:'Health',     c:'#54d98c', unit:'',
      get:S => S.health, bar:S => S.health / 100, alarm:S => S.health < 45, dp:0 },
    { k:'econ',   label:'Economy',    c:'#ff6f91', unit:'',
      get:S => S.econ, bar:S => S.econ / 100, alarm:S => S.econ < 30, dp:0 },
    { k:'happy',  label:'Wellbeing',  c:'#a98bff', unit:'',
      get:S => S.happy, bar:S => S.happy / 100, alarm:S => S.happy < 45, dp:0 },
    { k:'pop',    label:'Population',  c:'#d9dde6', unit:'',
      get:S => S.pop, bar:S => clamp01(S.pop / (SIM.POP0 * 1.3)), fmt:v => Math.round(v).toLocaleString(),
      sub:S => S.temp.toFixed(0) + '°C · ' + (S.wind * 26).toFixed(0) + ' km/h' }
  ];

  const CHART_DEFS = [
    { k:'aqi',    name:'Air quality', c:'#8fb4ff', get:h => h.aqi, min:0, max:300, fmt:v => v.toFixed(0),
      sub:S => aqiBand(S.aqi)[2] },
    { k:'power',  name:'Grid',        c:'#ffb545', get:h => h.supply, get2:h => h.demand, min:0, max:50,
      fmt:v => v.toFixed(1) + ' MW', sub:S => 'demand ' + S.d.demand.toFixed(1) + ' MW' },
    { k:'res',    name:'Reservoir',   c:'#3fd0e8', get:h => h.res * 100, min:0, max:100, fmt:v => v.toFixed(0) + '%',
      sub:S => (S.reservoir * SIM.RES_CAP).toFixed(0) + ' ML' },
    { k:'canopy', name:'Canopy',      c:'#54d98c', get:h => h.canopy * 100, get2:h => h.yield * 100, min:0, max:100,
      fmt:v => v.toFixed(0) + '%', sub:S => 'harvest ' + (S.yield * 100).toFixed(0) + '%' },
    { k:'happy',  name:'Wellbeing',   c:'#a98bff', get:h => h.happy, get2:h => h.health, min:0, max:100,
      fmt:v => v.toFixed(0), sub:S => 'health ' + S.health.toFixed(0) }
  ];

  const UI = {
    tipEl: null, chartCanvases: {}, metricEls: {}, lastLogLen: -1, chartTick: 0,

    /* ─────────────────────────── build ─────────────────────────── */
    build() {
      this.tipEl = $('#tip');

      // metrics
      const mw = $('#metrics');
      METRIC_DEFS.forEach(m => {
        const e = el('div', 'metric');
        e.style.setProperty('--c', m.c);
        e.innerHTML = '<div class="mlabel"><span class="mdot"></span>' + m.label + '</div>'
                    + '<div class="mval"><span class="v">–</span><span class="munit">' + (m.unit || '') + '</span></div>'
                    + '<div class="mtrend"></div><div class="mbar"></div>';
        mw.appendChild(e);
        this.metricEls[m.k] = { root: e, v: e.querySelector('.v'), trend: e.querySelector('.mtrend'),
                                bar: e.querySelector('.mbar'), dot: e.querySelector('.mdot') };
      });

      // scenarios
      const sl = $('#scenarioList');
      SCEN.LIST.forEach(s => {
        const b = el('button', 'scen');
        b.dataset.id = s.id;
        b.innerHTML = '<span class="sico">' + s.icon + '</span><span><span class="sname">' + s.name
                    + '</span><span class="sdesc">' + s.desc + '</span></span>';
        b.onclick = () => { SCEN.apply(s.id); this.flashLog(); };
        sl.appendChild(b);
      });
      $('#btnCalm').onclick = () => { SCEN.calm(); this.flashLog(); };

      // layers
      const LAYERS = [
        { k:'links',  n:'Dependency graph', key:'G' },
        { k:'wind',   n:'Wind field',       key:'W' },
        { k:'heat',   n:'Heat island',      key:'H' },
        { k:'haze',   n:'Air-quality haze', key:'A' },
        { k:'people', n:'Townsfolk',        key:'P' },
        { k:'labels', n:'Labels',           key:'B' }
      ];
      const ll = $('#layerList');
      LAYERS.forEach(L => {
        const b = el('button', 'lay' + (RENDER.layers[L.k] ? ' on' : ''));
        b.dataset.k = L.k;
        b.innerHTML = '<span class="sw"></span><span class="lname">' + L.n + '</span><kbd>' + L.key + '</kbd>';
        b.onclick = () => this.toggleLayer(L.k);
        ll.appendChild(b);
      });

      // legend
      const CATS = [['power','Energy'],['water','Water'],['nature','Living systems'],
                    ['econ','Economy'],['civic','Civic']];
      const lg = $('#legendList');
      CATS.forEach(([k, n]) => {
        const count = W.nodes.filter(x => x.cat === k).length;
        const li = el('li');
        li.innerHTML = '<span class="ldot" style="background:' + RENDER.CAT_COLOR[k] + ';color:'
                     + RENDER.CAT_COLOR[k] + '"></span>' + n + '<span class="lct">' + count + '</span>';
        lg.appendChild(li);
      });

      // charts
      const cw = $('#charts');
      CHART_DEFS.forEach(c => {
        const d = el('div', 'chart');
        d.style.setProperty('--c', c.c);
        d.innerHTML = '<div class="chead"><span class="cname">' + c.name + '</span><span class="cval">–</span></div>'
                    + '<div class="csub">–</div><canvas></canvas>';
        cw.appendChild(d);
        this.chartCanvases[c.k] = { cv: d.querySelector('canvas'), val: d.querySelector('.cval'),
                                    sub: d.querySelector('.csub'), def: c };
      });

      $('#btnCloseInspect').onclick = () => this.select(null);
    },

    toggleLayer(k) {
      RENDER.layers[k] = !RENDER.layers[k];
      const b = document.querySelector('.lay[data-k="' + k + '"]');
      if (b) b.classList.toggle('on', RENDER.layers[k]);
    },

    /* ─────────────────────────── per-frame ─────────────────────────── */
    update(S, dtReal) {
      // clock
      $('#clockTime').textContent = SIM.fmtClock(S.hours);
      $('#clockDay').textContent = 'Day ' + (Math.floor(S.hours / 24) + 1) + ' · ' + S.d.season;
      this.sundial(S);

      // weather chip
      const rainMM = S.rain * 24;
      const wIcon = S.fire > 0.05 ? '🔥' : rainMM > 8 ? '🌧' : rainMM > 1.5 ? '🌦'
                  : S.wind > 0.7 ? '💨' : S.cloud > 0.62 ? '☁️' : S.d.isNight ? '🌙' : S.cloud > 0.3 ? '⛅' : '☀️';
      $('#wIcon').textContent = wIcon;
      $('#wLabel').textContent = rainMM > 8 ? 'Heavy rain' : rainMM > 1.5 ? 'Showers'
                  : S.wind > 0.86 ? 'Gale' : S.wind > 0.62 ? 'Windy' : S.cloud > 0.62 ? 'Overcast'
                  : S.cloud > 0.3 ? 'Partly cloudy' : 'Clear';
      $('#wSub').textContent = (S.wind * 26).toFixed(0) + ' km/h · ' + S.temp.toFixed(0) + '°C · '
                  + rainMM.toFixed(1) + ' mm/h';

      // metrics
      const H = SIM.history, back = H.length > 24 ? H[H.length - 24] : null;
      METRIC_DEFS.forEach(m => {
        const e = this.metricEls[m.k];
        const v = m.get(S);
        e.v.textContent = m.fmt ? m.fmt(v) : v.toFixed(m.dp === undefined ? 0 : m.dp);
        const col = m.col ? m.col(S) : m.c;
        e.root.style.setProperty('--c', col);
        e.bar.style.width = (clamp01(m.bar(S)) * 100) + '%';
        e.root.classList.toggle('alarm', !!(m.alarm && m.alarm(S)));
        if (back) {
          const prev = m.k === 'pop' ? back.pop : m.k === 'air' ? back.aqi : m.k === 'power' ? back.served * 100
                     : m.k === 'water' ? null : m.k === 'health' ? back.health : m.k === 'econ' ? back.econ
                     : m.k === 'happy' ? back.happy : null;
          if (prev !== null && prev !== undefined) {
            const d = v - prev;
            const rising = d > (Math.abs(v) * 0.004 + 0.15);
            const falling = d < -(Math.abs(v) * 0.004 + 0.15);
            const goodUp = m.k !== 'air';
            e.trend.textContent = rising ? '▲' : falling ? '▼' : '·';
            e.trend.style.color = (rising === goodUp && (rising || falling)) ? '#54d98c'
                               : (rising || falling) ? '#ff5f6d' : '#5f6f8a';
          }
        }
      });

      // charts, ~12 fps
      this.chartTick -= dtReal;
      if (this.chartTick <= 0) { this.chartTick = 0.08; this.drawCharts(S); }

      if (SIM.eventsDirty) { this.renderLog(); SIM.eventsDirty = false; }

      // scenario highlight
      document.querySelectorAll('.scen').forEach(b => b.classList.toggle('live', b.dataset.id === S.scen));

      if (RENDER.selected) this.refreshInspector(S);
      this.positionTip();
    },

    sundial(S) {
      const cv = $('#sundial'); if (!cv) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cv.width !== 76 * dpr) { cv.width = 76 * dpr; cv.height = 76 * dpr; }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, 76, 76);
      const cx = 38, cy = 38, r = 27;
      // dial
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 3;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      // daylight arc
      c.strokeStyle = 'rgba(255,181,69,.35)';
      c.beginPath(); c.arc(cx, cy, r, Math.PI, Math.PI * 2); c.stroke();
      const ang = (S.d.hod / 24) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
      const night = S.d.isNight;
      c.fillStyle = night ? '#c9d4ef' : '#ffcf6a';
      c.shadowBlur = 10; c.shadowColor = night ? '#8fa8e0' : '#ffb545';
      c.beginPath(); c.arc(px, py, night ? 4 : 5.5, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      // reservoir ring inside
      c.strokeStyle = 'rgba(63,208,232,.7)'; c.lineWidth = 2.5;
      c.beginPath(); c.arc(cx, cy, r - 6, -Math.PI / 2, -Math.PI / 2 + S.reservoir * Math.PI * 2); c.stroke();
    },

    /* ─────────────────────────── charts ─────────────────────────── */
    drawCharts(S) {
      const H = SIM.history;
      if (H.length < 2) return;
      const N = Math.min(H.length, 320);
      const slice = H.slice(H.length - N);
      Object.keys(this.chartCanvases).forEach(k => {
        const o = this.chartCanvases[k], def = o.def, cv = o.cv;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (!w || !h) return;
        if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        const c = cv.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, w, h);

        const X = i => (i / (N - 1)) * w;
        const Y = v => h - ((v - def.min) / (def.max - def.min)) * (h - 4) - 2;

        // gridlines
        c.strokeStyle = 'rgba(255,255,255,.055)'; c.lineWidth = 1;
        for (let g = 1; g < 4; g++) {
          const y = (h / 4) * g;
          c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
        }

        // secondary series
        if (def.get2) {
          c.strokeStyle = 'rgba(255,255,255,.30)'; c.lineWidth = 1.1;
          c.setLineDash([3, 3]);
          c.beginPath();
          slice.forEach((s, i) => { const y = Y(def.get2(s)); i ? c.lineTo(X(i), y) : c.moveTo(X(i), y); });
          c.stroke(); c.setLineDash([]);
        }

        // area + line
        const grd = c.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, def.c + '55'); grd.addColorStop(1, def.c + '00');
        c.beginPath();
        slice.forEach((s, i) => { const y = Y(def.get(s)); i ? c.lineTo(X(i), y) : c.moveTo(X(i), y); });
        const last = Y(def.get(slice[slice.length - 1]));
        c.lineTo(w, h); c.lineTo(0, h); c.closePath();
        c.fillStyle = grd; c.fill();

        c.beginPath();
        slice.forEach((s, i) => { const y = Y(def.get(s)); i ? c.lineTo(X(i), y) : c.moveTo(X(i), y); });
        c.strokeStyle = def.c; c.lineWidth = 1.7; c.lineJoin = 'round'; c.stroke();

        c.fillStyle = def.c;
        c.beginPath(); c.arc(w - 1.5, last, 2.4, 0, Math.PI * 2); c.fill();

        o.val.textContent = def.fmt(def.get(slice[slice.length - 1]));
        o.sub.textContent = def.sub ? def.sub(S) : '';
      });
    },

    /* ─────────────────────────── event log ─────────────────────────── */
    renderLog() {
      const ul = $('#eventLog');
      ul.innerHTML = '';
      SIM.events.slice(0, 40).forEach(e => {
        const li = el('li', 'sev-' + e.sev);
        li.style.setProperty('--c', RENDER.CAT_COLOR[e.cat] || '#5f6f8a');
        li.innerHTML = '<span class="ltime">D' + e.day + ' ' + e.stamp + '</span><span class="ltxt">' + e.text + '</span>';
        ul.appendChild(li);
      });
      $('#logCount').textContent = SIM.events.length + ' event' + (SIM.events.length === 1 ? '' : 's');
    },
    flashLog() { SIM.eventsDirty = true; },

    /* ─────────────────────────── tooltip ─────────────────────────── */
    mouse: { x: 0, y: 0 },
    showTip(node) {
      if (!node) { this.tipEl.classList.add('hidden'); this.tipNode = null; return; }
      if (this.tipNode === node.id && this.tipAge < 0.4) { this.tipEl.classList.remove('hidden'); return; }
      this.tipNode = node.id; this.tipAge = 0;
      this.tipEl.innerHTML = this.tipHTML(node);
      this.tipEl.style.setProperty('--c', RENDER.CAT_COLOR[node.cat]);
      this.tipEl.classList.remove('hidden');
    },
    tipHTML(node) {
      const S = SIM.state;
      const on = S.on[node.id];
      const status = SIM.nodeStatus(node.id);
      const stats = SIM.nodeStats(node.id).slice(0, 6);
      const wi = SIM.whatIf(node.id);

      let h = '<div class="tiphead"><div class="tipkick">' + node.cat + ' · ' + (status === 'strain' ? 'under strain' : status) + '</div>'
            + '<div class="tiptitle"><span class="tico">' + node.icon + '</span><strong>' + node.name + '</strong>'
            + '<span class="tstate ' + (on ? 'on' : 'off') + '">' + (on ? 'LIVE' : 'OFF') + '</span></div></div>';

      h += '<div class="tipstats">';
      stats.forEach(s => { h += '<div class="tipstat"><span class="k">' + s.k + '</span><span class="v">' + s.v + '</span></div>'; });
      h += '</div>';

      const rev = !on;
      h += '<div class="tipwhat' + (rev ? ' rev' : '') + '"><h6>' + (rev ? '▲ if switched back on' : '▼ if switched off')
         + ' · 34h forecast</h6><div class="tipdeltas">';
      const ds = wi.deltas.slice(0, 5);
      if (!ds.length) h += '<span class="tdelta" style="opacity:.75;white-space:normal;line-height:1.5;font-weight:500">'
                        + wi.note + '</span>';
      ds.forEach(d => {
        const good = (d.d * d.good) > 0;
        h += '<span class="tdelta" style="color:' + (good ? '#8fe8b3' : '#ff9aa4') + '">'
           + '<span class="tdk">' + d.label + (d.transient ? ' at worst' : '') + '</span>'
           + fmtDelta(d) + '</span>';
      });
      h += '</div>';
      const chain = wi.chain.slice(1, 4);
      if (chain.length) {
        h += '<div class="tipchain">' + (rev ? 'Recovery path: ' : 'Travels: ') + '<b>' + W.byId[wi.chain[0]].short + '</b>'
           + chain.map(id => ' → <b>' + W.byId[id].short + '</b>').join('') + '</div>';
      }
      h += '</div>';
      h += '<div class="tipfoot"><span>click for the full dossier</span><span>' + (on ? 'X to switch off' : 'X to restore') + '</span></div>';
      return h;
    },
    positionTip() {
      if (this.tipEl.classList.contains('hidden')) return;
      const m = this.mouse;
      const r = this.tipEl.getBoundingClientRect();
      let x = m.x + 20, y = m.y + 18;
      if (x + r.width > window.innerWidth - 12) x = m.x - r.width - 20;
      if (y + r.height > window.innerHeight - 12) y = window.innerHeight - r.height - 12;
      if (y < 74) y = 74;
      this.tipEl.style.left = x + 'px';
      this.tipEl.style.top = y + 'px';
    },

    /* ─────────────────────────── inspector ─────────────────────────── */
    select(node) {
      RENDER.selected = node;
      const insp = $('#inspector');
      if (!node) { insp.classList.add('closed'); return; }
      insp.classList.remove('closed');
      this.buildInspector(node);
    },

    buildInspector(node) {
      const S = SIM.state;
      const body = $('#inspectBody');
      const col = RENDER.CAT_COLOR[node.cat];
      const on = S.on[node.id];
      const status = SIM.nodeStatus(node.id);
      const wi = SIM.whatIf(node.id);

      let h = '';
      h += '<div class="insp-hero" style="--c:' + col + '">'
         + '<div class="insp-kicker">' + node.cat + ' system</div>'
         + '<div class="insp-title"><span class="iico">' + node.icon + '</span><h3>' + node.name + '</h3></div>'
         + '<div class="insp-blurb">' + node.blurb + '</div>'
         + '<div class="statusrow"><span class="pill ' + (status === 'strain' ? 'strain' : on ? 'on' : 'off') + '">'
         + (status === 'strain' ? 'under strain' : on ? 'operating' : 'offline') + '</span>'
         + '<button class="togglebtn ' + (on ? 'kill' : 'rev') + '" id="ibtnToggle">'
         + (on ? 'Switch off' : 'Bring online') + '</button></div></div>';

      h += '<div class="insp-sec"><h4>Live readings</h4><div class="readouts" id="iReadouts"></div></div>';

      h += '<div class="insp-sec"><h4>' + (on ? 'Consequence forecast — 34 hours after switching off'
                                              : 'Recovery forecast — 34 hours after restoring') + '</h4>'
         + '<div class="impact' + (on ? '' : ' rev') + '" id="iImpact"></div></div>';

      const ins = (W.inEdges[node.id] || []);
      const outs = (W.outEdges[node.id] || []);
      if (ins.length) {
        h += '<div class="insp-sec"><h4>Depends on</h4><div class="deps">'
           + ins.map(e => depRow(e.f, '←', e.l, e.s)).join('') + '</div></div>';
      }
      if (outs.length) {
        h += '<div class="insp-sec"><h4>Feeds into</h4><div class="deps">'
           + outs.map(e => depRow(e.t, '→', e.l, e.s)).join('') + '</div></div>';
      }
      h += '<div class="insp-sec"><h4>Valley trace</h4><div class="sparkbox"><canvas id="iSpark"></canvas></div></div>';

      body.innerHTML = h;
      $('#ibtnToggle').onclick = () => { SIM.toggle(node.id); this.buildInspector(node); this.flashLog(); };
      body.querySelectorAll('.dep').forEach(d => {
        d.onclick = () => { const n = W.byId[d.dataset.id]; if (n) { this.select(n); RENDER.cam.tx = n.x; RENDER.cam.ty = n.y; } };
      });
      this.refreshInspector(S, true);
    },

    refreshInspector(S, force) {
      const node = RENDER.selected;
      if (!node) return;
      this._ri = (this._ri || 0) - 1;
      if (!force && this._ri > 0) return;
      this._ri = 8;

      const rd = document.getElementById('iReadouts');
      if (rd) {
        const stats = SIM.nodeStats(node.id);
        const col = RENDER.CAT_COLOR[node.cat];
        rd.innerHTML = stats.map(s =>
          '<div class="ro" style="--c:' + col + '"><div class="rk">' + s.k + '</div><div class="rv">' + s.v + '</div></div>'
        ).join('');
      }

      const im = document.getElementById('iImpact');
      if (im) {
        const wi = SIM.whatIf(node.id);
        let h = '<h5>' + (S.on[node.id] ? '⚠ projected damage' : '✔ projected recovery') + '</h5><div class="deltas">';
        if (!wi.deltas.length) h += '<div style="font-size:11px;line-height:1.6;color:var(--txt-2)">' + wi.note + '</div>';
        wi.deltas.slice(0, 7).forEach(d => {
          const good = (d.d * d.good) > 0;
          const norm = clamp01(Math.abs(d.d) / (d.k === 'aqi' ? 120 : d.k === 'temp' ? 8 : 45));
          const c = good ? '#54d98c' : '#ff5f6d';
          h += '<div class="delta"><span class="dk">' + d.label
             + (d.transient ? ' <em style="font-style:normal;color:var(--txt-3)">at worst</em>' : '') + '</span>'
             + '<span class="dbar"><i style="background:' + c + ';'
             + (d.d < 0 ? ('right:50%;left:auto;width:' + (norm * 50) + '%')
                        : ('left:50%;width:' + (norm * 50) + '%')) + '"></i></span>'
             + '<span class="dv" style="color:' + c + '">' + fmtDelta(d) + '</span></div>';
        });
        h += '</div>';
        const ch = wi.chain;
        if (ch.length > 1) {
          h += '<div class="chain">' + ch.map((id, i) => (i ? '<span class="arw">→</span>' : '')
             + '<b>' + W.byId[id].short + '</b>').join('') + '</div>';
        }
        im.innerHTML = h;
      }

      const spark = document.getElementById('iSpark');
      if (spark) this.drawSpark(spark, node);
    },

    drawSpark(cv, node) {
      const H = SIM.history;
      if (H.length < 3) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cv.clientWidth || 296, h = 52;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      const pick = { power:'served', water:'waterQ', nature:'canopy', econ:'econ', civic:'happy' }[node.cat];
      const scale = { served: 100, canopy: 100 };
      const N = Math.min(H.length, 260);
      const s = H.slice(H.length - N);
      const vals = s.map(x => (x[pick] || 0) * (scale[pick] || 1));
      const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      const span = Math.max(max - min, 4);
      const col = RENDER.CAT_COLOR[node.cat];
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, col + '4d'); g.addColorStop(1, col + '00');
      c.beginPath();
      vals.forEach((v, i) => {
        const x = (i / (N - 1)) * w, y = h - 4 - ((v - min) / span) * (h - 12);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fillStyle = g; c.fill();
      c.beginPath();
      vals.forEach((v, i) => {
        const x = (i / (N - 1)) * w, y = h - 4 - ((v - min) / span) * (h - 12);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
      c.fillStyle = 'rgba(147,162,187,.85)';
      c.font = '600 9px ui-monospace, monospace';
      c.fillText({ power:'grid served %', water:'water quality', nature:'canopy %', econ:'economy', civic:'wellbeing' }[node.cat], 4, 11);
    }
  };

  function depRow(id, arrow, label, sign) {
    const n = W.byId[id];
    const off = !SIM.state.on[id];
    return '<div class="dep' + (off ? ' dead' : '') + '" data-id="' + id + '">'
         + '<span class="arrow">' + arrow + '</span>'
         + '<span style="font-size:13px">' + n.icon + '</span>'
         + '<span class="dname" style="color:' + RENDER.CAT_COLOR[n.cat] + '">' + n.short + '</span>'
         + '<span class="dlabel">' + (sign < 0 ? '⊖ ' : '') + label + '</span></div>';
  }

  function fmtDelta(d) {
    const v = d.d;
    const sign = v > 0 ? '+' : '−';
    const abs = Math.abs(v);
    const dp = d.unit === '°C' ? 1 : abs < 10 ? 1 : 0;
    return sign + abs.toFixed(dp) + (d.unit === '%' ? ' pp' : d.unit);
  }

  UI.aqiBand = aqiBand;
  global.UI = UI;
})(window);
