/**
 * Shared core for the manim directive: builds the theme, the scope for the
 * author's scene code, and runs that code on a manim-web Scene.
 *
 * Used by two callers:
 *   - manim-widget.mjs   (live scene in the MyST HTML page)
 *   - render/render-page.mjs (headless render to SVG / PNG / video)
 * so a scene behaves the same in both.
 */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['scene', 'THEME', 'mark', 'default']);

/**
 * Every named export of manim-web that is a valid identifier, so the author's
 * code can use `Circle`, `Create`, `UP`, ... without imports.
 */
export function buildScope(ManimWeb) {
  const scope = {};
  for (const [name, value] of Object.entries(ManimWeb)) {
    if (IDENT.test(name) && !RESERVED.has(name)) scope[name] = value;
  }
  return scope;
}

/**
 * Theme object handed to the scene as `THEME`.
 *
 * `palette` maps semantic colour names (primary, secondary, ink, ...) to hex.
 * It is the thesis' *default* theme (101_style/src/theme_default.yaml): the
 * figure-styling pipeline recolours exactly these hex values to the current
 * theme, so a static export must be drawn in them.
 *
 * `overrides` replaces palette entries (live page: values of the CSS custom
 * properties `--<name>`; video render: the web palette).
 * `bg` / `fg` are the page background and the neutral foreground (axes, text,
 * outlines). Use THEME.fg instead of black so dark mode works.
 */
export function makeTheme(palette = {}, overrides = {}, bg = '#ffffff', fg = '#000000', mode = 'light') {
  const theme = { ...palette, ...overrides };
  theme.bg = bg;
  theme.fg = fg;
  theme.mode = mode;
  return theme;
}

/** Read `--<name>` custom properties from the page, falling back to the palette. */
export function themeFromCss(palette, el) {
  const root = document.documentElement;
  const cs = getComputedStyle(el && el.isConnected ? el : root);
  const read = (v) => cs.getPropertyValue(v).trim();
  const overrides = {};
  for (const name of Object.keys(palette)) {
    const v = read(`--${name}`);
    if (v) overrides[name] = v;
  }
  const dark = root.classList.contains('dark');
  const bg = read('--myst-color-bg') || (dark ? '#1c1917' : '#ffffff');
  const fg = read('--myst-color-text') || (dark ? '#ffffff' : '#000000');
  return makeTheme(palette, overrides, bg, fg, dark ? 'dark' : 'light');
}

/**
 * Compile the author's code once into an async function of (scene, THEME, mark, ...scope).
 * `mark(name)` records a named point in scene time (see SceneDriver).
 */
export function compileScene(code, scope) {
  const names = Object.keys(scope);
  const fn = new Function(
    'scene', 'THEME', 'mark', ...names,
    `"use strict"; return (async () => {\n${code}\n})();`,
  );
  return (scene, theme, mark = () => {}) => fn(scene, theme, mark, ...names.map((n) => scope[n]));
}

/**
 * Drives one manim-web scene on a clock of its own, so it can be paused, played
 * at any speed and seeked to any time, without touching page-wide timers.
 *
 * The author's code is an async script of `await scene.play(...)` calls; manim-web
 * only has a timeline for the animation that is playing now. To get one clock for
 * the whole script, the driver
 *   - switches off the scene's own render loop and steps it with scene._tickFrame(dt),
 *   - turns scene.wait(t) into a Wait animation (manim-web's wait() uses real-time
 *     timers), so all scene time runs through animations,
 *   - holds the clock while the scene waits on real-world work (fonts, MathJax:
 *     play() first awaits waitForRender() of every mobject).
 * Scene time is the sum of the steps taken while an animation plays. Seeking
 * forward steps quickly without drawing; seeking back restarts and fast-forwards.
 * This relies on manim-web 0.42 internals (_tickFrame, _runAnimations, _isPlaying,
 * _startRenderLoop): check them when updating manim-web.
 */
