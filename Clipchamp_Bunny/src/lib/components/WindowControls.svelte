<script lang="ts">
  /**
   * The three caption buttons — minimize, maximize/restore, close — drawn
   * inside our own top bar instead of in an OS strip above it.
   *
   * Why we have to draw them: the window is undecorated (`decorations: false`
   * in `tauri.conf.json`) because the OS title bar was a second, empty band
   * above the app's own bar. Undecorated means Windows paints no buttons — so
   * the app paints them, exactly like Clipchamp/Chromium does: real caption
   * buttons living in the app's header, over the app's own pixels.
   *
   * Geometry matches Windows 11: 46 px wide, full bar height, flush against
   * the top-right corner. That flushness is why the two bars that mount this
   * component keep no right padding of their own — the hover highlight has to
   * reach the window edge, or it reads as a web page and not as a window.
   *
   * In the browser (`npm run dev` on localhost:5174) there is no window to
   * control, so this renders nothing and the preview stays intact.
   */
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { isTauri } from '../ipc';

  const desktop = isTauri();
  const appWindow = desktop ? getCurrentWindow() : null;

  /** Restore glyph when maximized, maximize glyph otherwise. */
  let maximized = $state(false);

  $effect(() => {
    const win = appWindow;
    if (!win) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const state = await win.isMaximized();
        if (!disposed) maximized = state;
        // The window can be maximized without a click here — Win+↑, a snap,
        // or a double-click on the drag region — so the glyph follows the
        // actual window instead of our own last action.
        unlisten = await win.onResized(() => {
          void win.isMaximized().then((m) => (maximized = m));
        });
      } catch {
        // Missing window permission: the buttons stay inert, nothing breaks.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  const minimize = () => void appWindow?.minimize().catch(() => {});
  const toggleMaximize = () => void appWindow?.toggleMaximize().catch(() => {});
  const close = () => void appWindow?.close().catch(() => {});
</script>

{#if desktop}
  <div class="flex h-full shrink-0 items-stretch" data-window-controls>
    <button
      type="button"
      onclick={minimize}
      class="grid w-[46px] place-items-center text-nc-txt/80 transition-colors duration-100 hover:bg-white/10 hover:text-white"
      title="Minimize"
      aria-label="Minimize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M0 5.5h10" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>

    <button
      type="button"
      onclick={toggleMaximize}
      class="grid w-[46px] place-items-center text-nc-txt/80 transition-colors duration-100 hover:bg-white/10 hover:text-white"
      title={maximized ? 'Restore down' : 'Maximize'}
      aria-label={maximized ? 'Restore down' : 'Maximize'}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        {#if maximized}
          <!-- restore: a rect in front, the sliver of the one behind -->
          <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" />
          <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" />
        {:else}
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" />
        {/if}
      </svg>
    </button>

    <button
      type="button"
      onclick={close}
      class="grid w-[46px] place-items-center text-nc-txt/80 transition-colors duration-100 hover:bg-[#c42b1c] hover:text-white"
      title="Close"
      aria-label="Close"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
  </div>
{/if}
