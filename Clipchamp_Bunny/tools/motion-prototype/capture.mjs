/**
 * Capture the motion prototype frame-by-frame through Edge + CDP.
 *
 * Why frames and not a screen recording: the timeline is deterministic
 * (`renderAt(ms)`), so frame N is always the same picture. No dropped frames,
 * no timing drift, no encoder fighting the compositor. PNG frames -> ffmpeg.
 *
 * Usage: node capture.mjs [--fps 30] [--out ..\..\docs\motion\tab-chips.mp4]
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const FPS = Number(argOf('--fps', '30'));
const W = 1440;
const H = 900;
const OUT = resolve(here, argOf('--out', '../../docs/motion/tab-chips.mp4'));
const FRAMES_DIR = join(here, '.frames');
const PORT = 9333;

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => existsSync(p));
if (!EDGE) throw new Error('Edge not found');

/* ------------------------------------------------------------------ CDP */
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => res(api);
    ws.onerror = (e) => rej(new Error('ws error ' + e.message));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    const api = {
      send(method, params = {}, sessionId) {
        const msgId = ++id;
        return new Promise((resolve, reject) => {
          pending.set(msgId, { resolve, reject });
          ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
        });
      },
      close: () => ws.close()
    };
  });
}

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP did not come up: ' + url);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- script */
const run = async () => {
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });
  await mkdir(dirname(OUT), { recursive: true });

  const pageUrl = 'file:///' + join(here, 'index.html').replace(/\\/g, '/');

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--window-size=${W},${H}`,
      '--hide-scrollbars',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + join(here, '.edge-profile'),
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    const info = await waitFor(`http://127.0.0.1:${PORT}/json/version`);
    cdp = await connect(info.webSocketDebuggerUrl);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = sessionId;

    await cdp.send('Page.enable', {}, s);
    await cdp.send('Runtime.enable', {}, s);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false },
      s
    );
    await cdp.send('Page.navigate', { url: pageUrl }, s);
    await sleep(900);

    // the real brand mark, straight out of the generated component
    const brand = await readFile(
      join(here, '..', '..', 'src', 'lib', 'components', 'dashboard', 'BrandMark.svelte'),
      'utf8'
    );
    const paths = [...brand.matchAll(/<path\s+d="([^"]+)"/g)].map((m) => m[1]);
    const d = paths.sort((a, b) => b.length - a.length)[0] ?? '';

    const ev = async (expr) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true },
        s
      );
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    await ev(`window.setBrandPath(${JSON.stringify(d)})`);
    const meta = await ev('window.ready()');
    const total = meta.total;
    const frames = Math.round((total / 1000) * FPS);
    console.log(`timeline ${total} ms -> ${frames} frames @ ${FPS} fps`);

    for (let i = 0; i < frames; i++) {
      const t = (i / FPS) * 1000;
      await ev(`window.renderAt(${t})`);
      const shot = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } },
        s
      );
      await writeFile(
        join(FRAMES_DIR, `f${String(i).padStart(5, '0')}.png`),
        Buffer.from(shot.data, 'base64')
      );
      if (i % 60 === 0) process.stdout.write(`  frame ${i}/${frames}\r`);
    }
    console.log(`\ncaptured ${frames} frames`);

    // ---- encode
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        String(FPS),
        '-i',
        join(FRAMES_DIR, 'f%05d.png'),
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '17',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        OUT
      ],
      { stdio: 'inherit' }
    );
    await new Promise((res, rej) =>
      ff.on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))))
    );

    console.log('video ->', OUT);
  } finally {
    try {
      cdp?.close();
    } catch {}
    child.kill();
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
