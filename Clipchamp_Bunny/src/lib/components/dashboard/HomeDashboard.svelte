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
  import { layout } from '../../stores/layout.svelte';
  import { i18n } from '../../stores/i18n.svelte';
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { menu } from '../../stores/menu.svelte';
  import DashboardTopBar from './DashboardTopBar.svelte';
  import ProjectCard from './ProjectCard.svelte';
  import T9CloudSetup from './T9CloudSetup.svelte';
  import CreateProjectModal from './CreateProjectModal.svelte';
  import Skeleton from '../Skeleton.svelte';
  import SkeletonBlock from '../SkeletonBlock.svelte';
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
  import { DUMMY_BIN, DUMMY_PROJECTS } from '../../mock';
  import { purgeExpiredTrash } from '../../ipc';
  import { settings } from '../../stores/settings.svelte';
  import {
    ago,
    fmtDuration,
    sortProjects,
    type ProjectCard as Card,
    type SortKey
  } from '../../dashboard';
  import type { MenuItem } from '../../types';

  /* ------------------------------------------------------------- state */

  let dbPath = $state('');
  let cards = $state<Card[]>([]);
  let bin = $state<RustTrashItem[]>([]);
  let loading = $state(true);
  /** Ordering only — the reference layout offers no sort or view switcher. */
  let sort = $state<SortKey>('recent');
  /** The dashboard's small transparent search box: filters by project name. */
  let query = $state('');
  /** The project whose name is being edited inline. */
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  /** The list the user actually sees: filtered by the search box, then ordered. */
  const visible = $derived(
    (() => {
      const q = query.trim().toLowerCase();
      const base = q ? cards.filter((c) => c.project.name.toLowerCase().includes(q)) : cards;
      return sortProjects(base, sort);
    })()
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

  async function sweepTrash() {
    if (!dbPath) return;
    try {
      const removed = await purgeExpiredTrash(dbPath, settings.trashRetentionDays);
      if (removed > 0)
        toast.push(
          'info',
          `${removed} purana trash record auto-delete ho gaya — video files safe hain.`
        );
    } catch {
      /* purge is best-effort; never block the bin view */
    }
  }

  async function browserBinFallback(): Promise<RustTrashItem[]> {
    if (isTauri()) return [];
    const baked = await loadMediaInfo().catch(() => null);
    if (!baked) return [];
    const now = Math.floor(Date.now() / 1000);
    // Browser dev mode has no SQLite bin either, so the Trash screen stands in
    // with a few dummy trashed projects — same shape as the real bin rows, same
    // baked-recording identity as the dummy cards above.
    return DUMMY_BIN.map((d) => ({
      id: d.id,
      name: d.name,
      sourcePath: `${baked.url}#${d.id}`,
      durationSecs: d.durationSecs,
      deletedAt: now - d.deletedAgoSecs
    }));
  }

  async function loadBin() {
    if (!dbPath) {
      // Browser dev mode: no SQLite backend, so the bin renders the dummy set
      // instead of going empty — the Trash UI must be previewable too.
      bin = await browserBinFallback();
      return;
    }
    await sweepTrash();
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

  // Periodic auto-purge while the dashboard is mounted — the same sweep the app
  // runs on launch, so items that expire mid-session disappear without a restart.
  $effect(() => {
    const iv = setInterval(() => {
      void sweepTrash().then(() => {
        if (app.section === 'trash') void loadBin();
      });
    }, 60_000);
    return () => clearInterval(iv);
  });

  /* ------------------------------------------------------------ actions */

  /** Open a project in the editor. The editor takes over immediately. */
  function openProject(c: Card) {
    if (c.opening) return;
    patch(c.project.id, (x) => ({ ...x, opening: true }));
    // A project created a moment ago still has its chosen name / ratio pending
    // for "the next file". Opening somebody else's project must not apply it.
    project.discardPending();
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

  /**
   * A new project starts with a question, not a jump into the editor: name,
   * shape, where the media comes from and (optionally) the export defaults.
   */
  function createNew() {
    app.openNewProject();
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
    // The imported file becomes the project (or joins an open one's library);
    // Cut is where both are visible, now that the Media page is gone.
    mode.set('cut');
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

  async function emptyBin() {
    if (bin.length === 0) return;
    const n = bin.length;
    // Warning first — emptying is destructive, and the user must allow it.
    const ok = window.confirm(i18n.t('dash.emptyTrashWarn', { n }));
    if (!ok) return;
    if (!dbPath) {
      // Browser dev mode: no backend to purge against, just drop the dummy rows.
      bin = [];
      toast.push('info', i18n.t('dash.emptyTrashDone'));
      return;
    }
    for (const item of bin) {
      try {
        await purgeTrash(dbPath, item.sourcePath);
      } catch {
        /* one bad row must not stop the rest */
      }
    }
    bin = [];
    toast.push('info', i18n.t('dash.emptyTrashDone'));
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

<!-- ============================================================
     dashboard — transparent, over the background video.

     There is no sidebar: the three sections moved into the top bar's tabs, so
     this screen is a strip of chrome at the top, its content, and the status
     bar at the bottom. Nothing floats in the middle of the frame — the
     footage keeps the centre of the window, and every word that sits straight
     on it carries `.t9-over-video`'s thin shadow instead of a box.
-->
<div class="t9-fade-in flex h-full min-h-0 flex-col text-nc-txt">
  <DashboardTopBar trashCount={bin.length} />

  <div class="flex min-h-0 flex-1">
    <!-- ---------------------------------------------------------- main -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <main class="nc-scroll-none min-h-0 flex-1">
        {#if app.section === 'cloud'}
          <T9CloudSetup />
        {:else}
          <div class="mx-auto flex min-h-full max-w-[1360px] flex-col px-7 py-6">
            {#if app.section === 'home'}
              <!--
              The reference screen's whole headline act, in the bottom-left
              corner: one heading, one button, nothing else. The block owns a
              viewport-sized min-height and bottom-aligns inside it, so the
              headline always lands ~71 % down the window (y≈668 in the
              reference, 935 px tall) no matter how long the project list
              grows — the middle of the frame stays the video's, the
              "Recent projects" rule sits right on the fold, and scrolling is
              what brings the cards up.
            -->
              <div class="flex min-h-[73vh] flex-col justify-end pb-7">
                <h1
                  class="t9-fade-in t9-over-video max-w-[980px] text-[30px] font-bold tracking-tight text-nc-txt"
                  style="animation-delay:60ms"
                >
                  {i18n.t('dash.create')}
                </h1>
                <button
                  onclick={createNew}
                  class="t9-fade-in mt-4 inline-flex items-center gap-2 self-start rounded-[10px] border border-white/30 bg-black/35 px-4 py-2.5
                       text-[14.5px] font-normal text-white transition-[filter,translate,border-color] duration-150 ease-out
                       hover:-translate-y-px hover:border-white/45 hover:brightness-110 active:scale-[0.98]"
                  style="animation-delay:120ms"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  {i18n.t('dash.newProject')}
                </button>
              </div>
            {/if}

            <!-- ------------------------------------------------ the project list -->
            {#if app.section === 'trash'}
              <div class="flex flex-wrap items-end justify-between gap-3">
                <div class="t9-over-video min-w-0">
                  <h1 class="text-[27px] font-bold tracking-tight text-nc-txt">
                    {i18n.t('nav.trash')}
                  </h1>
                  <p class="mt-1 text-[13px] text-nc-mut">{i18n.t('dash.trashDesc')}</p>
                </div>
                <div
                  class="flex shrink-0 items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1.5 text-[11px] text-nc-mut"
                >
                  <button
                    onclick={emptyBin}
                    disabled={bin.length === 0}
                    class="rounded-md border border-nc-red/40 bg-nc-panel px-2 py-0.5 text-[11px] font-medium text-nc-txt transition-colors duration-150 hover:border-nc-red hover:text-nc-red disabled:opacity-40"
                  >
                    {i18n.t('dash.emptyTrash')}
                  </button>
                  <span>
                    {i18n.t('dash.autoDelete')}:
                    <b class="text-nc-txt">
                      {settings.trashNever
                        ? i18n.t('set.trash.autoNever')
                        : i18n.t('set.trash.days', { n: settings.trashRetentionDays })}
                    </b>
                  </span>
                  <button
                    onclick={() => {
                      layout.settingsTab = 'general';
                      layout.settingsOpen = true;
                    }}
                    class="rounded-md border border-nc-line bg-nc-panel px-2 py-0.5 text-[11px] font-medium text-nc-txt transition-colors hover:border-nc-brand/50 hover:text-nc-brand"
                  >
                    {i18n.t('dash.change')}
                  </button>
                </div>
              </div>
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
                      <p class="mt-3 text-[13px] font-medium text-nc-txt">
                        {i18n.t('dash.trashEmpty')}
                      </p>
                      <p class="mt-1 text-[12px] text-nc-mut-2">{i18n.t('dash.trashEmptySub')}</p>
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
                          <div class="truncate text-[13px] font-medium text-nc-txt">
                            {item.name}
                          </div>
                          <div class="truncate text-[11px] text-nc-mut-2">
                            Deleted {ago(item.deletedAt)} · {fmtDuration(item.durationSecs)}
                            {#if !settings.trashNever}
                              · {settings.daysLeft(item.deletedAt) === 0
                                ? 'expires today'
                                : `expires in ${settings.daysLeft(item.deletedAt)} ${settings.daysLeft(item.deletedAt) === 1 ? 'day' : 'days'}`}
                            {/if}
                          </div>
                        </div>
                        <button
                          onclick={() => restore(item)}
                          class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-txt
                               transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
                        >
                          {i18n.t('dash.restore')}
                        </button>
                        <button
                          onclick={(e) => openBinMenu(item, e)}
                          class="grid h-7 w-7 place-items-center rounded-md text-nc-mut
                               transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
                          title={i18n.t('dash.more')}
                          aria-label={i18n.t('dash.moreFor', { name: item.name })}
                          aria-haspopup="menu"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="1.6" /><circle
                              cx="12"
                              cy="12"
                              r="1.6"
                            /><circle cx="19" cy="12" r="1.6" />
                          </svg>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              {:else}
                <!-- the reference layout's section rule, now carrying a small,
                     deliberately quiet search field. It must NOT glow or shine
                     over the footage — that is what ruins the frame — so it is
                     a hairline border on near-nothing, brightening only a
                     touch on focus. Shaped like a small Google-style pill and
                     kept compact so it reads as a whisper, not a widget. It
                     filters the grid below by name. -->
                <div class="t9-over-video mb-4 flex items-center gap-5">
                  <h2 class="shrink-0 text-[17px] font-semibold text-nc-txt">
                    {i18n.t('dash.recent')}
                  </h2>
                  <label class="relative flex w-[230px] shrink-0 items-center">
                    <svg
                      class="pointer-events-none absolute left-2.5 h-3 w-3 text-nc-mut-2"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      type="search"
                      bind:value={query}
                      placeholder={i18n.t('dash.searchPlaceholder')}
                      aria-label={i18n.t('dash.searchPlaceholder')}
                      class="w-full rounded-full border border-white/12 bg-white/[0.04] py-0.5 pr-2.5 pl-7
                             text-[12px] text-nc-txt placeholder:text-nc-mut-2
                             transition-colors duration-150
                             focus:border-white/25 focus:bg-white/[0.07] focus:outline-none"
                    />
                  </label>
                </div>

                {#if loading}
                  <!--
                  Skeleton first, data second.

                  The layout the user is about to get is already on screen, so
                  the database query feels like the last 40 ms of a finish
                  instead of a blank wait. `<Skeleton>` owns the single
                  composited sweep; these blocks only reserve the real shape.
                -->
                  <Skeleton label={i18n.t('dash.loading')}>
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
                  </Skeleton>
                {:else if visible.length === 0}
                  <!-- Two different empties, honestly told: a search that
                       matched nothing is NOT the same as having no projects. -->
                  {#if query.trim() && cards.length > 0}
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
                          <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                        </svg>
                        <p class="mt-3 text-[13px] font-medium text-nc-txt">
                          {i18n.t('dash.noMatches')}
                        </p>
                        <p class="mt-1 text-[12px] text-nc-mut-2">
                          {i18n.t('dash.noMatchesSub')}
                        </p>
                      </div>
                    </div>
                  {:else}
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
                          {i18n.t('dash.noProjects')}
                        </p>
                        <p class="mt-1 text-[12px] text-nc-mut-2">
                          {i18n.t('dash.noProjectsSub')}
                        </p>
                        <div class="mt-4 flex items-center justify-center gap-3">
                          <button
                            onclick={importMedia}
                            class="rounded-lg bg-nc-brand px-4 py-2 text-[12.5px] font-semibold text-nc-bg
                               transition-[filter] duration-150 hover:brightness-110"
                          >
                            {i18n.t('dash.import')}
                          </button>
                          {#if isTauri()}
                            <button
                              onclick={openDemo}
                              class="rounded-lg border border-nc-line px-4 py-2 text-[12.5px] text-nc-mut
                                 transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
                            >
                              {i18n.t('dash.openDemo')}
                            </button>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/if}
                {:else}
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
                {/if}
              {/if}
            </section>
          </div>
        {/if}
      </main>
    </div>
  </div>

  <!-- The panel behind "New project" — it decides name, shape and first media. -->
  <CreateProjectModal bind:open={app.newProjectOpen} />
</div>
