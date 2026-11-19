// In-page side of the headless renderer (driven by scripts/render.mjs).
// Imports the unbundled vendored manim-web over HTTP, so even its lazy chunks
// (MathJax, ...) are available here.
import * as M from '../vendor/manim-web/manim-web.browser.js';
import { ArrayBufferTarget, Muxer } from '../vendor/manim-web/mp4-muxer-DFQEMCcH.js';
import { buildScope, compileScene, makeTheme } from '../manim-core.mjs';

/**
 * H.264/MP4 encoder: each frame is the scene canvas right after scene.render().
 * (Written instead of manim-web's registerRender harness, whose start() hands the
 * scene clock to an audio timeline clock that our fake clock does not drive.)
 */
async function makeMp4Encoder(width, height, fps, bitrate) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  const config = { codec: 'avc1.640033', width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`cannot encode H.264 ${width}x${height}`);
  encoder.configure(config);
  let n = 0;
  return {
    async capture(canvas) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: n % fps === 0 });
      frame.close();
      n++;
      while (encoder.encodeQueueSize > 4) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Uint8Array(target.buffer);
    },
  };
}

const clock = window.__clock;
const realNow = () => window.__clock.realNow();
const sleep = (ms) => new Promise((r) => clock.real.setTimeout(r, ms));
let videoBytes = null; // finished video file, read back in chunks by the driver

/**
 * job = {
 *   code, width, height, fps,
 *   theme: { palette, overrides, bg, fg, mode },
 *   posterTime: 'end' | seconds,     // which frame becomes the still
 *   svgBackground: null | '#rrggbb', // null = transparent SVG
 *   video: null | { format: 'mp4'|'webm', codec?: 'avc'|'vp9', bitrate? },
 *   holdEnd: seconds of still frames appended to the video,
 *   maxSeconds: safety stop,
 * }
 * returns { svg, png, duration, frames, videoSize, warnings }
 */
window.__renderJob = async (job) => {
  const warnings = [];
  const t = job.theme;
  const theme = makeTheme(t.palette, t.overrides, t.bg, t.fg, t.mode);
  const stage = document.getElementById('stage');
  const scene = new M.Scene(stage, {
    width: job.width, height: job.height, backgroundColor: theme.bg,
    // Keep the WebGL drawing buffer after compositing; without it the video
    // encoder reads an empty canvas (blank frames with only the background).
    preserveDrawingBuffer: true,
  });
  const run = compileScene(job.code, buildScope(M));

  let poster = null;
  const capturePoster = () => {
    scene.render();
    const svg = M.sceneToSVG(scene, job.svgBackground ? { background: job.svgBackground } : {});
    const png = scene.getCanvas().toDataURL('image/png');
    return { svg, png, time: clock.time / 1000 };
  };

  // Video: our own frame loop drives the scene; each frame is encoded after render().
  // (manim-web's registerRender harness hands the scene clock to an audio
  // timeline clock that the fake clock does not drive, which froze animations.)
  let session = null;
  if (job.video) {
    if (job.video.format !== 'mp4') throw new Error('only mp4 (H.264) output is implemented');
    session = await makeMp4Encoder(job.width, job.height, job.fps, job.video.bitrate ?? 8_000_000);
  }
  const debug = [];
  let captured = 0;
  const capture = async () => {
    if (!session) return;
    scene.render();
    if (job.debugFrames?.includes(captured)) debug.push({ frame: captured, png: scene.getCanvas().toDataURL('image/png') });
    await session.capture(scene.getCanvas());
    captured++;
  };

  // Hold the fake clock while the scene waits on real-world work. scene.play()
  // first awaits waitForRender() of every animated mobject (fonts, MathJax), in
  // real time; only then does its timeline start (_isPlaying becomes true). If
  // virtual time ran on meanwhile, the video would skip the start of each
  // animation. The same holds for text/math added directly with scene.add().
  const pendingRenders = new Set();
  const trackRender = (mob, seen = new Set()) => {
    if (!mob || seen.has(mob)) return;
    seen.add(mob);
    if (typeof mob.waitForRender === 'function') {
      const p = Promise.resolve(mob.waitForRender()).catch(() => {});
      pendingRenders.add(p);
      p.finally(() => pendingRenders.delete(p));
    }
    for (const child of mob.children ?? []) trackRender(child, seen);
  };
  const origAdd = scene.add.bind(scene);
  scene.add = (...mobs) => { mobs.forEach((m) => trackRender(m)); return origAdd(...mobs); };
  let starting = 0;
  const origRun = scene._runAnimations.bind(scene);
  scene._runAnimations = (...args) => { starting++; return origRun(...args); };
  const waitForScene = async () => {
    for (let i = 0; i < 12000; i++) {
      if (starting > 0 && scene._isPlaying) starting = 0;
      if (pendingRenders.size === 0 && starting === 0) return;
      if (done) return;
      await sleep(5);
    }
    warnings.push('scene waited more than 60 s of real time for rendering work');
  };

  let done = false;
  let error = null;
  Promise.resolve().then(() => run(scene, theme)).then(
    () => { done = true; },
    (e) => { error = e; done = true; },
  );

  const dt = 1000 / job.fps;
  const maxFrames = Math.ceil(job.maxSeconds * job.fps);
  let frames = 0;
  const started = realNow();
  await sleep(50);
  await waitForScene();
  await capture();                       // frame 0: the state before any time passes
  frames++;
  while (!done && frames < maxFrames) {
    await waitForScene();
    await clock.tick(dt);
    await capture();
    frames++;
    if (frames % 30 === 0) {
      console.info(`[progress] frame ${frames}, scene t=${(clock.time / 1000).toFixed(2)} s, ` +
        `${((realNow() - started) / frames).toFixed(0)} ms wall per frame`);
    }
    if (!poster && job.posterTime !== 'end' && clock.time / 1000 >= job.posterTime) {
      poster = capturePoster();
    }
  }
  if (frames >= maxFrames) warnings.push(`stopped at maxSeconds=${job.maxSeconds}`);
  if (error) throw error;
  const duration = clock.time / 1000;
  if (session) {
    const hold = Math.round((job.holdEnd ?? 0) * job.fps);
    for (let i = 0; i < hold; i++) { await clock.tick(dt); await capture(); frames++; }
  }
  if (!poster) poster = capturePoster();

  let videoSize = 0;
  if (session) {
    videoBytes = await session.finish();
    videoSize = videoBytes.byteLength;
  }
  return { debug, svg: poster.svg, png: poster.png, posterTime: poster.time, duration, frames, videoSize, warnings };
};

window.__readVideoChunk = (offset, length) => {
  const part = videoBytes.subarray(offset, offset + length);
  let bin = '';
  for (let i = 0; i < part.length; i += 32768) bin += String.fromCharCode(...part.subarray(i, i + 32768));
  return btoa(bin);
};
window.__renderReady = true;
