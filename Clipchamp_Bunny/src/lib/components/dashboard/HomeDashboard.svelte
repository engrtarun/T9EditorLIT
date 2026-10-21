<script lang="ts">
  /**
   * THE HOME DASHBOARD — the screen the app opens on.
   *
   * Whether T9 Editor LIT is started from the taskbar icon, the desktop
   * shortcut or the launcher script, this is what comes up first. The editor
   * (media · cut · export) is one click away and none of its features moved:
   * the dashboard is a *way in*, not a replacement.
   *
   * Three rules shape everything below:
   *   1. **It has to appear fast.** The project list is one SQLite query; the
   *      sizes, the poster frames and the drive figures trickle in afterwards,
   *      one background step at a time, and none of them block a click.
   *   2. **Nothing here is fake.** A card shows the real duration, the real
   *      file size and a real frame extracted by FFmpeg. A project whose file
   *      has gone missing says so instead of pretending.
   *   3. **The motion is feedback, not decoration.** A 180 ms fade, a 2 px
   *      lift, a 24 ms stagger — and Windows' "animations off" switches the
   *      lot off.
   */
  import { app } from '../../stores/app.svelte';
  import { greeting } from '../../stores/greeting.svelte';
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { menu } from '../../stores/menu.svelte';
  import DashboardTopBar from './DashboardTopBar.svelte';
  import ProjectCard from './ProjectCard.svelte';
  import Skeleton from '../Skeleton.svelte';
  import SkeletonBlock from '../SkeletonBlock.svelte';
  import SystemFooter from '../SystemFooter.svelte';
  import {
    assetUrl,
    clearCustomThumbnail,
    customThumbnail,
    defaultDbPath,
    demoSourcePath,
    extractPoster,
    importThumbnail,
    isTauri,
    loadProjects,
    loadTrash,
    pickImageFile,
    pickVideos,
    probeMedia,
    purgeTrash,
    restoreProject,
    revealPath,
    saveProject,
    trashProject,
    updateProjectOpened
  } from '../../ipc';
  import type { RustProject, RustTrashItem } from '../../ipc';
  import { loadMediaInfo, loadThumbnails } from '../../media';
  import { DUMMY_PROJECTS } from '../../mock';
  import {
    ago,
    fmtBytes,
    fmtDuration,
    SORT_LABEL,
    sortProjects,
    type ProjectCard as Card,
    type SortKey
  } from '../../dashboard';
  import type { MenuItem } from '../../types';

  // One greeting per app open. The store caches and guards repeats, so this
  // line never waits for the network.
  greeting.init();

  /* ------------------------------------------------------------- state */

  let dbPath = $state('');
  let cards = $state<Card[]>([]);
  let bin = $state<RustTrashItem[]>([]);
  let loading = $state(true);
  let query = $state('');
  let sort = $state<SortKey>('recent');
  let view = $state<'grid' | 'list'>('grid');
  /** The project whose name is being edited inline. */
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  const SECTIONS = [
    {
      id: 'home',
      label: 'Home',
      icon: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z'
    },
    {
      id: 'videos',
      label: 'Your videos',
      icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
    },
    {
      id: 'trash',
      label: 'Trash',
      icon: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13'
    }
  ] as const;

  /** The list the user actually sees: searched, then ordered. */
  const visible = $derived(
    sortProjects(
      cards.filter((c) => c.project.name.toLowerCase().includes(query.trim().toLowerCase())),
      sort
    )
  );

  /* ------------------------------------------------------------ loading */

  function toCard(p: RustProject): Card {
    return {
      project: p,
      sizeBytes: 0,
      posterUrl: null,
      previewUrl: null,
      customThumb: null,
      opening: false
    };
  }

  function patch(id: string, fn: (c: Card) => Card) {
    cards = cards.map((c) => (c.project.id === id ? fn(c) : c));
  }

  async function load() {
    loading = true;
    try {
      dbPath = await defaultDbPath();
      const list = await loadProjects(dbPath);
      cards = list.map(toCard);
      loading = false;
      // The rest is nice-to-have — it arrives on its own, in the background.
      void hydrate(list);
      void loadBin();
    } catch {
      // Browser dev mode: the baked demo stands in for a project so the
      // layout can be seen without a Rust toolchain.
      cards = await browserFallback();
      loading = false;
    }
  }

  async function browserFallback(): Promise<Card[]> {
    if (isTauri()) return [];
    const baked = await loadMediaInfo().catch(() => null);
    if (!baked) return [];
    const thumbs = await loadThumbnails().catch(() => null);
    const now = Math.floor(Date.now() / 1000);
    // A whole grid of dummy projects, so the layout can be judged with the
    // screen full instead of with one lonely card. Every card points at the
    // baked recording, and takes a different frame of it as its poster.
    return DUMMY_PROJECTS.map((d) => ({
      project: {
        id: d.id,
        name: d.name,
        // The path is the card's identity here - the list is keyed by it and
        // the rename / trash actions address it. All the dummy cards point at
        // the same baked recording, so the path needs the fragment to keep
        // them apart; the fragment is ignored when the file is fetched.
        sourcePath: `${baked.url}#${d.id}`,
        durationSecs: d.durationSecs,
        lastOpened: now - d.openedAgoSecs
      },
      sizeBytes: d.sizeBytes,
      posterUrl: thumbs
        ? `/assets/thumbs/thumb_${String(d.thumbIndex).padStart(5, '0')}.jpg`
        : null,
      previewUrl: null,
      customThumb: null,
      opening: false
    }));
  }

  /**
   * The slow part — posters first, then sizes.
   *
   * Posters win the race on purpose: they are what the eye sees. A cached
   * still is just a file existence check; an uncached one costs one FFmpeg
   * child. Either way they run **one at a time** — the dashboard is already
   * on screen, and a queue of eight parallel decoders would be exactly the
   * kind of CPU burn this app is built to avoid.
   *
   * Sizes come from the SQLite ffprobe cache, so the second visit is free.
   * A card that cannot get a still falls back to streaming the file itself —
   * a real frame, never a blank box.
   */
  async function hydrate(list: RustProject[]) {
    for (const p of list) {
      try {
        // A picture the user chose beats a frame the app picked, so the
        // custom one is looked for first. It is a directory read - the image
        // is never decoded, only its path is kept.
        const custom = await customThumbnail(p.sourcePath);
        if (custom) {
          patch(p.id, (c) => ({ ...c, customThumb: custom, posterUrl: assetUrl(custom) }));
          continue;
        }
        const poster = await extractPoster(p.sourcePath);
        patch(p.id, (c) => ({ ...c, posterUrl: assetUrl(poster.path) }));
      } catch {
        // No still — stream the video instead of showing an empty tile.
        patch(p.id, (c) => ({ ...c, previewUrl: assetUrl(p.sourcePath) }));
      }
      // Give the UI a frame between ffmpeg children.
      await new Promise((r) => setTimeout(r, 0));
    }

    for (const p of list) {
      try {
        const info = await probeMedia(p.sourcePath);
        patch(p.id, (c) => ({ ...c, sizeBytes: info.sizeBytes }));
      } catch {
        /* the file has moved or is gone — the card keeps what it knows */
      }
    }
  }

  async function loadBin() {
    if (!dbPath) return;
    try {
      bin = await loadTrash(dbPath);
    } catch {
      bin = [];
    }
  }

  async function reload() {
    if (!dbPath) return;
    try {
      const list = await loadProjects(dbPath);
      cards = list.map(toCard);
      void hydrate(list);
    } catch {
      cards = [];
    }
    await loadBin();
  }

  $effect(() => {
    void load();
  });

  $effect(() => {
    if (app.section === 'trash') void loadBin();
  });

  /* ------------------------------------------------------------ actions */

  /** Open a project in the editor. The editor takes over immediately. */
  function openProject(c: Card) {
    if (c.opening) return;
    patch(c.project.id, (x) => ({ ...x, opening: true }));
    app.openEditor();
    mode.set('cut');
    // In the browser there is no Rust engine to probe the file, so the
    // baked recording stands in - same as the editor's own browser path.
    const opened = isTauri()
      ? project
          .loadFromBackend(c.project.sourcePath)
          .then(() =>
            updateProjectOpened(dbPath, c.project.sourcePath, Math.floor(Date.now() / 1000))
          )
      : project.loadBaked();
    void opened
      .catch((e) =>
        toast.push('warn', `Project khul nahi paya: ${e instanceof Error ? e.message : e}`)
      )
      .finally(() => patch(c.project.id, (x) => ({ ...x, opening: false })));
  }

  /** A blank project: the editor's Media mode, ready for a new import. */
  function createNew() {
    app.openEditor();
    mode.set('ingest');
  }

  /**
   * The demo recording — the app's first-run sample.
   *
   * It lives on the dashboard rather than inside the editor, because the
   * dashboard is where "I have nothing yet" is answered.
   */
  async function openDemo() {
    try {
      const path = await demoSourcePath();
      if (!path) {
        toast.push('warn', 'Demo recording nahi mili — apni video import karo');
        return;
      }
      app.openEditor();
      mode.set('cut');
      void project.loadFromBackend(path);
    } catch (e) {
      toast.push('warn', `Demo nahi khul paaya: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Import from the file manager — the same picker the media panel uses. */
  async function importMedia() {
    const paths = await pickVideos();
    if (!paths.length) return;
    app.openEditor();
    mode.set('ingest');
    try {
      await project.importPaths(paths);
      toast.push('info', `${paths.length} file import ho gayi`);
    } catch (e) {
      toast.push('warn', `Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /* --------------------------------------------------------------- menu */

  function openCardMenu(c: Card, e: MouseEvent) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { id: 'open', label: 'Open', icon: 'spark' },
      { id: 'rename', label: 'Rename', icon: 'rename' },
      { id: 'thumb', label: c.customThumb ? 'Change thumbnail' : 'Set thumbnail', icon: 'image' },
      { id: 'locate', label: 'Open file location', icon: 'folder' },
      { id: 'copy', label: 'Copy path', icon: 'copy' },
      { id: 'div', label: '', divider: true },
      { id: 'trash', label: 'Move to trash', icon: 'trash', danger: true }
    ];
    if (c.customThumb) {
      items.splice(5, 0, { id: 'unthumb', label: 'Remove thumbnail', icon: 'close' });
    }
    menu.show(items, Math.round(r.left - 120), Math.round(r.bottom + 4), (id) =>
      pickCardAction(id, c)
    );
  }

  /**
   * Put a picture of the user's own on a project card.
   *
   * The picture is copied into the app's cache by the OS - byte for byte, so
   * it is never read into memory - and the card only ever holds the path.
   * In the browser there is no app cache, so the picked file is streamed
   * from a blob for the session.
   */
  async function setCardThumbnail(c: Card) {
    const picked = await pickImageFile();
    if (!picked) return;
    try {
      if (isTauri()) {
        const stored = await importThumbnail(c.project.sourcePath, picked);
        patch(c.project.id, (x) => ({ ...x, customThumb: stored, posterUrl: assetUrl(stored) }));
        toast.push('info', 'Thumbnail lag gaya');
      } else {
        patch(c.project.id, (x) => ({ ...x, customThumb: picked, posterUrl: picked }));
        toast.push('info', 'Thumbnail lag gaya (browser mode - is session me hi rahega)');
      }
    } catch (e) {
      toast.push('warn', `Thumbnail nahi laga: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function removeCardThumbnail(c: Card) {
    if (!isTauri()) {
      patch(c.project.id, (x) => ({ ...x, customThumb: null }));
      toast.push('info', 'Thumbnail hata diya');
      return;
    }
    try {
      await clearCustomThumbnail(c.project.sourcePath);
      patch(c.project.id, (x) => ({ ...x, customThumb: null }));
      toast.push('info', 'Thumbnail hata diya');
    } catch (e) {
      toast.push('warn', `Thumbnail nahi hata: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function pickCardAction(id: string, c: Card) {
    if (id === 'open') {
      openProject(c);
    } else if (id === 'rename') {
      renamingId = c.project.id;
      renameDraft = c.project.name;
    } else if (id === 'thumb') {
      await setCardThumbnail(c);
    } else if (id === 'unthumb') {
      await removeCardThumbnail(c);
    } else if (id === 'locate') {
      const ok = await revealPath(c.project.sourcePath);
      toast.push(
        ok ? 'info' : 'warn',
        ok ? 'File location opened' : 'File location nahi khul paaya'
      );
    } else if (id === 'copy') {
      await navigator.clipboard?.writeText(c.project.sourcePath).catch(() => {});
      toast.push('info', 'Path copy ho gaya');
    } else if (id === 'trash') {
      try {
        await trashProject(dbPath, c.project.sourcePath);
        toast.push('info', `${c.project.name} trash me gaya — video file disk pe safe hai`);
        await reload();
      } catch (e) {
        toast.push('warn', `Trash nahi hua: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async function commitRename() {
    const id = renamingId;
    renamingId = null;
    if (!id) return;
    const name = renameDraft.trim();
    const card = cards.find((c) => c.project.id === id);
    if (!card || !name || name === card.project.name) return;
    try {
      await saveProject(
        dbPath,
        card.project.id,
        name,
        card.project.sourcePath,
        card.project.durationSecs,
        card.project.lastOpened
      );
      patch(id, (c) => ({ ...c, project: { ...c.project, name } }));
    } catch (e) {
      toast.push('warn', `Rename nahi hua: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * The cached still could not be shown (a missing file, a broken cache).
   *
   * Fall back to streaming the video itself — the `<video>` element shows a
   * real frame and never buffers the file, so the card is never a blank box.
   */
  function posterFailed(c: Card) {
    patch(c.project.id, (x) => ({
      ...x,
      posterUrl: null,
      previewUrl: x.previewUrl ?? assetUrl(x.project.sourcePath)
    }));
  }

  function openSortMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = (Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
      id: k,
      label: SORT_LABEL[k]
    }));
    menu.show(items, Math.round(r.right - 160), Math.round(r.bottom + 4), (id) => {
      sort = id as SortKey;
    });
  }

  /* --------------------------------------------------------------- bin */

  async function restore(item: RustTrashItem) {
    try {
      await restoreProject(dbPath, item.sourcePath);
      toast.push('info', `${item.name} wapas aa gaya`);
      await reload();
    } catch (e) {
      toast.push('warn', `Restore nahi hua: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function purge(item: RustTrashItem) {
    try {
      await purgeTrash(dbPath, item.sourcePath);
      toast.push('info', `${item.name} ka record delete ho gaya — video file disk pe safe hai`);
      await reload();
    } catch (e) {
      toast.push('warn', `Delete nahi hua: ${e instanceof Error ? e.message : e}`);
    }
  }

  function openBinMenu(item: RustTrashItem, e: MouseEvent) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { id: 'restore', label: 'Restore', icon: 'spark' },
      { id: 'locate', label: 'Open file location', icon: 'folder' },
      { id: 'div', label: '', divider: true },
      { id: 'purge', label: 'Delete record', icon: 'trash', danger: true }
    ];
    menu.show(items, Math.round(r.left - 120), Math.round(r.bottom + 4), async (id) => {
      if (id === 'restore') await restore(item);
      else if (id === 'purge') await purge(item);
      else if (id === 'locate') {
        const ok = await revealPath(item.sourcePath);
        toast.push(ok ? 'info' : 'warn', ok ? 'File location opened' : 'File nahi mili');
      }
    });
  }
</script>

<!-- ============================================================ dashboard -->
<div class="t9-fade-in flex h-full min-h-0 flex-col bg-nc-bg text-nc-txt">
  <DashboardTopBar bind:query />

  <div class="flex min-h-0 flex-1">
    <!-- ------------------------------------------------------- sidebar -->
    <nav
      class="flex w-[248px] shrink-0 flex-col gap-1 border-r border-nc-line bg-nc-panel p-2"
      aria-label="Dashboard sections"
    >
      {#each SECTIONS as s (s.id)}
        <button
          onclick={() => (app.section = s.id)}
          aria-current={app.section === s.id ? 'page' : undefined}
          class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13.5px]
                 transition-colors duration-150
                 {app.section === s.id
            ? 'bg-nc-brand/12 font-medium text-nc-txt'
            : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linejoin="round"
            aria-hidden="true"
            class="shrink-0 transition-colors duration-150 {app.section === s.id
              ? 'text-nc-brand'
              : 'text-nc-mut-2'}"
          >
            <path d={s.icon} />
          </svg>
          <span class="flex-1">{s.label}</span>
          {#if s.id === 'trash' && bin.length}
            <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut">
              {bin.length}
            </span>
          {/if}
        </button>
      {/each}

      <div class="mt-auto flex items-center gap-2 px-3 py-2">
        <span class="font-brand text-[13px] leading-none tracking-[0.04em] text-nc-brand">LIT</span>
        <span class="text-[11px] text-nc-mut-2">v{app.version}</span>
      </div>
    </nav>

    <!-- ---------------------------------------------------------- main -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <main class="nc-scroll min-h-0 flex-1">
        <div class="mx-auto max-w-[1360px] px-7 py-6">
          {#if app.section === 'home'}
            <!-- greeting -->
            <h1
              class="t9-fade-in max-w-[980px] text-[27px] font-bold tracking-tight text-nc-txt"
              style="animation-delay:60ms"
              title={greeting.text}
            >
              {greeting.text}
            </h1>
            <p class="t9-fade-in mt-1 text-[13px] text-nc-mut" style="animation-delay:100ms">
              Pick up where you left off.
            </p>

            <!-- ------------------------------------------------ the CTAs -->
            <div
              class="t9-fade-in mt-5 flex max-w-[760px] flex-col overflow-hidden rounded-xl bg-nc-brand sm:flex-row"
              style="animation-delay:140ms"
            >
              <button
                onclick={createNew}
                class="flex flex-1 items-center gap-4 px-5 py-4 text-left
                       transition-[filter,translate] duration-150 ease-out
                       hover:-translate-y-px hover:brightness-110 active:scale-[0.98]"
              >
                <span
                  class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/25 text-[22px] leading-none text-white"
                  >+</span
                >
                <span class="min-w-0">
                  <span class="block text-[15px] font-semibold text-white">Create a new video</span>
                  <span class="block text-[12px] text-white/85">Start with a blank project</span>
                </span>
              </button>

              <span class="hidden w-px bg-white/25 sm:block"></span>

              <button
                onclick={importMedia}
                class="flex items-center justify-center gap-2.5 px-6 py-4 text-[14px] font-medium text-white
                       transition-[filter,translate] duration-150 ease-out
                       hover:-translate-y-px hover:brightness-110 active:scale-[0.98]"
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
                </svg>
                Import media
              </button>
            </div>
          {/if}

          <!-- ------------------------------------------------ the project list -->
          {#if app.section === 'trash'}
            <h1 class="text-[27px] font-bold tracking-tight text-nc-txt">Trash</h1>
            <p class="mt-1 text-[13px] text-nc-mut">
              Yahan sirf app ka record rakha hai — video file hamesha disk pe safe rehta hai.
            </p>
          {:else if app.section === 'videos'}
            <h1 class="text-[27px] font-bold tracking-tight text-nc-txt">Your videos</h1>
            <p class="mt-1 text-[13px] text-nc-mut">Har project jo aapne kabhi khola.</p>
          {/if}

          <section class="mt-7">
            {#if app.section === 'trash'}
              <!-- the bin -->
              {#if bin.length === 0}
                <div
                  class="grid place-items-center rounded-xl border-2 border-dashed border-nc-line px-6 py-14 text-center"
                >
                  <div>
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      class="mx-auto text-nc-mut-2"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
                      />
                    </svg>
                    <p class="mt-3 text-[13px] font-medium text-nc-txt">Trash khaali hai</p>
                    <p class="mt-1 text-[12px] text-nc-mut-2">Koi project remove nahi kiya gaya.</p>
                  </div>
                </div>
              {:else}
                <ul
                  class="divide-y divide-nc-line overflow-hidden rounded-xl border border-nc-line bg-nc-panel"
                >
                  {#each bin as item, i (item.sourcePath)}
                    <li
                      class="t9-card-in flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-nc-panel-2"
                      style="--i:{Math.min(i, 8)}"
                    >
                      <div
                        class="grid h-10 w-16 shrink-0 place-items-center rounded border border-nc-line bg-nc-bg text-nc-mut-2"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          aria-hidden="true"
                        >
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <path d="M10 9l5 3-5 3z" />
                        </svg>
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-[13px] font-medium text-nc-txt">{item.name}</div>
                        <div class="truncate text-[11px] text-nc-mut-2">
                          Deleted {ago(item.deletedAt)} · {fmtDuration(item.durationSecs)}
                        </div>
                      </div>
                      <button
                        onclick={() => restore(item)}
                        class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-txt
                               transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
                      >
                        Restore
                      </button>
                      <button
                        onclick={(e) => openBinMenu(item, e)}
                        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut
                               transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
                        title="More options"
                        aria-label="More options for {item.name}"
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
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else}
              <div class="mb-3 flex items-center justify-between gap-3">
                <h2 class="text-[17px] font-semibold text-nc-txt">Your videos</h2>

                <div class="flex items-center gap-2">
                  <!-- sort -->
                  <button
                    onclick={openSortMenu}
                    class="flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1.5
                           text-[12.5px] text-nc-txt transition-colors duration-150 hover:border-nc-line-2"
                    aria-haspopup="menu"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.9"
                      stroke-linecap="round"
                      class="text-nc-mut"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                    </svg>
                    {SORT_LABEL[sort]}
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      class="text-nc-mut-2"
                      aria-hidden="true"
                    >
                      <path d="M7 10l5 5 5-5z" />
                    </svg>
                  </button>

                  <!-- grid / list -->
                  <div class="flex overflow-hidden rounded-lg border border-nc-line">
                    <button
                      onclick={() => (view = 'grid')}
                      class="grid h-8 w-9 place-items-center transition-colors duration-150
                             {view === 'grid'
                        ? 'bg-nc-brand/15 text-nc-brand'
                        : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
                      aria-label="Grid view"
                      aria-pressed={view === 'grid'}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect
                          x="13"
                          y="3"
                          width="8"
                          height="8"
                          rx="1.5"
                        /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect
                          x="13"
                          y="13"
                          width="8"
                          height="8"
                          rx="1.5"
                        />
                      </svg>
                    </button>
                    <button
                      onclick={() => (view = 'list')}
                      class="grid h-8 w-9 place-items-center border-l border-nc-line transition-colors duration-150
                             {view === 'list'
                        ? 'bg-nc-brand/15 text-nc-brand'
                        : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
                      aria-label="List view"
                      aria-pressed={view === 'list'}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <rect x="3" y="5" width="18" height="2.4" rx="1.2" /><rect
                          x="3"
                          y="10.8"
                          width="18"
                          height="2.4"
                          rx="1.2"
                        /><rect x="3" y="16.6" width="18" height="2.4" rx="1.2" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {#if loading}
                <!--
                  Skeleton first, data second.

                  The layout the user is about to get is already on screen, so
                  the database query feels like the last 40 ms of a finish
                  instead of a blank wait. `<Skeleton>` owns the single
                  composited sweep; these blocks only reserve the real shape.
                -->
                <Skeleton label="Projects load ho rahe hain…">
                  {#if view === 'grid'}
                    <ul
                      class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      aria-hidden="true"
                    >
                      {#each Array(8) as _, i}
                        <li class="t9-card-in" style="--i:{Math.min(i, 8)}">
                          <SkeletonBlock
                            class="aspect-video w-full rounded-lg border border-nc-line"
                          />
                          <SkeletonBlock shape="line" class="mt-2.5 w-[58%]" />
                          <SkeletonBlock shape="line" class="mt-1.5 h-2.5 w-[38%] opacity-70" />
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <ul
                      class="divide-y divide-nc-line overflow-hidden rounded-xl border border-nc-line bg-nc-panel"
                      aria-hidden="true"
                    >
                      {#each Array(6) as _, i}
                        <li class="flex items-center gap-3 px-3 py-2">
                          <SkeletonBlock class="h-10 w-16 shrink-0 rounded border border-nc-line" />
                          <div class="min-w-0 flex-1">
                            <SkeletonBlock shape="line" class="w-[38%]" />
                            <SkeletonBlock shape="line" class="mt-1.5 h-2.5 w-[24%] opacity-70" />
                          </div>
                          <SkeletonBlock shape="line" class="h-2.5 w-8 opacity-70" />
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </Skeleton>
              {:else if visible.length === 0}
                <div
                  class="grid place-items-center rounded-xl border-2 border-dashed border-nc-line px-6 py-14 text-center"
                >
                  <div>
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      class="mx-auto text-nc-mut-2"
                      aria-hidden="true"
                    >
                      <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
                    </svg>
                    <p class="mt-3 text-[13px] font-medium text-nc-txt">
                      {query.trim() ? 'Kuch nahi mila' : 'Abhi koi project nahi hai'}
                    </p>
                    <p class="mt-1 text-[12px] text-nc-mut-2">
                      {query.trim()
                        ? 'Search hatao ya naya project banao.'
                        : 'Import media se shuru karo — ya "Create a new video" se ek blank project.'}
                    </p>
                    {#if !query.trim()}
                      <div class="mt-4 flex items-center justify-center gap-3">
                        <button
                          onclick={importMedia}
                          class="rounded-lg bg-nc-brand px-4 py-2 text-[12.5px] font-semibold text-nc-bg
                                 transition-[filter] duration-150 hover:brightness-110"
                        >
                          Import media
                        </button>
                        {#if isTauri()}
                          <button
                            onclick={openDemo}
                            class="rounded-lg border border-nc-line px-4 py-2 text-[12.5px] text-nc-mut
                                   transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
                          >
                            …ya demo recording kholo
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else if view === 'grid'}
                <ul class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {#each visible as c, i (c.project.id)}
                    <ProjectCard
                      card={c}
                      index={i}
                      renaming={renamingId === c.project.id}
                      onopen={() => openProject(c)}
                      onmenu={(e) => openCardMenu(c, e)}
                      onrenamechange={(v) => (renameDraft = v)}
                      onrenamecommit={() => void commitRename()}
                      onrenamecancel={() => (renamingId = null)}
                      onpostererror={() => posterFailed(c)}
                    />
                  {/each}
                </ul>
              {:else}
                <ul
                  class="divide-y divide-nc-line overflow-hidden rounded-xl border border-nc-line bg-nc-panel"
                >
                  {#each visible as c, i (c.project.id)}
                    <li
                      class="t9-card-in flex items-center gap-3 px-3 py-2 transition-colors duration-150 hover:bg-nc-panel-2"
                      style="--i:{Math.min(i, 8)}"
                    >
                      <button
                        onclick={() => openProject(c)}
                        class="h-10 w-16 shrink-0 overflow-hidden rounded border border-nc-line bg-nc-bg"
                        aria-label="Open {c.project.name}"
                      >
                        {#if c.posterUrl}
                          <img
                            src={c.posterUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            class="h-full w-full object-cover"
                          />
                        {/if}
                      </button>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-[13px] font-medium text-nc-txt">
                          {c.project.name}
                        </div>
                        <div class="truncate text-[11px] text-nc-mut-2">
                          Edited {ago(c.project.lastOpened)}
                          {#if c.sizeBytes > 0}· {fmtBytes(c.sizeBytes)}{/if}
                        </div>
                      </div>
                      <span class="font-mono text-[11px] text-nc-mut-2">
                        {fmtDuration(c.project.durationSecs)}
                      </span>
                      <button
                        onclick={(e) => openCardMenu(c, e)}
                        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut
                               transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
                        title="More options"
                        aria-label="More options for {c.project.name}"
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
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </section>
        </div>
      </main>

      <!-- --------------------------------------------------- status bar -->
      <footer
        class="flex h-9 shrink-0 items-center border-t border-nc-line bg-nc-panel px-4"
        title="Live system meters — RAM, disk and network, read from the OS once a second"
      >
        <SystemFooter />
      </footer>
    </div>
  </div>
</div>
