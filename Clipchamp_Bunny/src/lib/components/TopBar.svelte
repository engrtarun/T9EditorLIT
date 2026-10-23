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
        mode.set('ingest');
      }
    });
  }
</script>

<!-- TOP BAR — structure copied 1:1 from Clipchamp (measured on the OBS capture):
     launcher · logo · project dropdown · cloud  |  right: meter · gear · help · avatar -->
<header
  data-focus="header"
  tabindex="-1"
  class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel pr-2 pl-1.5 select-none outline-none"
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

  <div class="flex-1"></div>

  <!-- a newer build is installed: offer the restart -->
  <UpdateButton />

  <!-- RAM · this app · network, click for full PC details -->
  <SystemMeter />

  <!-- settings -->
  <button
    onclick={() => (layout.settingsOpen = true)}
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title={i18n.t('bar.settings')}
    aria-label={i18n.t('bar.settings')}
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
    onclick={() => (layout.helpOpen = true)}
    class="grid h-8 w-8 place-items-center rounded-md text-[15px] font-medium text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    title={i18n.t('bar.help')}
    aria-label={i18n.t('bar.helpShort')}
  >
    ?
  </button>

  <!-- avatar = the profile popover (Edit profile · App settings · Language · Help & About) -->
  <ProfileMenu />
</header>
