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
const RESERVED = new Set(['scene', 'THEME', 'default']);

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

/** Compile the author's code once into an async function of (scene, THEME, ...scope). */
export function compileScene(code, scope) {
  const names = Object.keys(scope);
  const fn = new Function(
    'scene', 'THEME', ...names,
    `"use strict"; return (async () => {\n${code}\n})();`,
  );
  return (scene, theme) => fn(scene, theme, ...names.map((n) => scope[n]));
}
