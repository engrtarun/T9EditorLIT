<script lang="ts">
  import TopBar from './lib/components/TopBar.svelte';
  import ModeRail from './lib/components/ModeRail.svelte';
  import RightRail from './lib/components/RightRail.svelte';
  import IngestMode from './lib/components/modes/IngestMode.svelte';
  import CutMode from './lib/components/modes/CutMode.svelte';
  import PolishMode from './lib/components/modes/PolishMode.svelte';
  import ExportMode from './lib/components/modes/ExportMode.svelte';
  import { mode } from './lib/stores/mode.svelte';
  import { player } from './lib/stores/player.svelte';
  import { project } from './lib/stores/project.svelte';
  import { clamp } from './lib/utils';

  // Universal shortcut layer. Mode-aware so INGEST/EXPORT do not steal X / V.
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod && k === 'z') {
      e.preventDefault();
      e.shiftKey ? project.redo() : project.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      project.redo();
      return;
    }

    if (mode.current === 'cut') {
      // One-hand arcade flow: act, auto-advance, never touch the mouse.
      if (k === 'x' || k === 'delete' || k === 'backspace') {
        e.preventDefault();
        const line = project.lines[project.cursor];
        if (line) project.toggleLine(line.id);
        project.step(1);
        return;
      }
      if (k === 'v' || k === 'enter') {
        e.preventDefault();
        const line = project.lines[project.cursor];
        if (line) project.setLine(line.id, 'keep');
        project.step(1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const line = project.step(1);
        if (line) player.seek(line.startSec);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const line = project.step(-1);
        if (line) player.seek(line.startSec);
        return;
      }
      if (k === 'b' || k === 's' || k === 'c') {
        e.preventDefault();
        project.splitAt(player.currentTime);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        player.nudge(e.shiftKey ? -1 : -1 / 30);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        player.nudge(e.shiftKey ? 1 : 1 / 30);
        return;
      }
      if (k === 'j') {
        e.preventDefault();
        player.seek(clamp(player.currentTime - 5, 0, project.durationSec));
        return;
      }
      if (k === 'l') {
        e.preventDefault();
        player.seek(clamp(player.currentTime + 5, 0, project.durationSec));
        return;
      }
    }

    if (e.key === ' ' || k === 'k') {
      e.preventDefault();
      if (mode.current === 'cut') player.toggle();
      return;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full flex-col bg-nc-bg text-nc-txt">
  <TopBar />

  <!-- Mode isolation: {#key} on the epoch destroys the previous mode's DOM tree,
       so its memory is released instead of being parked by the GC. -->
  {#key mode.epoch}
    <div class="flex min-h-0 flex-1">
      <ModeRail />

      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        {#if mode.current === 'ingest'}
          <IngestMode />
        {:else if mode.current === 'cut'}
          <CutMode />
        {:else if mode.current === 'polish'}
          <PolishMode />
        {:else}
          <ExportMode />
        {/if}
      </main>

      <RightRail />
    </div>
  {/key}
</div>
