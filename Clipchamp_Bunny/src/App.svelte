<script lang="ts">
  import TopBar from './lib/components/TopBar.svelte';
  import ModeRail from './lib/components/ModeRail.svelte';
  import RightRail from './lib/components/RightRail.svelte';
  import DropOverlay from './lib/components/DropOverlay.svelte';
  import ShortcutsHelp from './lib/components/ShortcutsHelp.svelte';
  import IngestMode from './lib/components/modes/IngestMode.svelte';
  import CutMode from './lib/components/modes/CutMode.svelte';
  import PolishMode from './lib/components/modes/PolishMode.svelte';
  import ExportMode from './lib/components/modes/ExportMode.svelte';
  import { mode } from './lib/stores/mode.svelte';
  import { player } from './lib/stores/player.svelte';
  import { project } from './lib/stores/project.svelte';
  import { layout } from './lib/stores/layout.svelte';
  import { clamp } from './lib/utils';

  /**
   * Clipchamp's full shortcut set, mapped onto the transcript editor.
   * Chords: `Z`/`C` then an arrow (Clipchamp-exact trim). `Shift+X` then an
   * arrow moves the line — plain `X` is our instant cut, so it cannot be a
   * prefix without adding latency to the most-used key.
   */
  let chord: 'z' | 'c' | 'x' | null = null;
  let chordTimer: ReturnType<typeof setTimeout> | undefined;

  function setChord(c: 'z' | 'c' | 'x') {
    chord = c;
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => (chord = null), 1500);
  }

  function zoom(dir: 1 | -1) {
    player.zoom = clamp(player.zoom * (dir === 1 ? 1.4 : 1 / 1.4), 4, 220);
  }

  function zoomFit() {
    const el = document.querySelector('[data-focus="timeline"]');
    const w = el?.clientWidth ?? 1200;
    player.zoom = clamp(w / Math.max(project.durationSec, 1), 4, 220);
  }

  function focusArea(area: 'rail' | 'panel' | 'timeline' | 'stage' | 'header') {
    layout.focus = area;
    const el = document.querySelector<HTMLElement>(`[data-focus="${area}"]`);
    el?.focus();
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (layout.helpOpen && e.key !== 'Escape') return;

    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const inCut = mode.current === 'cut';

    // ---- chord continuation: Z / C / Shift+X then an arrow
    if (chord && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const amount = shift ? 5 : 1;
      if (chord === 'z') project.trimStart(dir * amount * 0.25);
      else if (chord === 'c') project.trimEnd(dir * amount * 0.25);
      else project.moveCurrent(dir);
      chord = null;
      clearTimeout(chordTimer);
      return;
    }
    chord = null;

    // ---- Ctrl combos
    if (mod) {
      if (alt) {
        if (k === '2') {
          e.preventDefault();
          layout.sourcePanelCollapsed = !layout.sourcePanelCollapsed;
          return;
        }
        if (k === '3') {
          e.preventDefault();
          layout.timelineCollapsed = !layout.timelineCollapsed;
          return;
        }
        if (k === 'f') {
          e.preventDefault();
          layout.toggleBoth();
          return;
        }
      }
      switch (k) {
        case 'z':
          e.preventDefault();
          shift ? project.redo() : project.undo();
          return;
        case 'y':
          e.preventDefault();
          project.redo();
          return;
        case 'a':
          e.preventDefault();
          project.selectAll();
          return;
        case 'c':
          e.preventDefault();
          project.copyCurrent();
          return;
        case 'v':
          e.preventDefault();
          project.pasteAfterCurrent();
          return;
        case 'd':
          e.preventDefault();
          project.duplicateCurrent();
          return;
        case 'g':
          e.preventDefault();
          shift ? project.ungroupSelected() : project.groupSelected();
          return;
        case '/':
          e.preventDefault();
          layout.helpOpen = !layout.helpOpen;
          return;
        case '=':
        case '+':
          e.preventDefault();
          zoom(1);
          return;
        case '-':
          e.preventDefault();
          zoom(-1);
          return;
        case '0':
          e.preventDefault();
          zoomFit();
          return;
        case 'arrowleft':
          e.preventDefault();
          player.seek(0);
          return;
        case 'arrowright':
          e.preventDefault();
          player.seek(project.durationSec);
          return;
      }
      return;
    }

    // ---- Alt navigation
    if (alt) {
      e.preventDefault();
      switch (k) {
        case '1':
          focusArea('rail');
          return;
        case '2':
          focusArea('panel');
          return;
        case '3':
          focusArea('timeline');
          return;
        case '4':
          focusArea('stage');
          return;
        case '5':
        case 'n':
          focusArea('header');
          return;
        case 'i':
          window.dispatchEvent(new CustomEvent('t9:import'));
          return;
        case 'e':
          mode.set('export');
          return;
        case 'r':
          focusArea('stage');
          return;
        case 'h':
          layout.helpOpen = true;
          return;
      }
      return;
    }

    // ---- single keys
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        project.deselectAll();
        return;
      case ' ':
      case 'k':
        e.preventDefault();
        if (inCut) player.toggle();
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        project.cutTargets();
        project.step(1);
        return;
      case 'Enter':
        e.preventDefault();
        {
          const cur = project.lines[project.cursor];
          if (cur) project.setLine(cur.id, 'keep');
        }
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (inCut) {
          const line = project.step(-1);
          if (line) player.seek(line.startSec);
        }
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (inCut) {
          const line = project.step(1);
          if (line) player.seek(line.startSec);
        }
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (inCut) player.nudge(shift ? -1 : -1 / 30);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (inCut) player.nudge(shift ? 1 : 1 / 30);
        return;
    }

    switch (k) {
      case 'x':
        e.preventDefault();
        if (shift) {
          setChord('x');
        } else if (inCut) {
          // our instant cut — the one-hand flow
          const line = project.lines[project.cursor];
          if (line) project.toggleLine(line.id);
          project.step(1);
        }
        return;
      case 'v':
        e.preventDefault();
        if (inCut) {
          const line = project.lines[project.cursor];
          if (line) project.setLine(line.id, 'keep');
          project.step(1);
        }
        return;
      case 'z':
        e.preventDefault();
        setChord('z');
        return;
      case 'c':
        e.preventDefault();
        setChord('c');
        return;
      case 's':
      case 'b':
        e.preventDefault();
        project.splitAt(player.currentTime);
        return;
      case 'j':
        e.preventDefault();
        player.seek(clamp(player.currentTime - 5, 0, project.durationSec));
        return;
      case 'l':
        e.preventDefault();
        player.seek(clamp(player.currentTime + 5, 0, project.durationSec));
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

<DropOverlay />
<ShortcutsHelp />
