import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5174,
    strictPort: false,
    // Tauri dev and the browser preview both hit this server through a proxy
    // on some setups; allow any Host header so the 502 never appears.
    host: true,
    allowedHosts: true,
    open: false
  }
});
