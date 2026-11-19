/**
 * MyST plugin: manim-web
 *
 * Registers the `manim` directive. At build time it emits an anywidget node
 * that carries the scene code, canvas options and the colour palette as model
 * data. The browser side is dist/manim-widget.bundle.mjs (manim-widget.mjs +
 * vendored manim-web, built by scripts/build.sh); no CDN is used.
 *
 * Usage (inside a figure, so it gets a label, caption and a static PDF version):
 *
 *   :::{figure}
 *   :label: fig-example
 *   :placeholder: ../100_figures/manim/example.pdf
 *   ```{manim}
 *   :file: ../100_figures/manim/example.js
 *   :width: 960
 *   :height: 540
 *   ```
 *   Caption text.
 *   :::
 *
 * Scene code gets `scene`, `THEME` (palette colours plus `bg`, `fg`) and every
 * manim-web export in scope; it runs inside an async function.
 *
 * Palette: semantic colour names -> hex, read from the file named by the
 * environment variable MANIM_PALETTE, else from `101_style/src/theme_default.yaml`
 * relative to the directory `myst` runs in (the thesis layout). In the page, a
 * CSS custom property `--<name>` overrides each entry, so the live scene follows
 * the site theme, including dark mode.
 */
import fs from 'fs';
import path from 'path';

const PLUGIN_DIR = path.dirname(new URL(import.meta.url).pathname);
const WIDGET_PATH = path.join(PLUGIN_DIR, 'dist', 'manim-widget.bundle.mjs');
// LaTeX rendering for MathTex: a separate file, copied into the site by MyST
// (model `$asset`) and only downloaded by browsers when a scene uses MathTex.
const VENDOR_DIR = path.join(PLUGIN_DIR, 'vendor', 'manim-web');
const MATHJAX_PATH = fs.existsSync(VENDOR_DIR)
  ? fs.readdirSync(VENDOR_DIR).filter((f) => /^MathJaxBundle-.*\.js$/.test(f)).map((f) => path.join(VENDOR_DIR, f))[0]
  : undefined;

function relativePath(fromDir, toFile) {
  return path.relative(fromDir, toFile).split(path.sep).join('/') || '.';
}

/** `name: "#rrggbb"` lines (YAML) or a JSON object. */
function readPalette() {
  const file = process.env.MANIM_PALETTE ?? path.resolve('101_style/src/theme_default.yaml');
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-?\s*([\w-]+):\s*["']?(#[0-9a-fA-F]{6})["']?\s*$/);
    if (m && m[1] !== 'rgb') out[m[1]] = m[2];
  }
  return out;
}

let PALETTE = null;

const manimDirective = {
  name: 'manim',
  doc: `Embed a manim-web scene. Write only the scene body: \`scene\`, \`THEME\`
and all manim-web exports are in scope.`,

  body: {
    type: String,
    doc: 'Scene code. Omit when using `:file:`.',
  },

  options: {
    file: {
      type: String,
      doc: 'Path to a .js file with the scene code, relative to the document. Overrides the body.',
    },
    width: { type: Number, doc: 'Logical canvas width in px (default 960); the canvas scales down to the column.' },
    height: { type: Number, doc: 'Logical canvas height in px (default 540).' },
    background: {
      type: String,
      doc: 'Fixed background colour. Default: the page background (follows light/dark mode).',
    },
    'background-color': { type: String, doc: 'Deprecated alias of `background`.' },
    scene: { type: String, doc: "'Scene' (default) or 'ThreeDScene'." },
    'show-player': { type: Boolean, doc: 'Show restart and pause buttons below the scene.' },
  },

  run(data, vfile) {
    const { body, options } = data;
    const fromDir = path.dirname(vfile.path);
    const esm = relativePath(fromDir, WIDGET_PATH);
    PALETTE ??= readPalette();

    let code = body ?? '';
    if (options?.file) {
      const filePath = path.resolve(fromDir, options.file);
      try {
        code = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        vfile.message(`manim: could not read file "${options.file}": ${err.message}`, data.node);
      }
    }
    if (!code.trim()) {
      vfile.message('manim: no scene code (use the directive body or :file:)', data.node);
    }
    if (!fs.existsSync(WIDGET_PATH)) {
      vfile.message(`manim: widget bundle missing (${WIDGET_PATH}); run scripts/build.sh in the plugin`, data.node);
    }

    return [
      {
        type: 'anywidget',
        esm,
        model: {
          code,
          width: options?.width ?? 960,
          height: options?.height ?? 540,
          background: options?.background ?? options?.['background-color'] ?? null,
          sceneType: options?.scene ?? 'Scene',
          showPlayer: options?.['show-player'] ?? false,
          palette: PALETTE,
          ...(MATHJAX_PATH ? { mathjax: { $asset: relativePath(fromDir, MATHJAX_PATH) } } : {}),
        },
      },
    ];
  },
};

const plugin = {
  name: 'manim-web',
  author: 'myst-manim-extension',
  license: 'MIT',
  directives: [manimDirective],
};

export default plugin;