export class SceneDriver {
  /**
   * @param {object} o
   * @param {object} o.M          manim-web module namespace
   * @param {Function} o.makeScene () => new Scene(...) in its container
   * @param {Function} o.run      compiled scene code (compileScene)
   * @param {object} o.theme      THEME for the code
   * @param {Function} [o.onMark] (name, time) when the code calls mark(name)
   */
  constructor({ M, makeScene, run, theme, onMark }) {
    Object.assign(this, { M, makeScene, run, theme, onMark });
    this.scene = null;
    this.time = 0;
    this.done = false;
    this.error = null;
    this.generation = 0;
    this.step = 1 / 30; // fast-forward step (s)
  }

  /** (Re)create the scene and start the author's code at time 0. */
  start() {
    const gen = ++this.generation;
    this.scene?.dispose?.();
    const scene = this.makeScene();
    this.scene = scene;
    this.time = 0;
    this.done = false;
    this.error = null;
    const pending = new Set();
    const track = (mob, seen = new Set()) => {
      if (!mob || seen.has(mob)) return;
      seen.add(mob);
      if (typeof mob.waitForRender === 'function') {
        const p = Promise.resolve(mob.waitForRender()).catch(() => {});
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
      for (const child of mob.children ?? []) track(child, seen);
    };
    let starting = 0;
    const add = scene.add.bind(scene);
    scene.add = (...mobs) => { mobs.forEach((m) => track(m)); return add(...mobs); };
    const runAnimations = scene._runAnimations.bind(scene);
    scene._runAnimations = (anims, ...rest) => {
      starting++;
      anims.forEach((a) => track(a?.mobject));
      return runAnimations(anims, ...rest);
    };
    scene._startRenderLoop = () => {};
    scene._stopRenderLoop = () => {};
    const dummy = new this.M.VMobject();
    scene.wait = (t = 1) => scene.play(new this.M.Wait(dummy, { duration: t }));
    this._ready = () => {
      if (starting > 0 && scene._isPlaying) starting = 0;
      return pending.size === 0 && starting === 0;
    };
    const mark = (name) => { if (gen === this.generation) this.onMark?.(String(name), this.time); };
    Promise.resolve()
      .then(() => this.run(scene, this.theme, mark))
      .then(
        () => { if (gen === this.generation) this.done = true; },
        (e) => { if (gen === this.generation) { this.error = e; this.done = true; } },
      );
    return gen;
  }

  /**
   * Advance by up to dt seconds. Returns 'stepped', 'waiting' (scene busy with
   * real-world work or between animations), or 'done'.
   */
  advance(dt, draw = true) {
    if (this.done) return 'done';
    const scene = this.scene;
    if (!this._ready() || !scene._isPlaying) return 'waiting';
    // Never step past the end of the animation that is playing: the next one
    // starts at exactly that time, so scene time stays exact (no per-play overshoot).
    const tl = scene._timeline;
    if (tl && typeof tl.getDuration === 'function' && typeof tl.getCurrentTime === 'function') {
      const left = tl.getDuration() - tl.getCurrentTime();
      if (left > 1e-9 && dt > left) dt = left;
    }
    if (draw) {
      scene._tickFrame(dt);
    } else {
      const renderSafely = scene._renderSafely;
      scene._renderSafely = () => {};
      try { scene._tickFrame(dt); } finally { scene._renderSafely = renderSafely; }
    }
    this.time += dt;
    return 'stepped';
  }

  /**
   * Move to scene time `target` (clamped to the end), restarting first if it lies
   * behind. Resolves to false if a newer start() made this seek obsolete.
   * `yieldEvery` steps, it yields to the browser so the page stays responsive.
   */
  async seek(target, { yieldEvery = 15 } = {}) {
    if (target < this.time - 1e-9 || !this.scene) this.start();
    const gen = this.generation;
    let n = 0;
    while (this.time < target - 1e-9 && !this.done) {
      const r = this.advance(Math.min(this.step, target - this.time), false);
      if (r === 'waiting' || ++n % yieldEvery === 0) {
        await new Promise((res) => setTimeout(res, 0));
        if (gen !== this.generation) return false;
      }
    }
    this.scene.render();
    return gen === this.generation;
  }

  dispose() {
    this.generation++;
    this.scene?.dispose?.();
    this.scene = null;
  }
}
