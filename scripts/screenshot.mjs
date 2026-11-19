#!/usr/bin/env node
/**
 * Screenshot a built MyST site page in headless Chrome, to check how a manim
 * figure looks in the real theme (light and dark).
 *
 *   node scripts/screenshot.mjs --root SITE_DIR --page / --out shot.png \
 *        [--dark] [--wait 20] [--width 1280] [--height 1000] [--selector .fig-figure]
 *
 * Serves SITE_DIR (e.g. _build/html) on 127.0.0.1, waits --wait seconds of real
 * time (the animation runs in real time), scrolls --selector into view and
 * saves a viewport screenshot. --dark emulates prefers-color-scheme: dark.
 * Prints page errors and console errors.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { evaluate, launchChrome } from './cdp.mjs';

const a = { page: '/', wait: 20, width: 1280, height: 1000, selector: null, dark: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = () => argv[++i];
  if (k === '--root') a.root = path.resolve(v());
  else if (k === '--page') a.page = v();
  else if (k === '--out') a.out = v();
  else if (k === '--wait') a.wait = +v();
  else if (k === '--width') a.width = +v();
  else if (k === '--height') a.height = +v();
  else if (k === '--selector') a.selector = v();
  else if (k === '--dark') a.dark = true;
  else if (k === '--allow-external') a.allowExternal = true;
  else if (k === '--chrome') a.chrome = v();
  else throw new Error(`unknown argument ${k}`);
}
a.chrome ??= process.env.MANIM_CHROME;
if (!a.root || !a.out || !a.chrome) throw new Error('need --root, --out and --chrome (or $MANIM_CHROME)');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
const srv = http.createServer((req, res) => {
  let p = path.join(a.root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!p.startsWith(a.root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const step = (m) => console.error(`[screenshot] ${m}`);
step('launching chrome');
const cdp = await launchChrome(a.chrome, { width: a.width, height: a.height });
step('chrome up');
const problems = [];
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') problems.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`[console.error] ${m.params.args.map((x) => x.value ?? x.description).join(' ')}`);
});
try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // The MyST theme links render-blocking stylesheets on public CDNs (KaTeX,
  // Font Awesome, ...). Where Chrome cannot reach them (a sandbox without that
  // network access), the page never paints. Block every non-local URL so those
  // requests fail at once; --allow-external keeps them.
  if (!a.allowExternal) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: a.dark ? 'dark' : 'light' }] });
  step('navigating');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${srv.address().port}${a.page}` });
  await new Promise((r) => setTimeout(r, 3000));
  // Wait for the selector to exist (the theme hydrates after load).
  if (a.selector) {
    for (let i = 0; i < 100 && !(await evaluate(cdp, `!!document.querySelector(${JSON.stringify(a.selector)})`)); i++) await new Promise((r) => setTimeout(r, 200));
    await evaluate(cdp, `document.querySelector(${JSON.stringify(a.selector)})?.scrollIntoView({block: 'center'})`);
  }
  step(`waiting ${a.wait} s`);
  await new Promise((r) => setTimeout(r, a.wait * 1000));
  // Page.captureScreenshot hangs on this page in headless Chrome while the
  // WebGL scene animates, so take the latest frame of a screencast instead.
  step('capturing (screencast)');
  let latest = null;
  cdp.on((m) => {
    if (m.method === 'Page.screencastFrame') {
      latest = m.params.data;
      cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
    }
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: a.width, maxHeight: a.height });
  for (let i = 0; i < 300 && !latest; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.send('Page.stopScreencast');
  if (!latest) throw new Error('no screencast frame received');
  const data = latest;
  fs.writeFileSync(a.out, Buffer.from(data, 'base64'));
  console.log(`wrote ${a.out}`);
  console.log(`<html class="${await evaluate(cdp, 'document.documentElement.className')}">`);
} finally {
  await cdp.close();
  srv.close();
}
for (const p of problems) console.log(p);
