// Deterministic clock for headless rendering. Loaded as a classic script before
// any module, so manim-web sees these versions of performance.now,
// requestAnimationFrame and the timers. Time only moves when the render loop
// calls __clock.tick(ms): every video frame is then exactly 1/fps apart, no
// matter how slow software WebGL is.
(() => {
  const realPerfNow = performance.now.bind(performance);
  const real = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
  let T = 0;
  let seq = 0;
  const timers = new Map(); // id -> { at, fn, args, interval }
  const rafs = new Map();

  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: T + Math.max(0, +ms || 0), fn, args, interval: null });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = ++seq;
    const step = Math.max(1, +ms || 0);
    timers.set(id, { at: T + step, fn, args, interval: step });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (fn) => { const id = ++seq; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => rafs.delete(id);
  performance.now = () => T;
  const base = Date.now();
  Date.now = () => base + T;

  const settle = () => new Promise((r) => real.setTimeout(r, 0));

  window.__clock = {
    real,
    settle,
    realNow: realPerfNow,
    get time() { return T; },
    /** Advance virtual time by `ms`: fire due timers in order, then one animation frame. */
    async tick(ms) {
      const end = T + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        const [id, t] = next;
        T = Math.max(T, t.at);
        if (t.interval) t.at += t.interval; else timers.delete(id);
        try { t.fn(...t.args); } catch (e) { console.error(e); }
        await settle();
      }
      T = end;
      const cbs = [...rafs.values()];
      rafs.clear();
      for (const f of cbs) { try { f(T); } catch (e) { console.error(e); } }
      await settle();
    },
  };
})();
