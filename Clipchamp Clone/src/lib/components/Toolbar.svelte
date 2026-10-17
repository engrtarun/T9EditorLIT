<script lang="ts">
  import { editor, type EditorMode } from "$lib/editor.svelte";
  import { ASPECT_PRESETS, type ExportSettings } from "$lib/types";

  const MODES: ReadonlyArray<{ id: EditorMode; label: string }> = [
    { id: "edit", label: "Edit" },
    { id: "captions", label: "Captions" },
    { id: "export", label: "Export" },
  ];

  function setResolution(e: ExportSettings) {
    editor.exportSettings = e;
  }
</script>

<header class="flex h-12 shrink-0 items-center gap-3 border-b border-panel-border bg-panel px-3">
  <div class="flex items-center gap-2">
    <span class="text-sm font-semibold tracking-tight">Clipchamp Clone</span>
    <span class="rounded bg-panel-raised px-1.5 py-0.5 text-[10px] text-zinc-400">scaffold</span>
  </div>

  <!-- Mode switch. {#key} in +page.svelte remounts the panel tree on change. -->
  <nav class="ml-2 flex gap-0.5 rounded-lg bg-panel-raised p-0.5" aria-label="Editor mode">
    {#each MODES as m (m.id)}
      <button
        type="button"
        class="rounded-md px-3 py-1 text-xs transition-colors
               {editor.mode === m.id
          ? 'bg-accent text-zinc-950 font-medium'
          : 'text-zinc-400 hover:text-zinc-100'}"
        aria-current={editor.mode === m.id}
        onclick={() => (editor.mode = m.id)}
      >
        {m.label}
      </button>
    {/each}
  </nav>

  <div class="ml-auto flex items-center gap-1">
    <button
      type="button"
      class="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-panel-raised disabled:opacity-40"
      disabled={!editor.canUndo}
      onclick={() => editor.undo()}
      title="Undo (Ctrl+Z)"
    >
      Undo
    </button>
    <button
      type="button"
      class="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-panel-raised disabled:opacity-40"
      disabled={!editor.canRedo}
      onclick={() => editor.redo()}
      title="Redo (Ctrl+Shift+Z)"
    >
      Redo
    </button>

    <div class="mx-2 h-5 w-px bg-panel-border"></div>

    <label class="flex items-center gap-1.5 text-xs text-zinc-400">
      Canvas
      <select
        class="rounded-md border border-panel-border bg-panel-raised px-1.5 py-1 text-xs text-zinc-100"
        value={`${editor.exportSettings.width}x${editor.exportSettings.height}`}
        onchange={(e) => {
          const found = ASPECT_PRESETS.find(
            (p) => `${p.width}x${p.height}` === e.currentTarget.value,
          );
          if (found)
            setResolution({ ...editor.exportSettings, width: found.width, height: found.height });
        }}
      >
        {#each ASPECT_PRESETS as p (p.label)}
          <option value={`${p.width}x${p.height}`}>{p.label} — {p.width}×{p.height}</option>
        {/each}
      </select>
    </label>
  </div>
</header>
