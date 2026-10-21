<script lang="ts">
  /**
   * App-wide drop target — "drag a file onto the window to import it".
   *
   * Uses Tauri's native drag-drop (`onAppDrop` in ipc.ts) rather than an
   * HTML5 `drop` listener. WebView2 does not put a dropped file's absolute
   * path on `DataTransfer`, and reading the blob instead would mean pulling a
   * multi-gigabyte file into the heap — which AGENTS.md §1 forbids outright.
   * The native event hands back real paths, so the file is still streamed
   * straight off disk by ffprobe and the WebView only ever sees a URL.
   *
   * Two states, exactly like Clipchamp's:
   *   • hovering — a full-window scrim promising the drop will import;
   *   • dropped   — the first media file becomes the project, the rest are
   *                 queued into video history for later.
   *
   * Mounted once from +page.svelte, outside every `{#key}` block, so the
   * listener outlives screen and mode switches.
   */
  import { errorMessage, isMediaPath, onAppDrop } from "../../ipc";
  import { cc } from "../../stores/cc.svelte";
  import { project } from "../../stores/project.svelte";

  let hovering = $state(false);
  /** Last drop outcome, briefly shown so a rejected file is not silent. */
  let notice = $state<string | null>(null);
  let stop: (() => void) | null = null;

  $effect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await onAppDrop(
        (paths) => {
          if (!cancelled) return;
          void handleDrop(paths);
        },
        (hover) => {
          if (!cancelled) hovering = hover;
        },
      );
      if (cancelled) unlisten();
      else stop = unlisten;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      stop = null;
    };
  });

  async function handleDrop(paths: string[]): Promise<void> {
    const media = paths.filter(isMediaPath);
    if (media.length === 0) {
      flash(`${paths.length} file${paths.length > 1 ? "s" : ""} — not a supported media type`);
      return;
    }

    const first = media[0];
    try {
      // `project.load` probes with ffprobe and streams via the asset protocol;
      // nothing is buffered. Everything after the first file goes to history.
      await project.load(first);
      cc.projectName = first.split(/[\\/]/).pop() ?? cc.projectName;
      flash(
        media.length > 1
          ? `Imported ${first.split(/[\\/]/).pop()} (+${media.length - 1} more in history)`
          : `Imported ${first.split(/[\\/]/).pop()}`,
      );
      // Land in the editor with media selected, like Clipchamp does after an import.
      if (cc.view === "home") cc.openEditor();
    } catch (err) {
      flash(errorMessage(err));
    }
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(message: string): void {
    notice = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), 3500);
  }
</script>

{#if hovering}
  <!-- Scrim: covers everything so the drop lands on the window, not a panel.
       Solid-ish rather than blurred: `backdrop-filter` on a full-window layer
       forces WebView2 to re-render everything behind it on every frame while
       the pointer moves — the expensive kind of pretty on integrated graphics.
       85% reads the same as the old 70% + 2px blur for a fraction of the cost. -->
  <div
    class="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-cc-bg/85"
    role="presentation"
  >
    <div
      class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-cc-purple
        bg-cc-surface/90 px-14 py-12 text-center shadow-2xl"
    >
      <svg width="56" height="48" viewBox="0 0 56 48" aria-hidden="true">
        <rect x="2" y="14" width="30" height="24" rx="5" fill="var(--color-cc-blush)" />
        <path d="M13 21.5v11l10-5.5z" fill="var(--color-cc-purple)" />
        <circle cx="39" cy="17" r="11" fill="var(--color-cc-lilac)" />
        <path d="M39 12v10M34 17h10" stroke="#fff" stroke-width="2.4" stroke-linecap="round" />
      </svg>
      <p class="text-[15px] font-semibold text-cc-text">Drop media to import</p>
      <p class="max-w-xs text-[12px] leading-relaxed text-cc-text-3">
        Probed with ffprobe and streamed from disk — never loaded into RAM.
      </p>
    </div>
  </div>
{/if}

{#if notice}
  <!-- Dropped: a transient status line, bottom-centre, like Clipchamp's toast. -->
  <div
    class="pointer-events-none fixed bottom-5 left-1/2 z-[95] -translate-x-1/2 rounded-lg
      border border-cc-line bg-cc-menu px-4 py-2 text-[12.5px] text-cc-text shadow-xl"
    role="status"
    aria-live="polite"
    style="animation: cc-menu-in 140ms cubic-bezier(0.1, 0.9, 0.2, 1)"
  >
    {notice}
  </div>
{/if}
