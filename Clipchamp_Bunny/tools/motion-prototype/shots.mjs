/**
 * Real screenshots of the app running on localhost:5174.
 * Headless Edge + CDP, same renderer the desktop app uses (Chromium).
 *
 * node shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'docs', 'motion', 'shots');
const W = 1440,
  H = 900,
  PORT = 9334;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => res(api);
    ws.onerror = () => rej(new Error('ws error'));
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
    await sleep(250);
  }
  throw new Error('no cdp');
}

const run = async () => {
  await mkdir(OUT, { recursive: true });
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--window-size=${W},${H}`,
      '--hide-scrollbars',
      '--enable-unsafe-swiftshader',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + join(here, '.edge-shots'),
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    const info = await waitFor(`http://127.0.0.1:${PORT}/json/version`);
    cdp = await connect(info.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, s);
    await cdp.send('Runtime.enable', {}, s);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false },
      s
    );

    const ev = async (expr) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true },
        s
      );
      if (r.exceptionDetails) return { error: r.exceptionDetails.text };
      return r.result.value;
    };

    const shot = async (name) => {
      const r = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } },
        s
      );
      const p = join(OUT, name + '.png');
      await writeFile(p, Buffer.from(r.data, 'base64'));
      console.log('shot ->', p);
    };

    await cdp.send('Page.navigate', { url: 'http://localhost:5174/' }, s);
    // The first load after a Vite restart transforms every module — 11 s was
    // not enough and the script shot a blank page. Poll for real content.
    const until = async (expr, ms, every = 400) => {
      const t0 = Date.now();
      for (;;) {
        const v = await ev(expr);
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(every);
      }
    };
    await until(`document.body.innerText.includes('Recent projects')`, 40000);
    // Outside Tauri the shell has no viewport height, so #app collapses to 0.
    // Give it the window back before shooting.
    await ev(`(() => {
      const st = document.createElement('style');
      st.textContent = 'html,body{height:900px!important;min-height:900px!important;overflow:hidden}#app{height:900px!important;min-height:900px!important}';
      document.head.appendChild(st);
      return document.getElementById('app')?.getBoundingClientRect().height;
    })()`);
    await sleep(600);
    await shot('01-dashboard');

    // open the in-app browser — wait for the button, then click it
    const opened = await (async () => {
      const found = await until(
        `[...document.querySelectorAll('button')].some(x => /(browser|new browser tab)/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||'')))`,
        30000
      );
      if (!found)
        return (
          'no button: ' +
          [
            ...(await ev(
              `[...document.querySelectorAll('button')].map(x=>x.getAttribute('aria-label')||x.title||'').filter(Boolean).slice(0,30).join(' | ')`
            ))
          ]
        );
      return await ev(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /(browser|new browser tab)/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||'')));
        b.click(); return 'clicked: ' + (b.getAttribute('aria-label')||b.title);
      })()`);
    })();
    console.log('browser open:', opened);
    // the browser view mounts asynchronously — wait for its address bar
    await until(`!!document.querySelector('[role=tablist], input[placeholder], textarea')`, 15000);
    await sleep(1200);
    await shot('02-browser-open');

    // open one real tab (speed dial tile), then a second tab with `+`, then
    // switch back — that is the exact behaviour asked for: the active chip
    // shows favicon + title + ×, and it folds to icon-only on switch.
    {
      const r = await (async () => {
        const expr = `(() => {
        const el = [...document.querySelectorAll('button,a,[role=button]')]
          .find(x => (x.textContent||'').trim() === 'YouTube');
        if (!el) return '';
        el.click(); return 'clicked';
      })()`;
        const hit = await until(expr, 20000);
        return hit || 'no tile YouTube';
      })();
      console.log('YouTube tile:', r);
      await sleep(400);
      await sleep(2600);
      await shot('03-tab-youtube');
    }

    // second tab via the header `+` (aria-label "New browser tab")
    const plus = await (async () => {
      const hit = await until(
        `[...document.querySelectorAll('button')].some(x => x.getAttribute('aria-label') === 'New browser tab')`,
        15000
      );
      if (!hit) return 'no + button';
      return await ev(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'New browser tab');
        b.click(); return 'clicked +';
      })()`);
    })();
    console.log('plus:', plus);
    await sleep(1500);
    console.log(
      'chips after +:',
      JSON.stringify(
        await ev(
          `[...document.querySelectorAll('[role=tablist] [role=tab]')].map(x => ({ sel: x.getAttribute('aria-selected'), w: Math.round(x.getBoundingClientRect().width), txt: (x.textContent||'').trim().slice(0,24) }))`
        )
      )
    );
    await shot('04-second-tab');

    // switch back to the YouTube chip: it must widen with title + ×, and the
    // new tab must fold back to a bare icon
    const back = await ev(`(() => {
      const c = [...document.querySelectorAll('[role=tablist] [role=tab]')].find(x => /youtube/i.test(x.textContent||'') || /youtube/i.test(x.id||''));
      if (!c) return 'no youtube chip';
      c.click(); return 'clicked chip';
    })()`);
    console.log('switch back:', back);
    await sleep(900);
    console.log(
      'chips after switch:',
      JSON.stringify(
        await ev(
          `[...document.querySelectorAll('[role=tablist] [role=tab]')].map(x => ({ sel: x.getAttribute('aria-selected'), w: Math.round(x.getBoundingClientRect().width), txt: (x.textContent||'').trim().slice(0,24) }))`
        )
      )
    );
    await shot('05-switched-back');

    console.log(
      'header html:',
      String(await ev(`document.querySelector('header')?.outerHTML.slice(0,700)`))
    );
    console.log('url now:', await ev('location.href'));
    console.log(
      'chips:',
      JSON.stringify(
        await ev(
          `[...document.querySelectorAll('[role=tablist] [role=tab]')].map(x => ({ t: (x.title||'').slice(0,24), sel: x.getAttribute('aria-selected') }))`
        )
      )
    );
    console.log('title:', await ev('document.title'));
    console.log('body snippet:', String(await ev('document.body.innerText')).slice(0, 400));
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
