<script lang="ts">
  import { editor, nextId } from "$lib/editor.svelte";
  import { formatTimecode } from "$lib/timeline";
  import type { CaptionCue } from "$lib/types";

  /** Add a cue at the playhead; speech-to-text later replaces this with a real transcript. */
  function addCue() {
    const cue: CaptionCue = {
      id: nextId("cue"),
      startSecs: editor.playheadSecs,
      endSecs: editor.playheadSecs + 3,
      text: "",
      edited: false,
    };
    editor.captions = [...editor.captions, cue];
  }

  function patch(id: string, p: Partial<CaptionCue>) {
    editor.captions = editor.captions.map((c) => (c.id === id ? { ...c, ...p, edited: true } : c));
  }

  function remove(id: string) {
    editor.captions = editor.captions.filter((c) => c.id !== id);
  }
</script>

<section class="flex min-h-0 flex-1 flex-col bg-panel">
  <div class="flex h-9 shrink-0 items-center gap-3 border-b border-panel-border px-3">
    <h2 class="text-xs font-medium text-zinc-300">Captions</h2>
    <span class="text-[10px] text-zinc-500">{editor.captions.length} cues</span>
    <button
      type="button"
      class="ml-auto rounded border border-panel-border px-2 py-1 text-[10px] text-zinc-400 hover:bg-panel-raised"
      onclick={addCue}
    >
      + Cue at playhead
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-3">
    {#if editor.captions.length === 0}
      <p class="mt-8 text-center text-xs leading-relaxed text-zinc-500">
        No captions yet.<br />
        <span class="text-zinc-600">
          Transcript-backed captions come from the t9cloud Whisper worker.
        </span>
      </p>
    {:else}
      <ul class="flex flex-col gap-1.5">
        {#each editor.captions as cue (cue.id)}
          <li class="grid grid-cols-[92px_1fr_auto] items-start gap-2 rounded bg-panel-raised p-2">
            <span class="font-mono text-[10px] text-zinc-500 tabular-nums">
              {formatTimecode(cue.startSecs)}<br />{formatTimecode(cue.endSecs)}
            </span>
            <textarea
              rows="2"
              placeholder="Caption text…"
              value={cue.text}
              oninput={(e) => patch(cue.id, { text: e.currentTarget.value })}
              class="resize-none rounded bg-black/30 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
            ></textarea>
            <button
              type="button"
              class="text-[10px] text-zinc-600 hover:text-red-400"
              onclick={() => remove(cue.id)}
              aria-label="Delete caption"
            >
              ✕
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
