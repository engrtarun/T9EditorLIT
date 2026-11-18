<script lang="ts">
  import { project } from '../stores/project.svelte';
  import { layout } from '../stores/layout.svelte';
  import { app } from '../stores/app.svelte';
  import { i18n } from '../stores/i18n.svelte';
  import CloudMenu from './CloudMenu.svelte';
  import SystemMeter from './SystemMeter.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from '../types';
  import { mode } from '../stores/mode.svelte';
  import { menu } from '../stores/menu.svelte';
  import { browser } from '../stores/browser.svelte';
  import TabChips from './browser/TabChips.svelte';
  import { applyStagedUpdate, installedBuild, isTauri, revealSource } from '../ipc';
  import { toast } from '../stores/toast.svelte';
  import UpdateButton from './UpdateButton.svelte';
  import BrandMark from './dashboard/BrandMark.svelte';
  import ProfileMenu from './ProfileMenu.svelte';
  import ToolsPanel from './ToolsPanel.svelte';
  import WindowControls from './WindowControls.svelte';

  /** Clipchamp's project-name menu (captured in the .ipynb DOM extract). */
  let renaming = $state(false);
  let draft = $state('');

  /**
   * Which screen this bar is speaking for: the studio itself, or the browser
   * the studio opened. That is what the wordmark's light "Studio" suffix
   * reports ("LIT ke baad halka sa light font me studio bhi likha aaaye") —
   * the dashboard has its own bar, and a browser opened on Home has the logo
   * as its way back, so neither of them says it.
   */
  const studioHere = $derived(
    app.view === 'editor' || (app.view === 'browser' && app.browserFrom === 'editor')
  );

  /**
   * Commit the rename from the top bar.
   *
   * It must reach SQLite, not just the store: the dashboard reloads its cards
   * from the `projects` table, so an in-memory rename vanished the moment the
   * user went home (the dashboard's own rename always did save).
   */
  function commitRename() {
    const next = draft.trim();
    if (next && next !== project.name) void project.rename(next);
    renaming = false;
  }

  const PROJ_ITEMS: MenuItem[] = [
    { id: 'rename', label: 'Rename', icon: 'rename' },
    { id: 'locate', label: 'Open file location', icon: 'folder' },
    { id: 'div', label: '', divider: true },
    { id: 'new', label: 'Create a new video', icon: 'plus' }
  ];

  function toggleProj(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.show(PROJ_ITEMS, Math.round(r.left), Math.round(r.bottom + 4), (id) => {
      if (id === 'rename') {
        draft = project.name;
        renaming = true;
      } else if (id === 'locate') {
        void revealSource().then((ok) =>
          toast.push(ok ? 'info' : 'warn', ok ? 'File location opened' : 'Source path unknown')
        );
      } else if (id === 'new') {
        // The panel lives on the dashboard, so this goes there and opens it.
        app.openNewProject();
      }
    });
  }
</script>

<!-- TOP BAR — structure copied 1:1 from Clipchamp (measured on the OBS capture):
     launcher · logo · project dropdown · cloud  |  right: meter · gear · help · avatar -->
<header
  data-focus="header"
  tabindex="-1"
  class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel pr-0 pl-1.5 select-none outline-none"
  data-tauri-drag-region
