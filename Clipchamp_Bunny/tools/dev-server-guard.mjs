#!/usr/bin/env node
/*
 * One dev server. Not two.
 *
 * Vite's `strictPort` makes a second server fail, but npm still starts a new
 * Vite process and prints the error. This predev guard is friendlier: it checks
 * the shared port first and, when a server is already there, stays attached
 * instead of letting npm start another one.
 *
 * Why stay attached instead of exiting 0? `tauri dev` runs `npm run dev` as
 * its beforeDevCommand and expects that command to remain alive. If the guard
 * exits, Tauri may treat the dev command as finished. Keeping it alive lets
 * Tauri reuse the existing server, and there is no child Vite process to leak
 * when Tauri closes.
 */
import net from 'node:net';

const PORT = 5174;
const HOSTS = ['127.0.0.1', '::1'];

function canConnect(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  const checks = await Promise.all(HOSTS.map((host) => canConnect(host, PORT)));
  if (checks.some(Boolean)) {
    console.log('');
    console.log(`[t9-dev] Port ${PORT} already has a dev server.`);
    console.log('[t9-dev] Reusing it - NOT starting a second Vite instance.');
    console.log(`[t9-dev] Open http://localhost:${PORT}`);
    console.log('[t9-dev] Press Ctrl+C to stop this guard; the existing server keeps running.');
    console.log('');
    // Keep npm's predev process alive so npm never reaches the `dev` script
    // and `tauri dev` can attach to the server that is already running.
    setInterval(() => {}, 60_000);
    return;
  }

  console.log(`[t9-dev] Port ${PORT} is free; starting the single shared Vite server.`);
}

main().catch((error) => {
  console.error(`[t9-dev] Guard failed: ${error.message}`);
  process.exit(1);
});
