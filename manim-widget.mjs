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
 */
import * as ManimWeb from './vendor/manim-web/manim-web.browser.js';
import { buildScope, compileScene, themeFromCss } from './manim-core.mjs';

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

    // Responsive box with the scene's aspect ratio, never wider than `width`.
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `width:100%;max-width:${width}px;margin:0 auto;`;
    const container = document.createElement('div');
    container.style.cssText = `width:100%;aspect-ratio:${width}/${height};overflow:hidden;`;
    wrapper.appendChild(container);
    el.appendChild(wrapper);

    let bar = null, playBtn = null, restartBtn = null;
    if (showPlayer) {
      bar = document.createElement('div');
      bar.style.cssText =
        'display:flex;gap:8px;justify-content:center;padding:6px 0;font-size:13px;' +
        'color:var(--myst-color-text-secondary, #4b5563);';
      restartBtn = button('restart', 'Restart the animation');
      playBtn = button('pause', 'Pause / resume');
      bar.append(restartBtn, playBtn);
      wrapper.appendChild(bar);
    }

    let scene = null;
    let generation = 0;
    let paused = false;

    async function start() {
      const gen = ++generation;
      scene?.dispose?.();
      container.innerHTML = '';
      const theme = themeFromCss(palette, el);
      const SceneClass = ManimWeb[sceneType] ?? ManimWeb.Scene;
      scene = new SceneClass(container, {
        width, height, backgroundColor: fixedBg ?? theme.bg,
      });
      // The canvas renders at width x height; CSS scales it to the column.
      const canvas = container.querySelector('canvas');
      if (canvas) canvas.style.cssText += ';width:100%;height:100%;display:block;';
      paused = false;
      if (playBtn) playBtn.textContent = 'pause';
      try {
        await run(scene, theme);
      } catch (err) {
        if (gen === generation) {
          console.error('[manim]', err);
          showError(container, err.message);
        }
      }
    }

    restartBtn?.addEventListener('click', () => start());
    playBtn?.addEventListener('click', () => {
      if (!scene) return;
      paused = !paused;
      paused ? scene.pause?.() : scene.resume?.();
      playBtn.textContent = paused ? 'play' : 'pause';
    });

    // Start when visible; restart when the page switches light/dark theme.
    const visible = new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { obs.disconnect(); start(); }
    }, { threshold: 0.1 });
    visible.observe(container);

    let lastMode = document.documentElement.classList.contains('dark');
    const themeWatch = new MutationObserver(() => {
      const mode = document.documentElement.classList.contains('dark');
      if (mode !== lastMode) { lastMode = mode; if (scene) start(); }
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      visible.disconnect();
      themeWatch.disconnect();
      generation++;
      scene?.dispose?.();
      wrapper.remove();
    };
  },
};
