<script lang="ts">
  /**
   * One project card on the dashboard.
   *
   * The hover is deliberately small — the card lifts 2 px, the border brightens
   * and the "more" button appears. The thumbnail itself never moves, because a
   * thumbnail that jumps under the cursor reads as a glitch, not as feedback.
   */
  import { ago, fmtBytes, fmtDuration, type ProjectCard } from '../../dashboard';

  let {
    card,
    index = 0,
    renaming = false,
    onopen,
    onmenu,
    onrenamechange,
    onrenamecommit,
    onrenamecancel,
    onpostererror,
    onpreviewerror
  }: {
    card: ProjectCard;
    index?: number;
    renaming?: boolean;
    onopen: () => void;
    onmenu: (e: MouseEvent) => void;
    onrenamechange: (value: string) => void;
    onrenamecommit: () => void;
    onrenamecancel: () => void;
    /** The cached still could not be shown — fall back to the video. */
    onpostererror: () => void;
    /** The fallback stream itself failed — the source file is really gone. */
    onpreviewerror: () => void;
  } = $props();

  const p = $derived(card.project);
  /** The stagger stops after a few cards — nobody should wait for the last one. */
  const step = $derived(Math.min(index, 8));
</script>

<li class="t9-card-in" style="--i:{step}">
  <div
    role="button"
    tabindex="0"
    aria-label="{p.name}, {fmtDuration(p.durationSecs)}"
    onclick={onopen}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onopen();
      }
    }}
    class="group cursor-pointer rounded-xl outline-none transition-transform duration-150 ease-out
           hover:-translate-y-0.5 focus-visible:-translate-y-0.5"
  >
    <!-- thumbnail -->
    <div
      class="relative aspect-video overflow-hidden rounded-lg border border-nc-line bg-nc-panel
             transition-colors duration-150 group-hover:border-nc-line-2"
    >
      {#if card.missing}
        <!--
          The source file is gone — no still can be made and no ghost stream
          is attempted. The record stays (its transcript is still openable),
          and the tile says what happened instead of rendering a black box.
        -->
        <div
          class="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-nc-line bg-transparent text-nc-mut"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="6" width="13" height="12" rx="2" />
            <path d="M16 10.5l5-3v9l-5-3" />
            <path d="M3 3l18 18" />
          </svg>
          <span class="text-[12px] font-medium">File missing</span>
          <span class="text-[10.5px] text-nc-mut-2">Source gayab — transcript safe hai</span>
        </div>
      {:else if card.posterUrl}
        <img
          src={card.posterUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onerror={onpostererror}
          class="h-full w-full object-cover"
        />
      {:else if card.previewUrl}
        <!--
          No still on disk — stream the file instead and let the player show a
          frame. `preload="metadata"` keeps the file out of the heap: only the
          header is read, the video is never buffered whole.
        -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={card.previewUrl}
          muted
          playsinline
          preload="metadata"
          onerror={onpreviewerror}
          onloadedmetadata={(e) => {
            const v = e.currentTarget;
            // A frame a little into the clip beats a black first frame.
            if (v.duration && v.duration > 3) v.currentTime = Math.min(5, v.duration / 4);
          }}
          class="h-full w-full object-cover"
        ></video>
      {:else}
        <div class="grid h-full w-full place-items-center text-nc-mut-2">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" />
          </svg>
        </div>
      {/if}

      <!-- duration -->
      <span
        class="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] text-white/90"
      >
        {fmtDuration(p.durationSecs)}
      </span>

      <!-- more options — only when the card is under the cursor -->
      <button
        onclick={(e) => {
          e.stopPropagation();
          onmenu(e);
        }}
        class="absolute top-1.5 right-1.5 grid h-6 w-6 place-items-center rounded bg-black/70 text-white
               opacity-0 transition-opacity duration-150 hover:bg-nc-panel-2
               group-hover:opacity-100 focus-visible:opacity-100"
        title="More options"
        aria-label="More options for {p.name}"
        aria-haspopup="menu"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle
            cx="19"
            cy="12"
            r="1.6"
          />
        </svg>
      </button>

      {#if card.opening}
        <div class="absolute inset-0 grid place-items-center bg-black/55">
          <span class="t9-spin h-5 w-5 rounded-full border-2 border-white/30 border-t-white"></span>
        </div>
      {/if}
    </div>

    <!-- title + meta -->
    <div class="mt-2">
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          value={card.project.name}
          oninput={(e) => onrenamechange(e.currentTarget.value)}
          onblur={onrenamecommit}
          onkeydown={(e) => {
            if (e.key === 'Enter') onrenamecommit();
            if (e.key === 'Escape') onrenamecancel();
          }}
          onclick={(e) => e.stopPropagation()}
          class="w-full rounded border border-nc-brand bg-nc-bg px-1.5 py-0.5 text-[13px] text-nc-txt outline-none"
        />
      {:else}
        <div class="truncate text-[13px] font-medium text-nc-txt" title={p.name}>
          {p.name}
        </div>
      {/if}
      <div class="mt-0.5 truncate text-[11px] text-nc-mut-2">
        Edited {ago(p.lastOpened)}
        {#if card.missing}
          <span class="text-nc-mut-2/70"> · </span>File missing
        {:else if card.sizeBytes > 0}
          <span class="text-nc-mut-2/70"> · </span>{fmtBytes(card.sizeBytes)}
        {/if}
      </div>
    </div>
  </div>
</li>
