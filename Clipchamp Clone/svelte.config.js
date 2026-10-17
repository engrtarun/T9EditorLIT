import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // Tauri serves the built files itself; SPA fallback keeps deep links working.
      fallback: "index.html",
    }),
  },
};

export default config;
