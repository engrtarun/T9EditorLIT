<script lang="ts">
  import { project } from '../stores/project.svelte';
  import { player } from '../stores/player.svelte';
  import { mode } from '../stores/mode.svelte';
  import { menu } from '../stores/menu.svelte';
  import { i18n } from '../stores/i18n.svelte';
  import { FRAMES, type ProjectFrame } from '../project-frame';

  /**
   * The Size pill is live: the ratio the project plays in and exports at,
   * using the exact `FRAMES` table "Create New Project" reads — one shared
   * list, no second set of magic numbers. The popup is the app's own root
   * menu, so click-away and keyboard come free.
   */
  function openSize(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.show(
      FRAMES.map((f) => ({
        id: f.id,
        label: `${project.frame === f.id ? '✓ ' : ''}${i18n.t(f.label)}`,
        secondary: f.canvas ? `${f.canvas[0]} × ${f.canvas[1]}` : 'source size'
      })),
      Math.round(r.left),
      Math.round(r.bottom + 6),
      (id) => project.setFrame(id as ProjectFrame)
    );
  }
</script>

<!-- PREVIEW BAR — three-column grid so the Size group sits DEAD CENTER:
     left (undo/redo) | centre (Size + Loop) | right (Share + Export). The
     old twin `flex-1` spacers only balanced when both sides were the same
     width — Share + Export are wider, so the pill drifted left.

     No strip: Clipchamp has no panel or rule under the top bar — these
     controls float on the editor's own background (its toolbar row and the
     preview share one surface). The `bg-nc-panel border-b` used to draw a
     full-width band across every panel below it, which is exactly the bar
     Clipchamp does not have, so it is gone; only the spacing row remains. -->
<div class="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 select-none">
  <div class="flex items-center gap-2">
    <button
      onclick={() => project.undo()}
      disabled={project.past.length === 0}
      class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
      title="Undo (Ctrl+Z)"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" />
      </svg>
    </button>
    <button
      onclick={() => project.redo()}
      disabled={project.future.length === 0}
      class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
      title="Redo (Ctrl+Y)"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" />
      </svg>
    </button>
  </div>

  <!-- Size / display group (Clipchamp pill) — Size changes the project's
       canvas (the FRAMES presets, shown on the button), Loop replays the
       project from its first kept second. The dead background-image and
       gradient/colour buttons are gone — the gradient one on request. -->
  <div class="flex items-center gap-1 rounded-lg border border-nc-line bg-nc-panel-2 px-1.5 py-1">
    <button
      onclick={openSize}
      aria-haspopup="menu"
      class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] hover:bg-nc-line"
      title="Canvas size — preview aur export dono ishi ratio me nibhate hain"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9v6M17 9v6" />
      </svg>
      Size
      <span class="font-mono text-[11px] text-nc-mut">{project.frame}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>
    <span class="h-4 w-px bg-nc-line"></span>
    <button
      onclick={() => player.toggleLoop()}
      aria-pressed={player.loop}
      class="grid h-6 w-6 place-items-center rounded transition-colors {player.loop
        ? 'bg-nc-brand/15 text-nc-brand'
        : 'text-nc-mut hover:bg-nc-line hover:text-nc-txt'}"
      title={player.loop
        ? 'Loop on — end pe wapas start, playback rukti nahi'
        : 'Loop — playback end pe ruk jati hai'}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path
          d="M7 22l-4-4 4-4"
        /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </svg>
    </button>
  </div>

  <div class="flex items-center justify-end gap-2">
    <button
      class="flex items-center gap-1.5 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1.5 text-[13px] font-medium hover:bg-nc-line"
      title="Share"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle
          cx="18"
          cy="19"
          r="3"
        />
        <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line
          x1="15.4"
          y1="6.5"
          x2="8.6"
          y2="10.5"
        />
      </svg>
      Share
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>

    <button
      onclick={() => mode.set('export')}
      class="flex items-center gap-1.5 rounded-lg bg-nc-brand px-3.5 py-1.5 text-[13px] font-bold text-nc-bg hover:brightness-110"
      title="Export"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
      </svg>
      Export
    </button>
  </div>
</div>
