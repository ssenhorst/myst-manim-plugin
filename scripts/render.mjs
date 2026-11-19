#!/usr/bin/env node
/**
 * Headless render of one manim scene file to still images and videos.
 *
 *   node scripts/render.mjs --scene fig.js --out DIR [options]
 *
 * Writes, for basename B (default: scene file name):
 *   B.svg            vector still, drawn in the DEFAULT palette, transparent
 *                    background (input for the figure-styling pipeline)
 *   B.png            raster still at --width x --height, web palette, light
 *   B-light.mp4      video, web palette, light background   (unless --no-video)
 *   B-dark.mp4       video, web palette, dark background    (unless --no-video)
 *
 * Options
 *   --chrome PATH        Chrome / Chrome for Testing binary (or $MANIM_CHROME)
 *   --palette FILE       default-theme colours: YAML `colors:` list/map or JSON map
 *   --web-palette FILE   JSON map name -> hex of the current web theme (overrides)
 *   --css FILE           CSS with :root and .dark blocks defining
 *                        --myst-color-bg / --myst-color-text (light/dark bg, fg)
 *   --width 1920 --height 1080 --fps 30
 *   --poster end|SECONDS  which frame is the still (default: end = final frame)
 *   --hold 1             seconds of still frames appended to each video
 *   --format mp4|webm    (default mp4, H.264)
 *   --max-seconds 120    safety stop
 *   --no-video           stills only
 *
 * No npm dependencies: Chrome is driven through the DevTools protocol over
 * Node's built-in WebSocket; the page is served from this repository by a
 * local HTTP server on 127.0.0.1.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, launchChrome } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { width: 1920, height: 1080, fps: 30, poster: 'end', hold: 1, format: 'mp4', maxSeconds: 120, video: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    switch (k) {
      case '--scene': a.scene = v(); break;
      case '--out': a.out = v(); break;
      case '--name': a.name = v(); break;
      case '--chrome': a.chrome = v(); break;
      case '--palette': a.palette = v(); break;
      case '--web-palette': a.webPalette = v(); break;
      case '--css': a.css = v(); break;
      case '--width': a.width = +v(); break;
      case '--height': a.height = +v(); break;
      case '--fps': a.fps = +v(); break;
      case '--poster': { const p = v(); a.poster = p === 'end' ? 'end' : +p; break; }
      case '--hold': a.hold = +v(); break;
      case '--format': a.format = v(); break;
      case '--max-seconds': a.maxSeconds = +v(); break;
      case '--no-video': a.video = false; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  if (!a.scene || !a.out) throw new Error('need --scene and --out');
  a.chrome ??= process.env.MANIM_CHROME;
  if (!a.chrome) throw new Error('need --chrome or $MANIM_CHROME');
  a.name ??= path.basename(a.scene).replace(/\.[^.]+$/, '');
  return a;
}

// ── palettes ─────────────────────────────────────────────────────────────────
function readPalette(file) {
  if (!file) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  // Minimal reader for `name: "#rrggbb"` lines (the thesis theme YAML files);
  // nested `rgb:` entries are taken from the line under the name.
  const out = {};
  let pending = null;
  for (const line of text.split('\n')) {
    let m = line.match(/^\s*-?\s*([\w-]+):\s*["']?(#[0-9a-fA-F]{6})["']?\s*$/);
    if (m && m[1] !== 'rgb') { out[m[1]] = m[2]; pending = null; continue; }
    m = line.match(/^\s*-?\s*([\w-]+):\s*(#.*)?$/);
    if (m && !line.includes('rgb')) { pending = m[1]; continue; }
    m = line.match(/^\s*rgb:\s*["']?(#[0-9a-fA-F]{6})/);
    if (m && pending) { out[pending] = m[1]; pending = null; }
  }
  return out;
}

function readThemeCss(file) {
  const res = { light: { bg: '#ffffff', fg: '#000000' }, dark: { bg: '#1c1917', fg: '#ffffff' } };
  if (!file) return res;
  const css = fs.readFileSync(file, 'utf8');
  const block = (sel) => {
    const m = css.match(new RegExp(`(^|\\n)\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    return m ? m[2] : '';
  };
  const prop = (b, name) => (b.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`)) || [])[1];
  for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
    const b = block(sel);
    res[mode].bg = prop(b, 'myst-color-bg') ?? res[mode].bg;
    res[mode].fg = prop(b, 'myst-color-text') ?? res[mode].fg;
  }
  return res;
}

// ── static server ────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };
function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function runJob(cdp, url, job) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 600; i++) {
    if (await evaluate(cdp, 'window.__renderReady === true').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return evaluate(cdp, `window.__renderJob(${JSON.stringify(job)})`);
}

async function readVideo(cdp, size) {
  const parts = [];
  const CH = 4 << 20;
  for (let off = 0; off < size; off += CH) {
    parts.push(Buffer.from(await evaluate(cdp, `window.__readVideoChunk(${off}, ${CH})`), 'base64'));
  }
  return Buffer.concat(parts);
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const code = fs.readFileSync(args.scene, 'utf8');
const palette = readPalette(args.palette);
const web = readPalette(args.webPalette);
const webOverrides = Object.fromEntries(Object.keys(palette).filter((k) => web[k]).map((k) => [k, web[k]]));
const modes = readThemeCss(args.css);
fs.mkdirSync(args.out, { recursive: true });

const srv = await serve(ROOT);
const url = `http://127.0.0.1:${srv.address().port}/render/render.html`;
const cdp = await launchChrome(args.chrome);
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') console.error('[page exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'info'].includes(m.params.type)) {
    console.error(`[page ${m.params.type}]`, m.params.args.map((x) => x.value ?? x.description).join(' '));
  }
});
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

const base = { debugFrames: process.env.MANIM_DEBUG_FRAMES ? process.env.MANIM_DEBUG_FRAMES.split(',').map(Number) : [], code, width: args.width, height: args.height, fps: args.fps, posterTime: args.poster, holdEnd: args.hold, maxSeconds: args.maxSeconds };
const write = (name, data) => { const p = path.join(args.out, name); fs.writeFileSync(p, data); console.log(`wrote ${p} (${data.length} bytes)`); };
const t0 = Date.now();
try {
  // 1. Vector still in the default palette (for the figure-styling pipeline).
  const still = await runJob(cdp, url, {
    ...base, video: null, svgBackground: null,
    theme: { palette, overrides: {}, bg: palette.white ?? '#ffffff', fg: palette.ink ?? '#000000', mode: 'default' },
  });
  write(`${args.name}.svg`, still.svg);
  console.log(`still at t=${still.posterTime.toFixed(2)} s of ${still.duration.toFixed(2)} s ${still.warnings.join('; ')}`);

  // 2. Light and dark renders in the web palette (PNG still from the light one).
  for (const mode of ['light', 'dark']) {
    const job = {
      ...base, svgBackground: null,
      video: args.video ? { format: args.format, codec: args.format === 'webm' ? 'vp9' : 'avc' } : null,
      theme: { palette, overrides: webOverrides, bg: modes[mode].bg, fg: modes[mode].fg, mode },
    };
    if (!args.video && mode === 'dark') break;
    const r = await runJob(cdp, url, job);
    if (mode === 'light') write(`${args.name}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
    if (args.video) write(`${args.name}-${mode}.${args.format}`, await readVideo(cdp, r.videoSize));
    for (const d of r.debug ?? []) write(`debug-${mode}-frame${d.frame}.png`, Buffer.from(d.png.split(',')[1], 'base64'));
    console.log(`${mode}: ${r.frames} frames, ${r.duration.toFixed(2)} s scene time ${r.warnings.join('; ')}`);
  }
} finally {
  await cdp.close();
  srv.close();
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s wall time`);
