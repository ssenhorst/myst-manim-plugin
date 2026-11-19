/**
 * manim-web anywidget (browser side).
 *
 * MyST calls render({ model, el }) once per `manim` directive. This file is the
 * esbuild entry; the build (scripts/build.mjs) bundles it together with the
 * vendored manim-web into dist/manim-widget.bundle.mjs, which is what the
 * directive points MyST to. No CDN is contacted at page-view time.
 *
 * model keys (set by manim.mjs):
 *   code        {string}  author's scene code
 *   width       {number}  logical canvas width  (px); the canvas scales to the column
 *   height      {number}  logical canvas height (px)
 *   background  {string?} fixed background colour; default: page background
 *   sceneType   {string}  'Scene' or 'ThreeDScene'
 *   showPlayer  {boolean} restart / pause controls
 *   palette     {object}  semantic colour name -> default-theme hex
 *   mathjax     {string?} URL of the MathJax chunk (MyST resolves the `$asset` marker)
 *
 * State keys (the control interface; read with model.get / model.on('change:k'),
 * write with model.set). The widget writes the output keys; a controller (another
 * widget, a notebook, a scroll handler) writes the input keys.
 *   time      {number}  in/out  scene time in s; setting it seeks
 *   progress  {number}  in/out  time / duration in [0, 1]; setting it seeks
 *   playing   {boolean} in/out  play or pause (initial value: the `autoplay` option)
 *   speed     {number}  in      playback rate (default 1)
 *   loop      {boolean} in      restart at the end (default false)
 *   duration  {number?} out     total scene time, known after one full run (or a
 *                               seek past the end); null until then
 *   markers   {Array}   out     [{name, time}] from mark('name') calls in the scene
 *   done      {boolean} out     the scene code has finished at the current time
 * Output keys are written with model.set and then model.save_changes() inside a
 * try: MyST's model has no save_changes (it throws), Jupyter's needs it.
 */
import * as ManimWeb from './vendor/manim-web/manim-web.browser.js';
import { SceneDriver, buildScope, compileScene, themeFromCss } from './manim-core.mjs';

const SCOPE = buildScope(ManimWeb);

function showError(container, message) {
  container.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText =
    'color:#dc2626;padding:12px;font-size:13px;white-space:pre-wrap;margin:0;';
  pre.textContent = '[manim] ' + message;
  container.appendChild(pre);
}

function button(label, title) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.style.cssText =
    'background:none;border:1px solid currentColor;border-radius:4px;color:inherit;' +
    'font:inherit;cursor:pointer;padding:0 8px;line-height:1.6;opacity:.75;';
  return b;
}

