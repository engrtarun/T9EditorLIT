<script lang="ts" module>
  /**
   * Short ids need words. Anything missing here falls back to the id itself,
   * which is still readable — this map is only for the labels users see most.
   */
  const LABELS: Record<string, string> = {
    shortcuts: "Open keyboard shortcuts",
    undo: "Undo",
    redo: "Redo",
    redoShift: "Redo (alternate)",
    modeCut: "Cut mode (transcript)",
    modePolish: "Polish mode (music & text)",
    modeExport: "Export mode",
    import: "Go to import media",
    export: "Go to export",
    projectName: "Go to project name",
    aspectRatio: "Go to aspect ratio selector",
    help: "Go to help button",
    split: "Split at playhead",
    delete: "Delete selection",
    copy: "Copy",
    paste: "Paste",
    duplicate: "Duplicate",
    selectAll: "Select all items",
    group: "Group selected items",
    ungroup: "Ungroup selected items",
    deselect: "Deselect / close",
    playPause: "Play or pause",
    seekStart: "Seek to start",
    seekEnd: "Seek to end",
    seekBack: "Move seeker backward",
    seekForward: "Move seeker forward",
    seekBackBig: "Move seeker backward (larger)",
    seekForwardBig: "Move seeker forward (larger)",
    volumeUp: "Volume up",
    volumeDown: "Volume down",
    mute: "Mute / unmute",
    captions: "Show captions",
    fullscreen: "Full screen preview",
    zoomIn: "Zoom timeline in",
    zoomOut: "Zoom timeline out",
    zoomFit: "Fit timeline",
    navRail: "Go to sidebar navigation",
    navSidebar: "Go to sidebar",
    navTimeline: "Go to timeline",
    navStage: "Go to stage",
    navPanel: "Go to property panel",
  };

  function labelFor(id: string): string {
    return LABELS[id] ?? id;
  }
</script>

<script lang="ts">
  /**
   * `Ctrl + /` cheat sheet — the same one Clipchamp opens from its burger
   * menu, with the same grouping and the same accelerator text.
   *
   * Content comes straight from `BINDINGS` in the shortcuts store, so this
   * component cannot list a shortcut the app does not honour, and a new
   * binding appears here without touching this file.
   *
   * Modal behaviour: Escape closes, clicking the scrim closes, and Tab is
   * trapped inside so focus cannot wander off behind the overlay.
   */
  import { BINDINGS, shortcuts } from "../../stores/shortcuts.svelte";

  function close(): void {
    shortcuts.closeSheet();
  }

  // Trap Tab inside the dialog, the way a Fluent Dialog does.
  let dialog: HTMLElement | null = $state(null);

  function trapTab(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Focus the close button on mount so the dialog has a sensible start point.
  let closeButton: HTMLButtonElement | null = $state(null);
  $effect(() => {
    closeButton?.focus();
  });
</script>

<!-- Scrim: click anywhere outside the panel to dismiss. -->
<div
  class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
  role="presentation"
  onpointerdown={close}
>
  <!-- Panel: stop propagation so a click inside does not reach the scrim. -->
  <div
    bind:this={dialog}
    class="flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-cc-line
      bg-cc-menu shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
    style="animation: cc-menu-in 140ms cubic-bezier(0.1, 0.9, 0.2, 1)"
    onpointerdown={(e) => e.stopPropagation()}
    onkeydown={trapTab}
  >
    <header class="flex items-center justify-between border-b border-cc-line px-5 py-3.5">
      <div class="flex flex-col gap-0.5">
        <h2 class="text-[15px] font-semibold text-cc-text">Keyboard shortcuts</h2>
        <p class="text-[11.5px] text-cc-text-3">
          {shortcuts.count} shortcuts — the same keys Clipchamp uses
        </p>
      </div>
      <button
        bind:this={closeButton}
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-3 hover:bg-cc-tint
          hover:text-cc-text"
        aria-label="Close"
        onclick={close}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </header>

    <div
      class="grid max-h-[62vh] grid-cols-1 gap-x-8 gap-y-6 overflow-y-auto px-5 py-4 sm:grid-cols-2"
    >
      {#each BINDINGS as group (group.title)}
        <section>
          <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-cc-text-4">
            {group.title}
          </h3>
          <ul class="flex flex-col gap-0.5">
            {#each group.items as item (item.id)}
              <li
                class="flex items-center justify-between gap-3 rounded px-2 py-1.5
                  hover:bg-cc-tint/50"
              >
                <span class="text-[12.5px] text-cc-text-2">{labelFor(item.id)}</span>
                <!-- One chip per key: Clipchamp renders the accelerator as
                     separate key caps rather than a run of text. -->
                <span class="flex shrink-0 items-center gap-1">
                  {#each item.combo.split(" + ") as part, i (i)}
                    {#if i > 0}
                      <span class="text-[10px] text-cc-text-4">+</span>
                    {/if}
                    <kbd
                      class="mono rounded border border-cc-line bg-cc-sunken px-1.5 py-0.5
                        text-[10.5px] font-medium text-cc-text-2"
                    >
                      {part}
                    </kbd>
                  {/each}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>

    <footer class="flex items-center border-t border-cc-line px-5 py-3">
      <button type="button" class="cc-btn cc-btn-primary ml-auto" onclick={close}> Got it </button>
    </footer>
  </div>
</div>
