import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// Port differs from the parent T9EditorLIT app (1420) so both can run at once.
export default defineConfig(() => ({
  plugins: [tailwindcss(), sveltekit()],

  clearScreen: false,
  server: {
    port: 1424,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1425,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