export default {
  async render({ model, el }) {
    const code = model.get('code');
    const width = model.get('width') ?? 800;
    const height = model.get('height') ?? 450;
    const fixedBg = model.get('background') || null;
    const sceneType = model.get('sceneType') ?? 'Scene';
    const showPlayer = model.get('showPlayer') ?? false;
    const palette = model.get('palette') ?? {};
    const mathjax = model.get('mathjax');
    if (typeof mathjax === 'string' && !globalThis.__manimMathJaxUrl) {
      globalThis.__manimMathJaxUrl = new URL(mathjax, document.baseURI).href;
    }

    let run;
    try {
      run = compileScene(code, SCOPE);
    } catch (err) {
      showError(el, `syntax error in scene code: ${err.message}`);
      return;
    }

    // ── layout: responsive box with the scene's aspect ratio ──────────────────
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `width:100%;max-width:${width}px;margin:0 auto;`;
    const container = document.createElement('div');
    container.style.cssText = `width:100%;aspect-ratio:${width}/${height};overflow:hidden;`;
    wrapper.appendChild(container);
    el.appendChild(wrapper);

    // ── model I/O ────────────────────────────────────────────────────────────
    let disposed = false;
    let writing = false; // ignore change events caused by our own writes
    const write = (values) => {
      writing = true;
      try {
        for (const [k, v] of Object.entries(values)) {
          if (model.get(k) !== v) model.set(k, v);
        }
        try { model.save_changes(); } catch { /* MyST: nothing to sync */ }
      } finally {
        writing = false;
      }
    };
    const listen = (key, cb) => model.on(`change:${key}`, () => { if (!writing && !disposed) cb(model.get(key)); });

    let playing = model.get('playing') ?? true;
    let speed = model.get('speed') ?? 1;
    let loop = model.get('loop') ?? false;
    let duration = null;
    const markers = [];

    // ── player UI (optional) ─────────────────────────────────────────────────
    let ui = null;
    if (showPlayer) {
      const bar = document.createElement('div');
      bar.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13px;' +
        'color:var(--myst-color-text-secondary, #4b5563);';
      const restart = button('restart', 'Restart the animation');
      const play = button('pause', 'Play / pause');
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = 'any'; slider.value = '0';
      slider.style.cssText = 'flex:1;accent-color:currentColor;';
      slider.title = 'Scene time (exact once the scene has played to the end)';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:7em;text-align:right;font-variant-numeric:tabular-nums;';
      bar.append(restart, play, slider, label);
      wrapper.appendChild(bar);
      ui = { restart, play, slider, label, dragging: false };
    }

    // ── driver ───────────────────────────────────────────────────────────────
    const makeScene = () => {
      container.innerHTML = '';
      const theme = driver.theme;
      const SceneClass = ManimWeb[sceneType] ?? ManimWeb.Scene;
      const scene = new SceneClass(container, { width, height, backgroundColor: fixedBg ?? theme.bg });
      const canvas = container.querySelector('canvas');
      if (canvas) canvas.style.cssText += ';width:100%;height:100%;display:block;';
      return scene;
    };
    const driver = new SceneDriver({
      M: ManimWeb, makeScene, run, theme: themeFromCss(palette, el),
      onMark: (name, time) => {
        if (markers.some((m) => m.name === name)) return;
        markers.push({ name, time });
        write({ markers: markers.map((m) => ({ ...m })) });
      },
    });

    const fmt = (t) => (t == null ? '?' : t.toFixed(1));
    let lastPublish = 0;
    const publish = (force = false) => {
      const now = performance.now();
      if (!force && now - lastPublish < 100) return; // at most ~10 writes/s while playing
      lastPublish = now;
      const t = driver.time;
      write({
        time: t, playing, done: driver.done,
        progress: duration ? Math.min(1, t / duration) : 0,
        ...(duration != null ? { duration } : {}),
      });
      if (ui) {
        ui.play.textContent = playing ? 'pause' : 'play';
        if (!ui.dragging) {
          ui.slider.max = String(duration ?? Math.max(t, 1e-6));
          ui.slider.value = String(t);
        }
        ui.label.textContent = `${fmt(t)} / ${fmt(duration)} s`;
      }
    };

    const checkError = () => {
      if (driver.error) {
        console.error('[manim]', driver.error);
        showError(container, driver.error.message);
        playing = false;
        return true;
      }
      return false;
    };
    const noteEnd = () => {
      if (driver.done && duration == null && !driver.error) duration = driver.time;
    };

    // Seeks are queued: only the newest request is processed (fast scrolling).
    // A request is {time} or {progress}; progress needs the duration, which is
    // learned by running to the end once (without drawing) if still unknown.
    let pendingSeek = null;
    let seeking = false;
    const requestSeek = async (req) => {
      pendingSeek = req;
      if (seeking) return;
      seeking = true;
      try {
        while (pendingSeek != null && !disposed) {
          const r = pendingSeek;
          pendingSeek = null;
          let target;
          if (r.progress != null) {
            if (duration == null) {
              await driver.seek(Number.MAX_SAFE_INTEGER);
              noteEnd();
              if (pendingSeek != null) continue; // superseded meanwhile
            }
            target = Math.min(1, Math.max(0, +r.progress || 0)) * (duration ?? 0);
          } else {
            target = Math.max(0, +r.time || 0);
            if (duration != null) target = Math.min(target, duration);
          }
          await driver.seek(target);
          noteEnd();
        }
      } finally {
        seeking = false;
      }
      if (!checkError()) publish(true);
    };

    // One animation-frame loop per widget; steps the scene while playing.
    let last = null;
    let raf = null;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = last == null ? 0 : Math.min((now - last) / 1000, 0.1) * speed;
      last = now;
      if (!started || seeking) return;
      if (!playing || dt <= 0) {
        // Paused: still redraw when something changed after the last draw (text
        // and MathTex finish rendering asynchronously; the scene's own render
        // loop is off while the driver owns the clock).
        const sc = driver.scene;
        if (sc && sc._mobjects && [...sc._mobjects].some((m) => m._dirty)) sc.render();
        return;
      }
      const r = driver.advance(dt, true);
      if (r === 'done') {
        noteEnd();
        if (checkError()) return;
        if (loop) { requestSeek({ time: 0 }); } else { playing = false; publish(true); }
        return;
      }
      publish();
    };

    // ── inputs from the model ────────────────────────────────────────────────
    listen('time', (t) => requestSeek({ time: t }));
    listen('progress', (p) => requestSeek({ progress: p }));
    listen('playing', (v) => {
      playing = !!v;
      if (playing && driver.done) requestSeek({ time: 0 });
      publish(true);
    });
    listen('speed', (v) => { speed = +v > 0 ? +v : 1; });
    listen('loop', (v) => { loop = !!v; });

    // ── inputs from the player UI ────────────────────────────────────────────
    if (ui) {
      ui.restart.addEventListener('click', () => { playing = true; requestSeek({ time: 0 }); });
      ui.play.addEventListener('click', () => {
        playing = !playing;
        if (playing && driver.done) requestSeek({ time: 0 });
        publish(true);
      });
      ui.slider.addEventListener('input', () => {
        ui.dragging = true;
        ui.label.textContent = `${fmt(+ui.slider.value)} / ${fmt(duration)} s`;
      });
      ui.slider.addEventListener('change', () => { ui.dragging = false; requestSeek({ time: +ui.slider.value }); });
    }

    // ── start when visible; keep the time across a light/dark switch ─────────
    let started = false;
    const begin = () => {
      started = true;
      const t0 = +(model.get('time') ?? 0) || 0;
      driver.start();
      if (t0 > 0) requestSeek({ time: t0 }); else publish(true);
      raf = requestAnimationFrame(frame);
    };
    const visible = new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { obs.disconnect(); begin(); }
    }, { threshold: 0.1 });
    visible.observe(container);

    let lastDark = document.documentElement.classList.contains('dark');
    const themeWatch = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      if (dark === lastDark || !started) return;
      lastDark = dark;
      driver.theme = themeFromCss(palette, el);
      const t = driver.time;
      driver.start();
      requestSeek({ time: t });
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      disposed = true;
      visible.disconnect();
      themeWatch.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
      driver.dispose();
      wrapper.remove();
    };
  },
};
