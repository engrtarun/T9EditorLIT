<script lang="ts">
  import { project } from '../stores/project.svelte';
  import { player } from '../stores/player.svelte';
  import { fmtHuman } from '../utils';

  const pct = $derived(project.durationSec ? (project.cutSec / project.durationSec) * 100 : 0);
</script>

<!-- TOP BAR — structure copied 1:1 from Clipchamp (measured on the OBS capture):
     launcher · logo · project dropdown · cloud toggle  |  right: chip · gear · help · avatar -->
<header
  class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel pr-2 pl-1.5 select-none"
>
  <!-- app launcher (9 dots) -->
  <button
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Apps"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="3" r="1.4" /><circle cx="8" cy="3" r="1.4" /><circle
        cx="13"
        cy="3"
        r="1.4"
      />
      <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle
        cx="13"
        cy="8"
        r="1.4"
      />
      <circle cx="3" cy="13" r="1.4" /><circle cx="8" cy="13" r="1.4" /><circle
        cx="13"
        cy="13"
        r="1.4"
      />
    </svg>
  </button>

  <!-- brand -->
  <div class="flex items-center gap-1.5 pl-0.5">
    <span
      class="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-nc-gold to-nc-gold-dim text-[13px] font-black text-nc-bg"
      >7</span
    >
    <span class="text-[13px] font-semibold tracking-tight">Nanami Cut</span>
  </div>

  <!-- project dropdown -->
  <button
    class="ml-1 flex items-center gap-1.5 rounded-md bg-nc-panel-2 px-2.5 py-1 text-[13px] font-medium hover:bg-nc-line"
    title="Project"
  >
    <span class="max-w-[190px] truncate">{project.name}</span>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
      <path d="M7 10l5 5 5-5z" />
    </svg>
  </button>

  <!-- cloud / local toggle -->
  <button
    class="grid h-8 w-8 place-items-center rounded-md border border-nc-line text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Cloud / local save"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
    >
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.6 4 4 0 0 0 7 17.9" />
      <path d="M12 12v9M9 15l3-3 3 3" />
    </svg>
  </button>

  <div class="flex-1"></div>

  <!-- Overtime Saved — our one deliberate addition to Clipchamp's top bar.
       Kept small so it does not fight the Clipchamp visual rhythm. -->
  <div
    class="mr-1 flex items-center gap-1.5 rounded-md bg-nc-gold/10 px-2 py-1 text-[11px] font-semibold text-nc-gold"
    title="Raw {fmtHuman(project.durationSec)} → Final {fmtHuman(project.keptSec)} · {fmtHuman(
      project.cutSec
    )} bach gaya"
  >
    🔥 {fmtHuman(project.cutSec)}
    <span class="h-1.5 w-14 overflow-hidden rounded-full bg-nc-line">
      <span
        class="block h-full rounded-full bg-gradient-to-r from-nc-gold to-nc-red transition-[width] duration-300"
        style="width:{Math.min(100, Math.max(0, pct))}%"
      ></span>
    </span>
  </div>

  <!-- settings -->
  <button
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Settings"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 3a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      />
    </svg>
  </button>

  <!-- help -->
  <button
    class="grid h-8 w-8 place-items-center rounded-md text-[15px] font-medium text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Help · shortcuts"
  >
    ?
  </button>

  <!-- avatar -->
  <div
    class="ml-0.5 grid h-7 w-7 place-items-center rounded-full border border-nc-line-2 bg-gradient-to-br from-nc-panel-2 to-nc-line text-[10px] font-bold text-nc-mut"
  >
    TD
  </div>
</header>
