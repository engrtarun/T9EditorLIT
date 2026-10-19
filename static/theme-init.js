/*
 * Pre-hydration theme restore.
 *
 * Loaded by src/app.html as a plain (non-module) script so it runs before
 * the first paint. tauri.conf.json sets `script-src 'self'`, which forbids
 * an inline script, hence the separate file.
 *
 * Must stay in sync with the THEMES list in src/lib/stores/theme.svelte.ts:
 * an unknown or absent value falls back to "clipchamp", the same default
 * the <html> tag carries, so a first-run user sees no change at all.
 */
(function () {
  var THEMES = ["clipchamp", "nanami", "clipchamp-light"];
  var stored = null;
  try {
    stored = localStorage.getItem("t9-theme");
  } catch (err) {
    stored = null; // private mode / storage disabled — keep the default
  }
  var theme = THEMES.indexOf(stored) >= 0 ? stored : "clipchamp";
  document.documentElement.setAttribute("data-theme", theme);
  // Keep the UA's own widget painting (form controls, scrollbars) in step;
  // CSS sets `color-scheme` too, but this one applies before CSS loads.
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme === "clipchamp-light" ? "light" : "dark");
})();
