import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [tailwindcss(), sveltekit()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //    …and the sibling workspaces that live inside this repo. They are
      //    separate projects with their own builds; without this, Vite
      //    watches their `dist/` output and hard-reloads the editor every time
      //    one of them rebuilds.
      ignored: [
        "**/src-tauri/**",
        "**/Clipchamp_Bunny/**",
        "**/Clipchamp_MIMO/**",
        "**/Clipchamp Clone/**",
        "**/WebClipchamp_Clone/**",
        "**/_unzip_T9UI/**",
        "**/resource_Clipchamp/**",
      ],
    },
  },
}));
