<script lang="ts">
  import TopBar from './lib/components/TopBar.svelte';
  import ModeRail from './lib/components/ModeRail.svelte';
  import RightRail from './lib/components/RightRail.svelte';
  import DropOverlay from './lib/components/DropOverlay.svelte';
  import ShortcutsHelp from './lib/components/ShortcutsHelp.svelte';
  import SettingsPanel from './lib/components/SettingsPanel.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import ContextMenu from './lib/components/ContextMenu.svelte';
  import CutMode from './lib/components/modes/CutMode.svelte';
  import ExportMode from './lib/components/modes/ExportMode.svelte';
  import HomeDashboard from './lib/components/dashboard/HomeDashboard.svelte';
  import BrowserView from './lib/components/browser/BrowserView.svelte';
  import BackgroundVideo from './lib/components/BackgroundVideo.svelte';
  import { mode } from './lib/stores/mode.svelte';
  import { app } from './lib/stores/app.svelte';
  import { player } from './lib/stores/player.svelte';
  import { project } from './lib/stores/project.svelte';
  import { layout } from './lib/stores/layout.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import { toast } from './lib/stores/toast.svelte';
  import { menu } from './lib/stores/menu.svelte';
  import { keys, type KeyAction } from './lib/stores/keys.svelte';
  import { clamp, fmtTime } from './lib/utils';

  /**
   * Every key binding comes from the `keys` store, so the user can rebind any
   * of them (shortcut sheet → Customize) and the map survives a restart.
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
    // The lane is drawn on the timeline axis (cut blocks included), so zoom
    // must fit the strip, not just the kept seconds.
    const span = project.timelineDuration || project.sequenceDuration || 1;
    player.zoom = clamp(w / Math.max(span, 1), 4, 220);
  }

  function focusArea(area: 'rail' | 'panel' | 'timeline' | 'stage' | 'header') {
    layout.focus = area;
    document.querySelector<HTMLElement>(`[data-focus="${area}"]`)?.focus();
  }

  function hit(action: KeyAction, e: KeyboardEvent): boolean {
    if (!keys.matches(action, e)) return false;
    e.preventDefault();
    return true;
  }

  function onKey(e: KeyboardEvent) {
    // System shortcuts & screenshot keys must never be captured or blocked:
    // PrintScreen, Snapshot, F1-F12, and any Meta / Windows key chord (e.g. Win+Shift+S).
    if (e.key === 'PrintScreen' || e.key === 'Snapshot' || e.metaKey || e.key.startsWith('F')) {
      return;
    }

    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // The profile popover owns the keyboard while it is open — including its
    // own Escape. Nothing here may steal an Arrow key from it.
    if (layout.profileOpen) return;
    if (layout.helpOpen && e.key !== 'Escape') return;
    if (layout.settingsOpen && e.key !== 'Escape') return;
    if (layout.settingsOpen && e.key === 'Escape') {
      layout.settingsOpen = false;
      e.preventDefault();
      return;
    }

    // On the **dashboard** or in the **browser** the editor's shortcuts have
    // nothing to act on — only the shortcut sheet still makes sense there.
    if (app.view !== 'editor') {
      if (hit('help', e)) {
        layout.helpOpen = !layout.helpOpen;
        return;
      }
      return;
    }

    const inCut = mode.current === 'cut';
    const shift = e.shiftKey;

    // ---- chord continuation: Z / C / Shift+X then an arrow
    if (chord && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const amount = e.shiftKey ? 5 : 1;
      if (chord === 'z') project.trimStart(dir * amount * 0.25);
      else if (chord === 'c') project.trimEnd(dir * amount * 0.25);
      else project.moveCurrent(dir);
      chord = null;
      clearTimeout(chordTimer);
      return;
    }
    chord = null;

    // ---- rebindable actions
    if (hit('undo', e)) {
      e.shiftKey ? project.redo() : project.undo();
      return;
    }
    if (hit('redo', e)) {
      project.redo();
      return;
    }
    if (hit('copy', e)) {
      project.copyCurrent();
      return;
    }
    if (hit('paste', e)) {
      project.pasteAfterCurrent();
      return;
    }
    if (hit('duplicate', e)) {
      project.duplicateCurrent();
      return;
    }
    if (hit('selectAll', e)) {
      project.selectAll();
      return;
    }
    if (hit('deselect', e)) {
      project.deselectAll();
      return;
    }
    if (hit('group', e)) {
      e.shiftKey ? project.ungroupSelected() : project.groupSelected();
      return;
    }
    if (hit('zoomIn', e)) {
      zoom(1);
      return;
    }
    if (hit('zoomOut', e)) {
      zoom(-1);
      return;
    }
    if (hit('zoomFit', e)) {
      zoomFit();
      return;
    }
    // An extra clip has no transcript: playback and seeking still work, but
    // every transcript edit key must do nothing while one is being previewed.
    const onExtra = inCut && !!project.activeClip;

    if (hit('cutHere', e)) {
      if (onExtra) {
        toast.push('info', 'Extra clip me transcript nahi hai — cut sirf main clip me hota hai');
        return;
      }
      if (project.cutAtPlayhead(player.currentTime)) {
        player.seek(project.snapTime(player.currentTime));
        toast.push('cut', `✂ Cut here · ${fmtTime(player.currentTime)}`);
      } else {
        toast.push('warn', 'Yahan playhead line ke andar nahi hai');
      }
      return;
    }
    if (hit('help', e)) {
      layout.helpOpen = !layout.helpOpen;
      return;
    }

    // ---- non-rebindable navigation (Alt + n)
    if (e.altKey) {
      switch (e.key.toLowerCase()) {
        case '1':
          e.preventDefault();
          focusArea('rail');
          return;
        case '2':
          e.preventDefault();
          focusArea('panel');
          return;
        case '3':
          e.preventDefault();
          focusArea('timeline');
          return;
        case '4':
          e.preventDefault();
          focusArea('stage');
          return;
        case '5':
        case 'n':
          e.preventDefault();
          focusArea('header');
          return;
        case 'i':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('t9:import'));
          return;
        case 'e':
          e.preventDefault();
          mode.set('export');
          return;
        case 'r':
          e.preventDefault();
          focusArea('stage');
          return;
        case 'h':
          e.preventDefault();
          layout.helpOpen = true;
          return;
      }
      return;
    }

    if (hit('playPause', e)) {
      if (inCut) player.toggle();
      return;
    }
    if (hit('delete', e)) {
      if (onExtra) return;
      const n = project.targets().length;
      project.cutTargets();
      project.step(1);
      toast.push('cut', n > 1 ? `✕ ${n} lines cut` : '✕ Cut');
      return;
    }
    if (hit('seekBack', e)) {
      const step = -settings.seekStepSec;
      const clip = project.activeClip;
      player.seek(
        clip
          ? Math.max(clip.inSec, player.currentTime + step)
          : project.skipBy(player.currentTime, step)
      );
      return;
    }
    if (hit('seekForward', e)) {
      const step = settings.seekStepSec;
      const clip = project.activeClip;
      player.seek(
        clip
          ? Math.min(clip.outSec, player.currentTime + step)
          : project.skipBy(player.currentTime, step)
      );
      return;
    }
    if (hit('nextLine', e)) {
      if (!inCut || onExtra) return;
      const line = project.step(1);
      if (line) player.seek(line.startSec);
      return;
    }
    if (hit('prevLine', e)) {
      if (!inCut || onExtra) return;
      const line = project.step(-1);
      if (line) player.seek(line.startSec);
      return;
    }
    if (hit('split', e)) {
      // An extra clip splits into two clips of its own. The old guard skipped
      // the shortcut entirely, so pressing S on a dropped clip did nothing.
      const clip = project.activeClip;
      if (clip) {
        if (project.splitClipAt(clip.id, player.currentTime)) {
          toast.push('split', 'Clip split — ab do clips hain');
        } else {
          toast.push('warn', 'Split nahi hua — clip ke beech me rakho');
        }
        return;
      }
      if (onExtra) return;
      if (project.splitAt(player.currentTime)) {
        player.seek(project.snapTime(player.currentTime));
        toast.push('split', `✂ Split at ${fmtTime(player.currentTime)}`);
      } else {
        toast.push('warn', '✂ Split nahi hua — line bahut chhoti hai');
      }
      return;
    }
    if (hit('cut', e)) {
      if (!inCut || onExtra) return;
      const line = project.lines[project.cursor];
      if (line) {
        project.toggleLine(line.id);
        toast.push('cut', line.keep === 'cut' ? '✓ Kept' : '✕ Cut');
      }
      project.step(1);
      return;
    }
    if (hit('keep', e)) {
      if (!inCut || onExtra) return;
      const line = project.lines[project.cursor];
      if (line) {
        project.setLine(line.id, 'keep');
        toast.push('keep', '✓ Kept');
      }
      project.step(1);
      return;
    }

    // Shift+X then an arrow moves the line
    if (!onExtra && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      setChord('x');
      return;
    }
    // Z / C then an arrow trims the start / end of the line (plain un-modified keys only)
    if (!onExtra && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setChord('z');
        return;
      }
      if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setChord('c');
        return;
      }
    }

    // Arrow keys move the seeker one frame
    if (e.key === 'ArrowLeft' && inCut) {
      e.preventDefault();
      player.nudge(shift ? -1 : -1 / 30);
    } else if (e.key === 'ArrowRight' && inCut) {
      e.preventDefault();
      player.nudge(shift ? 1 : 1 / 30);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!--
  The background video is a fixed layer BEHIND the whole interface — the root
  wrapper stays transparent on purpose so the footage shows through, while
  every panel keeps painting its own surface (that is what Panel Appearance
  controls). `body` keeps the brand background as the fallback when the video
  is missing.
-->
<BackgroundVideo />

<div class="flex h-full flex-col text-nc-txt">
  <!--
    Two screens, one of them mounted at a time.

    `home` is the dashboard — the screen the app opens on, from the taskbar
    icon or the desktop shortcut. `editor` is the working surface. The `{#if}`
    is a real teardown: the dashboard's DOM is destroyed the moment the editor
    takes over, so the two never share a heap (the zero-RAM rule).
  -->
  {#if app.view === 'home'}
    <HomeDashboard />
  {:else if app.view === 'browser'}
    <!--
      The browser keeps the same header (window controls, meters, the + that
      opened it) and swaps the editor body for the browser chrome. Its own
      `{#if}` branch means entering/leaving the browser also tears down the
      previous tree — same zero-RAM rule as the editor modes.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      <TopBar />
      <BrowserView />
    </div>
  {:else}
    <!-- The editor slides in by a hair when the dashboard hands over. -->
    <div class="t9-slide-in flex min-h-0 flex-1 flex-col">
      <TopBar />

      <!-- Mode isolation: {#key} on the epoch destroys the previous mode's DOM tree,
           so its memory is released instead of being parked by the GC. -->
      {#key mode.epoch}
        <div class="flex min-h-0 flex-1">
          <ModeRail />

          <main class="flex min-h-0 min-w-0 flex-1 flex-col">
            {#if mode.current === 'cut'}
              <CutMode />
            {:else}
              <ExportMode />
            {/if}
          </main>

          <RightRail />
        </div>
      {/key}
    </div>
  {/if}
</div>

<DropOverlay />
<ShortcutsHelp />
<SettingsPanel />
<Toasts />

<!-- The one menu, rendered at the app root so nothing can hide it. -->
{#if menu.current}
  <ContextMenu
    items={menu.current.items}
    x={menu.current.x}
    y={menu.current.y}
    onchoose={(id) => menu.choose(id)}
    onclose={() => menu.close()}
  />
{/if}
