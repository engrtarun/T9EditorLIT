<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import { formatTimecode } from "$lib/timeline";

  function fmtBytes(n: number): string {
    if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
    return `${Math.round(n / 1024)} KB`;
  }

  const KIND_ICON: Record<string, string> = {
    video: "▶",
    audio: "♪",
    image: "▣",
  };
</script>

<!--
  Media bin. Holds paths and metadata only — never decodes or previews media
  inline, which is what keeps the app inside the zero-RAM budget.
-->
<aside class="flex w-64 shrink-0 flex-col border-r border-panel-border bg-panel">
  <div class="flex h-9 shrink-0 items-center justify-between border-b border-panel-border px-3">
    <h2 class="text-xs font-medium text-zinc-300">Media</h2>
    <span class="text-[10px] text-zinc-500">{editor.assets.length}</span>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-2">
    {#if editor.assets.length === 0}
      <p class="mt-6 px-2 text-center text-xs leading-relaxed text-zinc-500">
        No media yet.<br />
        Drop files here, or add one from the Rust side.
      </p>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each editor.assets as asset (asset.id)}
          {@const active = editor.selectedAssetId === asset.id}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors
                     {active ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-panel-raised'}"
              onclick={() => (editor.selectedAssetId = asset.id)}
              ondblclick={() => {
                const track = editor.tracks.find(
                  (t) => t.kind === (asset.kind === "audio" ? "audio" : "video"),
                );
                if (track) editor.addClip(asset.id, track.id);
              }}
            >
              <span
                class="grid size-7 shrink-0 place-items-center rounded bg-panel-raised text-xs text-zinc-400"
                aria-hidden="true">{KIND_ICON[asset.kind] ?? "?"}</span
              >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs text-zinc-100"
                  >{asset.path.split(/[\\/]/).pop()}</span
                >
                <span class="block text-[10px] text-zinc-500">
                  {formatTimecode(asset.durationSecs)} · {fmtBytes(asset.sizeBytes)}
                  {#if asset.width && asset.height}
                    · {asset.width}×{asset.height}
                  {/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Track stack: one clip goes to the first compatible track. -->
  <div class="shrink-0 border-t border-panel-border p-2">
    <div class="mb-1.5 flex items-center justify-between">
      <h3 class="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">Tracks</h3>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded border border-panel-border px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-panel-raised"
          onclick={() => editor.addTrack("video")}
          title="Add video track">+V</button
        >
        <button
          type="button"
          class="rounded border border-panel-border px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-panel-raised"
          onclick={() => editor.addTrack("audio")}
          title="Add audio track">+A</button
        >
        <button
          type="button"
          class="rounded border border-panel-border px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-panel-raised"
          onclick={() => editor.addTrack("overlay")}
          title="Add overlay track">+O</button
        >
      </div>
    </div>

    {#if editor.tracks.length === 0}
      <p class="py-1 text-center text-[10px] text-zinc-600">No tracks yet</p>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each editor.tracks as track (track.id)}
          <li class="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-400">
            <span class="size-1.5 rounded-full bg-zinc-600" aria-hidden="true"></span>
            <span class="min-w-0 flex-1 truncate">{track.name}</span>
            <span class="text-[10px] text-zinc-600">{editor.clipsOn(track.id).length}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</aside>