>
  <!-- app launcher (9 dots) → the suggested-websites panel; Home moved to the brand -->
  <ToolsPanel />

  <!-- brand: the traced T9 mark from the brand board, plus the wordmark.
       Click it to go Home — it is the way back to the dashboard. The mark
       also says which screen owns this bar: "Studio" only while the studio
       (or the browser opened from it) is the context. -->
  <button
    onclick={() =>
      // Write any edit still inside the debounce window before the dashboard
      // re-reads SQLite — otherwise a fast Home click shows a stale card.
      void project.flush().then(() => app.goHome('home'))}
    class="flex items-center gap-1.5 rounded-md pl-0.5 transition-opacity duration-150 hover:opacity-80"
    title={i18n.t('bar.home')}
    aria-label={i18n.t('bar.home')}
  >
    <BrandMark size={22} />
    <span class="font-brand text-[15px] leading-none tracking-[0.02em]">
      T9 Editor <span class="text-nc-brand">LIT</span>
      {#if studioHere}
        <span
          class="ml-1.5 text-[9.5px] font-light tracking-[0.18em] text-nc-mut uppercase"
          aria-hidden="true"
        >
          Studio
        </span>
      {/if}
    </span>
  </button>

  <!-- project dropdown — Clipchamp's project menu (Rename / Open file location / New video).
       Hidden while the browser view is open: a project rename is an editing
       job, and the browser already has its own chrome. An in-progress rename
       still shows, so blur/Enter can commit it. -->
  {#if renaming}
    <input
      bind:value={draft}
      onblur={commitRename}
      onkeydown={(e) => {
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') renaming = false;
      }}
      class="ml-1 w-[190px] rounded-md border border-nc-brand bg-nc-panel-2 px-2 py-1 text-[13px] outline-none"
    />
  {:else if app.view !== 'browser'}
    <button
      onclick={toggleProj}
      class="ml-1 flex items-center gap-1.5 rounded-md bg-nc-panel-2 px-2.5 py-1 text-[13px] font-medium hover:bg-nc-line"
      title={i18n.t('bar.projectMenu')}
      aria-haspopup="menu"
    >
      <span class="max-w-[190px] truncate">{project.name}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>
  {/if}

  <!-- cloud / local toggle → backup & AI providers -->
  <CloudMenu />

  <!-- the way back: browser → the studio that opened it. Only the STUDIO's
       door is drawn — "home btn kabhi nahi dikhna chaiye": from a browser
       opened on Home the logo already is the way home, and a second control
       that does the same thing is noise. Placed BEFORE the chips ("pehle
       <-- studio fir icon tab wala logic"), so the way out is read first. -->
  {#if app.view === 'browser' && app.browserFrom === 'editor'}
    <button
      type="button"
      onclick={() => app.closeBrowser()}
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-nc-mut
             transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Wapas Studio (Ctrl+Shift+W)"
      aria-label="Back to studio"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      Studio
    </button>
  {/if}

  <!-- The browser's tabs — icon chips, in EVERY state of this bar (studio
       and browser): they used to own a 40 px strip of their own above the
       address bar; the spec for this update is that the strip goes and the
       tabs live here, in the header, as favicons. From the studio a click
       opens the browser on that tab. The `+` right after them is the
       new-tab button in both states. -->
  <TabChips />

  <!-- + : a NEW TAB, always — "+ icon per click se hamesha new tab khulni
       chaiye". From the studio that means opening the browser AND landing on
       a fresh dial rather than whatever was last open; inside the browser it
       is the familiar new tab (capped at nine, and the tooltip says so). -->
  <button
    type="button"
    onclick={() => {
      if (app.view !== 'browser') app.openBrowser('editor');
      browser.open();
    }}
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut transition-colors duration-150
           {app.view === 'browser'
      ? 'bg-nc-panel-2 text-nc-brand'
      : 'hover:bg-nc-panel-2 hover:text-nc-txt'}"
    title={browser.atCap ? '9 tabs ki limit hai — pehle ek band karo' : 'Naya tab'}
    aria-label="New browser tab"
  >
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  </button>

  <div class="flex-1" data-tauri-drag-region></div>

  <!-- a newer build is installed: offer the restart -->
  <UpdateButton />

  <!-- RAM · this app · network, click for full PC details -->
  <SystemMeter />

  <!-- help -->
  <button
    onclick={() => (layout.helpOpen = true)}
    class="grid h-8 w-8 place-items-center rounded-md text-[15px] font-medium text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title={i18n.t('bar.help')}
    aria-label={i18n.t('bar.helpShort')}
  >
    ?
  </button>

  <!-- avatar = the profile popover (Edit profile · App settings · Language · Help & About) -->
  <div class="pr-2">
    <ProfileMenu />
  </div>

  <!-- caption buttons: in the bar, flush to the window corner -->
  <WindowControls />
</header>
