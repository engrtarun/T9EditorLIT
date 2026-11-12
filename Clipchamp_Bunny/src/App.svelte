<script lang="ts">
  import { onMount } from 'svelte';
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
  import UsageDialog from './lib/components/dashboard/UsageDialog.svelte';
  import BatchQueuePanel from './lib/components/dashboard/BatchQueuePanel.svelte';
  import BrowserView from './lib/components/browser/BrowserView.svelte';
  import BackgroundVideo from './lib/components/BackgroundVideo.svelte';
  import { mode } from './lib/stores/mode.svelte';
  import { app } from './lib/stores/app.svelte';
  import { browser } from './lib/stores/browser.svelte';
  import { player } from './lib/stores/player.svelte';
  import { project } from './lib/stores/project.svelte';
  import { layout } from './lib/stores/layout.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import { toast } from './lib/stores/toast.svelte';
  import { menu } from './lib/stores/menu.svelte';
  import { downloads } from './lib/stores/downloads.svelte';
  import { batch } from './lib/stores/batch.svelte';
  import { dispatchBrowserKey, runBrowserAction, type BrowserKeyDeps } from './lib/browser-keys';
  import {
    browserPrint,
    browserClearBrowsingData,
    onBrowserKey,
    browserFocusShell
  } from './lib/ipc';
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

  /** Put the caret in the address bar (Ctrl+L, Ctrl+K, a new tab). */
  function focusUrlbar() {
    const bar = document.querySelector<HTMLInputElement>('[data-urlbar-input]');
    bar?.focus();
    bar?.select();
  }

  /**
   * The in-built browser owns Firefox's key map (src/lib/browser-keys.ts).
   * Dispatch resolves the keyboard event to a NAMED action; these deps wire
   * each action to the stores — the map itself stays store-free and testable.
   */
  const browserDeps = {
    newTab: () => {
      if (!browser.open()) {
        toast.push('warn', '9 tabs ki limit hai — pehle ek band karo');
        return;
      }
      // Firefox puts the caret in the address bar on a new tab; without this
      // Ctrl+T left the user on the speed dial with nowhere to type.
      requestAnimationFrame(focusUrlbar);
    },
    closeTab: () => {
      const active = browser.active;
      if (!active) return;
      const last = browser.tabs.length === 1;
      browser.close(active.id);
      // Firefox rule: closing the last tab closes the browser window.
      if (last) app.closeBrowser();
    },
    closeBrowserView: () => app.closeBrowser(),
    reopenClosedTab: () => {
      if (browser.reopenClosed()) toast.push('info', '↻ Tab wapas khul gaya');
      else toast.push('info', 'Band kiya hua tab nahi hai');
    },
    selectTabN: (n: number) => browser.selectIndex(n),
    lastTab: () => browser.selectIndex(browser.tabs.length - 1),
    prevTab: () => browser.cycle(-1),
    nextTab: () => browser.cycle(1),
    moveTab: (dir: -1 | 1) => browser.moveTab(dir),
    pinTab: () => {
      const tab = browser.active;
      if (!tab) return;
      const pinned = browser.togglePin();
      toast.push(
        'info',
        pinned ? `📌 ${tab.title} pinned — background me chalta rahega` : '📌 Pin hata diya'
      );
    },
    back: () => browser.back(),
    forward: () => browser.forward(),
    stopLoading: () => browser.stopLoading(),
    reload: () => browser.reload(), // plain and forced land on the same forced nudge
    goHome: () => browser.goHome(),
    focusUrlbar: () => focusUrlbar(),
    downloads: () => downloads.toggle(),
    history: () => browser.toggleHistory(),
    clearHistory: () => {
      browser.clearHistory();
      const tab = browser.active;
      if (tab) void browserClearBrowsingData(tab.id);
      toast.push('info', '🧹 Browsing history aur data saaf');
    },
    bookmark: () => {
      const tab = browser.active;
      if (!tab || !tab.url || tab.url === 'about:blank') return;
      const added = browser.toggleBookmark(tab.url, tab.title);
      toast.push('info', added ? `★ ${tab.title} bookmark ho gaya` : 'Bookmark hata diya gaya');
    },
    bookmarkAllTabs: () => {
      const added = browser.bookmarkAllTabs();
      toast.push('info', added ? `★ ${added} tab bookmark ho gaye` : 'Naya bookmark nahi bana');
    },
    openBookmarks: () => {
      browser.open();
      toast.push('info', 'Bookmarks — speed dial aur aapke pins yahin hain');
    },
    savePage: () => {
      const tab = browser.active;
      if (!tab || !tab.url || tab.url === 'about:blank') return;
      void downloads
        .start(tab.url, { referer: tab.url })
        .then(() => toast.push('info', '⬇ Page save — multi-segment downloader me'))
        .catch((err) => toast.push('warn', err instanceof Error ? err.message : 'Save nahi hua'));
    },
    openFile: () => window.dispatchEvent(new CustomEvent('t9:import')),
    printPage: () => {
      const tab = browser.active;
      if (tab) void browserPrint(tab.id);
    },
    viewSource: () => browser.viewSource(),
    zoom: (dir: -1 | 0 | 1) => browser.applyZoom(dir),
    findInPage: () => {
      toast.push('info', '⌕ Find-in-page webview ka API is build me nahi hai');
    },
    openHelp: () => {
      layout.helpOpen = true;
    }
  } satisfies BrowserKeyDeps;

  /**
   * Keys pressed while the *page* webview has focus never reach this window's
   * keydown handler — that webview is a separate native child. The
   * document-start shim (`src-tauri/src/browser_shim.js`) reports them as
   * `browser:key`; this runs the exact same dep table through
   * `runBrowserAction`, so both paths stay one implementation.
   */
  onMount(() => {
    // The batch queue outlives the screen it was started from, so it is read
    // back once at the root. A list that vanished on restart was the whole
    // complaint behind "30 files, kisi ka pata nahi chala".
    void batch.hydrate();
    let off: (() => void) | null = null;
    let dead = false;
    void onBrowserKey(({ action, value }) => {
      if (app.view !== 'browser') return;
      runBrowserAction(action, value ?? 0, browserDeps);
      // Actions that need the chrome also have to pull the OS keyboard focus
      // out of the page webview, or the address bar has a caret but no keys.
      if (action === 'focusUrlbar' || action === 'newTab') void browserFocusShell();
    })
      .then((unlisten) => {
        if (dead) unlisten();
        else off = unlisten;
      })
      .catch(() => {
        /* browser-only dev build: there is no native key bridge */
      });
    return () => {
      dead = true;
      off?.();
    };
  });

  function onKey(e: KeyboardEvent) {
    // System shortcuts & screenshot keys must never be captured or blocked:
    // PrintScreen, Snapshot, and any Meta / Windows key chord (e.g. Win+Shift+S).
    // F-keys stay system-owned EXCEPT F1 (the shortcut sheet) — and F4/F5
    // while the browser is open, where they mean close-tab / reload, Firefox.
    const browserOpen = app.view === 'browser';
    const ownsF = e.key === 'F1' || (browserOpen && (e.key === 'F4' || e.key === 'F5'));
    if (
      e.key === 'PrintScreen' ||
      e.key === 'Snapshot' ||
      e.metaKey ||
      (e.key.startsWith('F') && !ownsF)
    ) {
      return;
    }

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

    // In the **browser** Firefox's own key map runs FIRST — it lives in
    // src/lib/browser-keys.ts and is allowed to fire with the address bar
    // focused (Ctrl+L re-focuses it, Ctrl+S still saves, …), so it must run
    // before the generic typing guard below. That module polices its own
    // typing rules (it stands down for editing chords).
    if (browserOpen && dispatchBrowserKey(e, browserDeps)) return;

    // One chord opens the in-built browser from anywhere — dashboard, studio,
    // the editor — so a quick lookup never means hunting for the 9-dots menu
    // first. Ctrl+Shift+B is unclaimed elsewhere in the app and Firefox uses
    // it for a toolbar this browser does not have. Inside the browser it is a
    // no-op: that view's own key map owns the keyboard.
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b' && app.view !== 'browser') {
      e.preventDefault();
      app.openBrowser(app.view);
      return;
    }

    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    // On the **dashboard** the editor's shortcuts have nothing to act on —
    // only the shortcut sheet still makes sense there.
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
    // F1 is the Firefox help key — it opens the same sheet here.
    if (e.key === 'F1' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      layout.helpOpen = true;
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
      project.stepSequenceBy(-settings.seekStepSec);
      return;
    }
    if (hit('seekForward', e)) {
      project.stepSequenceBy(settings.seekStepSec);
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
<!-- One usage panel for both triggers (the T9 Cloud card and the editor's
     quota chip). Mounted here because mode isolation unmounts every screen
     below it — a dialog living inside a screen could not outlive it. -->
<UsageDialog />
<BatchQueuePanel />

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
