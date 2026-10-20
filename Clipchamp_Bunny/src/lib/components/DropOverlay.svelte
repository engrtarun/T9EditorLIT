<script lang="ts">
  import { project } from '../stores/project.svelte';
  import { mode } from '../stores/mode.svelte';
  import { isTauri } from '../ipc';

  /**
   * App-wide drag & drop. Drop a video anywhere in the window and it is
   * imported, probed and made the project source — the Clipchamp behaviour of
   * "drag & drop media from your device to import".
   *
   * On the desktop this goes through Tauri's own drag-drop event, because
   * **only** that gives the real filesystem path. The browser's `dataTransfer`
   * hands over a blob with no path behind it, and a blob cannot be probed by
   * FFmpeg or written to SQLite — it would have been a fake asset.
   */
  let dragging = $state(false);
  let over = $state(false);
  let depth = 0;

  function isFileDrag(e: DragEvent) {
    return !!e.dataTransfer?.types?.includes('Files');
  }

  function onDragEnter(e: DragEvent) {
    if (isTauri() || !isFileDrag(e)) return;
    depth++;
    dragging = true;
  }

  function onDragOver(e: DragEvent) {
    if (isTauri() || !isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    over = true;
  }

  function onDragLeave(e: DragEvent) {
    if (isTauri() || !isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      dragging = false;
      over = false;
    }
  }

  async function onDrop(e: DragEvent) {
    if (isTauri() || !isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    dragging = false;
    over = false;

    const files = e.dataTransfer?.files;
    if (!files?.length) return;

    const usable = [...files].filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('audio/')
    );
    if (!usable.length) return;

    // A dropped file that arrives mid-edit starts a new project.
    await project.importDropped(usable);

    if (mode.current === 'ingest') {
      // stay here — the pipeline is already visible
    } else {
      mode.set('ingest');
    }
  }

  // The desktop path: Tauri hands us the real paths of the dropped files.
  $effect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'over') {
            dragging = true;
            over = true;
          } else if (payload.type === 'leave') {
            dragging = false;
            over = false;
          } else if (payload.type === 'drop') {
            dragging = false;
            over = false;
            void project.importPaths(payload.paths);
            if (mode.current !== 'ingest') mode.set('ingest');
          }
        });
        if (alive) unlisten = stop;
        else stop();
      } catch {
        /* the webview has no drag-drop event - the browser path still works */
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
      unlisten = null;
    };
  });
</script>

<svelte:window
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
/>

{#if dragging}
  <div
    class="pointer-events-none fixed inset-0 z-[500] grid place-items-center bg-nc-bg/85 backdrop-blur-sm"
    aria-hidden="true"
  >
    <div
      class="nc-tie-edge flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 text-center transition-colors
             {over ? 'border-nc-gold bg-nc-gold/10' : 'border-nc-line-2 bg-nc-panel'}"
    >
      <svg
        width="44"
        height="44"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        class="text-nc-gold"
      >
        <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
      </svg>
      <p class="text-base font-bold">Video drop karo</p>
      <p class="text-[11px] text-nc-mut">
        5 GB · 2 ghante · 4K 60FPS · FFmpeg audio nikalega, transcript cloud pe jayega
      </p>
    </div>
  </div>
{/if}
