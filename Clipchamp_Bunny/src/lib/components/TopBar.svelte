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
  import { applyStagedUpdate, installedBuild, isTauri, revealSource } from '../ipc';
  import { toast } from '../stores/toast.svelte';
  import UpdateButton from './UpdateButton.svelte';
  import BrandMark from './dashboard/BrandMark.svelte';
  import ProfileMenu from './ProfileMenu.svelte';
  import WindowControls from './WindowControls.svelte';

  /** Clipchamp's project-name menu (captured in the .ipynb DOM extract). */
  let renaming = $state(false);
  let draft = $state('');

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
  <!-- app launcher (9 dots) — the way back to the dashboard -->
  <button
    onclick={() =>
      // Write any edit still inside the debounce window before the dashboard
      // re-reads SQLite — otherwise a fast Home click shows a stale card.
      void project.flush().then(() => app.goHome('home'))}
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
    title={i18n.t('bar.home')}
    aria-label={i18n.t('bar.home')}
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

  <!-- brand: the traced T9 mark from the brand board, plus the wordmark -->
  <div class="flex items-center gap-1.5 pl-0.5">
    <BrandMark size={22} />
    <span class="font-brand text-[15px] leading-none tracking-[0.02em]">
      T9 Editor <span class="text-nc-brand">LIT</span>
    </span>
  </div>

  <!-- project dropdown — Clipchamp's project menu (Rename / Open file location / New video) -->
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
  {:else}
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
