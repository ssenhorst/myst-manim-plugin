/**
 * Minimal Chrome DevTools protocol client (no npm dependencies): launches a
 * headless Chrome and talks to its first page over Node's built-in WebSocket.
 * Chrome runs with --no-sandbox because on jupiter it already runs inside the
 * bubblewrap sandbox, where Chrome's own sandbox cannot start.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Chrome DevTools protocol ─────────────────────────────────────────────────
export async function launchChrome(bin, { width = 1280, height = 1000 } = {}) {
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'manim-chrome-'));
  const gpu = (process.env.MANIM_CHROME_GPU_FLAGS ??
    '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist').split(/\s+/).filter(Boolean);
  const proc = spawn(bin, [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    ...gpu,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(portFile)) throw new Error(`Chrome did not start:\n${stderr.slice(-2000)}`);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((f) => f(msg));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const close = async () => {
    try { ws.close(); } catch {}
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, on: (f) => listeners.push(f), close };
}

export async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text);
  }
  return r.result.value;
}

