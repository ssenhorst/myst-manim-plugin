#!/usr/bin/env node
/**
 * Headless test of the widget's control interface (model keys), without MyST.
 *
 *   node scripts/test-widget.mjs --scene fig.js --out DIR [--palette theme.yaml] [--chrome PATH]
 *
 * Mounts dist/manim-widget.bundle.mjs on a bare page with a model that behaves
 * like MyST's MystAnyModel (get/set/on; save_changes throws), then plays a
 * scripted sequence of control steps: wait, seek by time, by progress, to a
 * marker, play for a while, seek backwards, pause. After each step it prints the
 * widget's output keys and saves a screenshot (DIR/step-N.png).
 * Exit code 1 if a check fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, launchChrome } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
a.chrome ??= process.env.MANIM_CHROME;
if (!a.scene || !a.out || !a.chrome) throw new Error('need --scene, --out and --chrome (or $MANIM_CHROME)');
fs.mkdirSync(a.out, { recursive: true });
// Palette (`name: "#rrggbb"` lines, as in the thesis theme YAML); without it,
// THEME.<name> is undefined and objects coloured with it are invisible.
const palette = {};
if (a.palette) {
  for (const line of fs.readFileSync(a.palette, 'utf8').split('\n')) {
    const m = line.match(/^\s*-?\s*([\w-]+):\s*["']?(#[0-9a-fA-F]{6})["']?\s*$/);
    if (m) palette[m[1]] = m[2];
  }
}

const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;font-family:sans-serif}</style></head>
<body><div id="host" style="width:960px"></div><script type="module">
import widget from '/dist/manim-widget.bundle.mjs';
class Model { // same semantics as MyST's MystAnyModel
  #s; #t = new EventTarget();
  constructor(s) { this.#s = s; }
  get(k) { return this.#s[k]; }
  set(k, v) { this.#s[k] = v; this.#t.dispatchEvent(new CustomEvent('change:' + k)); this.#t.dispatchEvent(new CustomEvent('change')); }
  on(n, cb) { this.#t.addEventListener(n, cb); }
  off() { throw new Error('off not implemented'); }
  save_changes() { throw new Error('save_changes not implemented'); }
}
window.__setup = async (code, palette) => {
  const model = new Model({ code, width: 960, height: 540, sceneType: 'Scene', showPlayer: true,
    palette, mathjax: '/vendor/manim-web/MathJaxBundle-DyBGXoNz.js', playing: false, loop: false, time: 0, speed: 1, progress: 0, duration: null, markers: [], done: false });
  window.model = model;
  await widget.render({ model, el: document.getElementById('host') });
};
window.__state = () => { const m = window.model; return Object.fromEntries(['time','progress','playing','duration','markers','done'].map(k => [k, m.get(k)])); };
window.__ready = true;
</script></body></html>`;

const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
  const p = path.join(ROOT, decodeURIComponent(u));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const cdp = await launchChrome(a.chrome, { width: 1000, height: 700 });
const errors = [];
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description).join(' '));
});
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
let latest = null;
cdp.on((m) => {
  if (m.method === 'Page.screencastFrame') {
    latest = m.params.data;
    cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  }
});
let ok = true;
const check = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); ok &&= cond; };
const state = () => evaluate(cdp, 'window.__state()');
// Wait (real time) until the widget's outputs satisfy pred, or time out.
const until = async (pred, timeout = 120) => {
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) return s;
    if ((Date.now() - t0) / 1000 > timeout) return s;
    await sleep(0.25);
  }
};
let n = 0;
const shot = async (label) => {
  latest = null;
  await sleep(0.8);
  for (let i = 0; i < 50 && !latest; i++) await sleep(0.1);
  const f = path.join(a.out, `step-${++n}.png`);
  if (latest) fs.writeFileSync(f, Buffer.from(latest, 'base64'));
  const s = await state();
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : JSON.stringify(v));
  console.log(`[${n}] ${label}: ${Object.entries(s).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`);
  return s;
};

try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${srv.address().port}/` });
  for (let i = 0; i < 100 && !(await evaluate(cdp, 'window.__ready === true').catch(() => false)); i++) await sleep(0.1);
  await evaluate(cdp, `window.__setup(${JSON.stringify(fs.readFileSync(a.scene, 'utf8'))}, ${JSON.stringify(palette)})`);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1000, maxHeight: 700 });

  let s = await shot('mounted, paused at 0');
  check(s.time === 0 && s.playing === false, 'paused at t = 0 (autoplay off)');

  await evaluate(cdp, 'window.model.set("time", 6.5)');
  s = await until((x) => Math.abs(x.time - 6.5) < 0.05);
  s = await shot('model.set("time", 6.5)');
  check(Math.abs(s.time - 6.5) < 0.05, 'seek forward by time');

  await evaluate(cdp, 'window.model.set("progress", 1)');
  s = await until((x) => x.duration != null && x.done);
  s = await shot('model.set("progress", 1)');
  check(s.duration > 0 && s.done, `duration learned (${s.duration?.toFixed(2)} s), at the end`);
  check(Array.isArray(s.markers) && s.markers.length > 0, `markers: ${JSON.stringify(s.markers?.map((m) => `${m.name}@${m.time.toFixed(2)}`))}`);

  const orders = s.markers?.find((m) => m.name === 'orders');
  if (orders) {
    await evaluate(cdp, `window.model.set("time", ${orders.time})`);
    s = await until((x) => Math.abs(x.time - orders.time) < 0.05 && !x.done);
    s = await shot(`seek back to marker "orders" (${orders.time.toFixed(2)} s)`);
    check(Math.abs(s.time - orders.time) < 0.05, 'seek backwards (restart + fast-forward)');
  }

  await evaluate(cdp, 'window.model.set("playing", true)');
  const t0 = (await state()).time;
  await sleep(2);
  s = await shot('model.set("playing", true), 2 s real time');
  check(s.playing === true && s.time > t0 + 0.3, `playing advances time (${t0.toFixed(2)} -> ${s.time.toFixed(2)} s)`);

  await evaluate(cdp, 'window.model.set("playing", false)');
  const tp = (await until((x) => x.playing === false)).time;
  await sleep(1.5);
  s = await shot('model.set("playing", false), 1.5 s later');
  check(Math.abs(s.time - tp) < 1e-6, 'pause holds time');

  await evaluate(cdp, 'window.model.set("progress", 0.25)');
  s = await until((x) => Math.abs(x.progress - 0.25) < 0.01);
  s = await shot('model.set("progress", 0.25)');
  check(Math.abs(s.progress - 0.25) < 0.01, 'seek by progress');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ').slice(0, 500) : ''}`);
} finally {
  await cdp.close();
  srv.close();
}
console.log(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
