import { tick } from 'svelte';
import { app } from './stores/app.svelte';
import { browser } from './stores/browser.svelte';
import { toast } from './stores/toast.svelte';

/**
 * Ctrl+Shift+B — the in-built browser, from anywhere.
 *
 * One chord does the whole transition: whatever screen is up (dashboard,
 * editor, already inside the browser), it switches to the browser and puts a
 * **new tab** in front. If the browser is already open this is simply a new
 * tab, so the key can be pressed repeatedly without leaving the page the user
 * was reading — which is how the `Ctrl+T` habit works.
 *
 * It is capture-phase on `window` for two reasons: a focused input cannot
 * swallow it, and it runs before App's editor key map can interpret `B` as
 * something else. `stopPropagation` keeps exactly one tab from opening.
 *
 * The page webview has its own keyboard path (keys pressed inside a page never
 * reach this window). The same chord is in `browser-keys.ts` and the injected
 * shim, so the two paths agree.
 */
export function installBrowserHotkey(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.altKey || e.metaKey) return;
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.key.toLowerCase() !== 'b') return;

    e.preventDefault();
    e.stopPropagation();

    if (app.view !== 'browser') app.openBrowser(app.view);
    if (!browser.open()) {
      // Nine tabs is the cap. The browser view still opens — refusing to go
      // there at all would make the shortcut look broken.
      toast.push('warn', '9 tabs ki limit hai — pehle ek band karo');
      return;
    }

    // Firefox puts the caret in the address bar on a new tab. `tick` waits for
    // the browser view to mount when the chord was pressed on the dashboard.
    void tick().then(() => {
      requestAnimationFrame(() => {
        const bar = document.querySelector<HTMLInputElement>('[data-urlbar-input]');
        bar?.focus();
        bar?.select();
      });
    });
  };

  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
