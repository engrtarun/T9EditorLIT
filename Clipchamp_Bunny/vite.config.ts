import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { mp3DevApi } from './tools/dev-mp3-api';
import { textScale } from './tools/text-scale-plugin';

export default defineConfig({
  plugins: [tailwindcss(), svelte(), mp3DevApi(), textScale()],
  server: {
    port: 5174,
    // One dev server only. The predev guard reuses an existing 5174 server;
    // this makes a direct/racing second Vite fail loudly instead of quietly
    // moving to 5175 and taking another chunk of RAM.
    strictPort: true,
    // Tauri dev and the browser preview both hit this server through a proxy
    // on some setups; allow any Host header so the 502 never appears.
    host: true,
    allowedHosts: true,
    open: false,
    // The Rust build folder is NOT part of the frontend.
    //
    // Watching it made the dev server die: a Rust build holds
    // `src-tauri/target/.build-lock` open, the watcher could not read it, and
    // chokidar took the whole server down with it. When two agents are
    // working at once - one building, one editing the UI - that turned every
    // build into a dead dev server.
    watch: {
      ignored: ['**/src-tauri/target/**', '**/dist/**', '**/.t9/**', '**/node_modules/**']
    }
  }
});
