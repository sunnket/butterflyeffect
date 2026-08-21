/* ═══════════════════════════════════════════════════════════
   main.js — boot, input, camera and the frame loop.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { clamp, clamp01 } = NZ;
  const W = WORLD;
  const $ = s => document.querySelector(s);

  const HOURS_PER_SEC = 3;          // 1× speed → one sim-day every 8 real seconds
  const METRES_PER_UNIT = 1.6;

  const APP = {
    running: false, speed: 1, started: false,
    last: 0, hover: null, dragging: false, moved: false,
    dragStart: { x: 0, y: 0, cx: 0, cy: 0 },
    pinch: null,

    boot() {
      const cv = $('#stage');
      SIM.init();
      AGENTS.init();
      RENDER.init(cv);
      UI.build();
      UI.renderLog();
      this.bindInput(cv);
      this.last = performance.now();
      requestAnimationFrame(t => this.frame(t));

      $('#btnStart').onclick = () => {
        $('#intro').classList.add('gone');
        this.started = true; this.running = true;
        setTimeout(() => { RENDER.cam.tz = 0.62; RENDER.cam.tx = 1500; RENDER.cam.ty = 940; }, 120);
        setTimeout(() => $('#zoomHint').classList.add('gone'), 9000);
      };
      $('#btnPlay').onclick = () => this.setRunning(!this.running);
      $('#btnReset').onclick = () => this.reset();
      document.querySelectorAll('#speeds button').forEach(b => {
        b.onclick = () => {
          this.speed = +b.dataset.sp;
          document.querySelectorAll('#speeds button').forEach(x => x.classList.toggle('on', x === b));
        };
      });
    },

    setRunning(v) {
      this.running = v;
      $('#btnPlay').querySelector('.ico').textContent = v ? '⏸' : '▶';
    },

    reset() {
      SIM.init();
      AGENTS.init();
      UI.select(null);
      RENDER.hover = null;
      SIM.eventsDirty = true;
      this.setRunning(true);
    },

    /* ─────────────────────────── input ─────────────────────────── */
    bindInput(cv) {
      const self = this;

      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const c = RENDER.cam;
        const before = RENDER.s2w(e.clientX, e.clientY);
        const f = Math.exp(-e.deltaY * 0.0016);
        c.tz = clamp(c.tz * f, RENDER.minZ || 0.11, 3.2);
        c.tx = before.x - (e.clientX - RENDER.w / 2) / c.tz;
        c.ty = before.y - (e.clientY - RENDER.h / 2) / c.tz;
        self.clampCam();
        $('#zoomHint').classList.add('gone');
      }, { passive: false });

      cv.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        cv.setPointerCapture(e.pointerId);
        self.dragging = true; self.moved = false;
        self.dragStart = { x: e.clientX, y: e.clientY, cx: RENDER.cam.tx, cy: RENDER.cam.ty };
        cv.classList.add('grabbing');
      });

      window.addEventListener('pointermove', e => {
        UI.mouse.x = e.clientX; UI.mouse.y = e.clientY;
        if (self.dragging) {
          const dx = e.clientX - self.dragStart.x, dy = e.clientY - self.dragStart.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) self.moved = true;
          RENDER.cam.tx = self.dragStart.cx - dx / RENDER.cam.z;
          RENDER.cam.ty = self.dragStart.cy - dy / RENDER.cam.z;
          RENDER.cam.x = RENDER.cam.tx; RENDER.cam.y = RENDER.cam.ty;
          self.clampCam();
          self.hover = null;
          return;
        }
        if (!self.started) return;
        const wp = RENDER.s2w(e.clientX, e.clientY);
        const railOpen = !$('#rail').classList.contains('hidden');
        const inDock = e.clientY < 70
                    || (railOpen && e.clientX < 262)
                    || (e.clientX > window.innerWidth - 350 && !$('#inspector').classList.contains('closed'));
        self.hover = inDock ? null : RENDER.hitTest(wp.x, wp.y);
        RENDER.hover = self.hover;
        cv.classList.toggle('pointing', !!self.hover);
      });

      window.addEventListener('pointerup', e => {
        if (!self.dragging) return;
        self.dragging = false;
        cv.classList.remove('grabbing');
        if (!self.moved && self.started) {
          const wp = RENDER.s2w(e.clientX, e.clientY);
          const n = RENDER.hitTest(wp.x, wp.y);
          UI.select(n);
        }
      });

      cv.addEventListener('dblclick', e => {
        const wp = RENDER.s2w(e.clientX, e.clientY);
        const n = RENDER.hitTest(wp.x, wp.y);
        if (n) { SIM.toggle(n.id); UI.flashLog(); if (RENDER.selected && RENDER.selected.id === n.id) UI.buildInspector(n); }
      });

      /* touch pinch */
      cv.addEventListener('touchmove', e => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const a = e.touches[0], b = e.touches[1];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (self.pinch) {
          const c = RENDER.cam;
          c.tz = clamp(c.tz * (d / self.pinch), RENDER.minZ || 0.11, 3.2);
          self.clampCam();
        }
        self.pinch = d;
      }, { passive: false });
      cv.addEventListener('touchend', () => { self.pinch = null; });

      window.addEventListener('resize', () => RENDER.resize());

      window.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT') return;
        const k = e.key.toLowerCase();
        if (k === ' ') { e.preventDefault(); self.setRunning(!self.running); }
        else if (k === 'r') self.reset();
        else if (k === 'f') RENDER.fit();
        else if (k === 'escape') UI.select(null);
        else if (k === 'g') UI.toggleLayer('links');
        else if (k === 'w') UI.toggleLayer('wind');
        else if (k === 'h') UI.toggleLayer('heat');
        else if (k === 'a') UI.toggleLayer('haze');
        else if (k === 'p') UI.toggleLayer('people');
        else if (k === 'b') UI.toggleLayer('labels');
        else if (k === 'l') UI.toggleRail();
        else if (k === 'x') {
          const n = RENDER.selected || self.hover;
          if (n) { SIM.toggle(n.id); UI.flashLog(); if (RENDER.selected) UI.buildInspector(RENDER.selected); }
        }
        else if (k === '+' || k === '=') { RENDER.cam.tz = clamp(RENDER.cam.tz * 1.25, RENDER.minZ || 0.11, 3.2); }
        else if (k === '-' || k === '_') { RENDER.cam.tz = clamp(RENDER.cam.tz / 1.25, RENDER.minZ || 0.11, 3.2); self.clampCam(); }
        else if (k >= '1' && k <= '9') {
          const s = SCEN.LIST[+k - 1];
          if (s) { SCEN.apply(s.id); UI.flashLog(); }
        }
      });
    },

    clampCam() {
      // never let more than a thin frame of off-map space into view
      const c = RENDER.cam;
      const halfW = RENDER.w / (2 * c.tz), halfH = RENDER.h / (2 * c.tz);
      const slackX = Math.min(halfW * 0.16, 220), slackY = Math.min(halfH * 0.16, 220);
      const loX = Math.min(W.w / 2, halfW - slackX), hiX = Math.max(W.w / 2, W.w - halfW + slackX);
      const loY = Math.min(W.h / 2, halfH - slackY), hiY = Math.max(W.h / 2, W.h - halfH + slackY);
      c.tx = clamp(c.tx, loX, hiX);
      c.ty = clamp(c.ty, loY, hiY);
    },

    /* ─────────────────────────── loop ─────────────────────────── */
    frame(now) {
      requestAnimationFrame(t => this.frame(t));
      let dt = (now - this.last) / 1000;
      this.last = now;
      dt = clamp(dt, 0, 0.06);

      const S = SIM.state;
      if (this.running && this.started) {
        const dtH = dt * HOURS_PER_SEC * this.speed;
        // sub-step so fast-forward stays stable
        const n = this.speed > 4 ? 3 : this.speed > 2 ? 2 : 1;
        for (let i = 0; i < n; i++) SIM.step(dtH / n);
        AGENTS.update(dtH, S);
      } else {
        AGENTS.update(dt * 0.35, S);      // the world still breathes while paused
      }

      RENDER.frame(S, dt);

      UI.tipAge = (UI.tipAge || 0) + dt;
      UI.update(S, dt);
      UI.showTip(this.hover);

      // scale bar
      const metres = 90 / RENDER.cam.z * METRES_PER_UNIT;
      const label = metres > 1400 ? (metres / 1000).toFixed(1) + ' km' : Math.round(metres / 10) * 10 + ' m';
      const sl = $('#scaleLabel');
      if (sl && sl.textContent !== label) sl.textContent = label;
    }
  };

  window.addEventListener('DOMContentLoaded', () => APP.boot());
  global.APP = APP;
})(window);
