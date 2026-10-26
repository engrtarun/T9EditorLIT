<script lang="ts">
  /**
   * CREATE NEW PROJECT — the panel behind the dashboard's "New project" button.
   *
   * It answers the four questions that used to be answered by guesswork:
   *
   *   1. **What is it called?** The name is kept in SQLite (`project.rename`),
   *      so the dashboard card and the top bar agree.
   *   2. **What shape is it?** The format cards are real: `project.frame`
   *      letterboxes the preview and becomes the export canvas. 16:9 is the
   *      source's own shape, which is what keeps the lossless stream-copy path
   *      alive for ordinary horizontal footage.
   *   3. **Where does the media come from?** A real file picker, a yt-dlp link,
   *      the Telegram vault, or nothing at all.
   *   4. **Where does the finished file go, and how big?** Those two are the
   *      only "advanced" settings, and both are wired: the export panel starts
   *      from them.
   *
   * Nothing here buffers media: the picker hands over paths, yt-dlp writes
   * straight to disk, and the Telegram flow is the same QR handshake the cloud
   * menu uses. The panel itself only ever holds a few strings.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { app } from '../../stores/app.svelte';
  import { mode } from '../../stores/mode.svelte';
  import { exportDefaults } from '../../stores/export-defaults.svelte';
  import {
    checkYtDlp,
    downloadFromUrl,
    isTauri,
    pickFolder,
    pickMediaFiles,
    pickVideos
  } from '../../ipc';
  import { RESOLUTIONS, type ResolutionId } from '../../export-presets';
  import { EXTRA_FRAMES, MAIN_FRAMES, framePreset, type ProjectFrame } from '../../project-frame';

  interface Props {
    open: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  /** What the user typed. Untouched means "let the file name the project". */
  let name = $state('');
  let nameTouched = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let linkEl = $state<HTMLInputElement | null>(null);

  let frame = $state<ProjectFrame>('16:9');
  let moreOpen = $state(false);
  let linkOpen = $state(false);
  let linkUrl = $state('');
  let advanced = $state(false);
  let busy = $state(false);
  let error = $state('');

  /**
   * Dead air — the one tool the old Media page owned.
   *
   * The scan itself is FFmpeg `silencedetect` on the source, and the cut marks
   * every transcript line that overlaps a silent span. Doing it at import time
   * is honest: the threshold is chosen once, and nothing is cut behind the
   * user's back because the toggle starts off.
   */
  let deadAir = $state(false);
  let deadAirSecs = $state(3.0);

  /** The last step of every path: leave the dashboard, open the editor. */
  function enterEditor(): void {
    open = false;
    app.openEditor();
    mode.set('cut');
  }

  /**
   * Run the dead-air pass on the project that was just imported.
   *
   * Desktop only (the scan is a Rust/FFmpeg command) and only when the user
   * asked for it. A scan failure is reported, never fatal: the import already
   * succeeded and the media is open.
   */
  async function cutDeadAir(): Promise<void> {
    if (!deadAir || !isTauri() || !project.sourcePath) return;
    try {
      const n = await project.autoCutSilence(deadAirSecs);
      if (n > 0) {
        toast.push('cut', `${n} lines cut — ${deadAirSecs.toFixed(1)}s+ ki khamoshi hata di`);
      } else {
        toast.push('info', `Koi ${deadAirSecs.toFixed(1)}s+ khamoshi nahi mili`);
      }
    } catch (e) {
      toast.push('warn', `Dead air scan failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A brand-new project with no file behind it yet. */
  async function createEmpty(): Promise<void> {
    if (busy) return;
    const typed = nameTouched ? name.trim() : '';
    await project.startNew(typed, frame);
    // No name typed: show the panel's placeholder now, but leave the pending
    // name empty so the first file imported still names the project.
    if (!typed) await project.rename(i18n.t('new.untitled'));
    enterEditor();
  }

  /**
   * "This PC". Desktop: real paths from the OS dialog. Browser preview: a real
   * `<input type="file">`, because a web page has no path to give.
   */
  async function createFromPc(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    const typed = nameTouched ? name.trim() : '';
    try {
      if (isTauri()) {
        const paths = await pickVideos();
        if (!paths.length) return; // cancelled — keep the panel open
        await project.startNew(typed, frame);
        enterEditor();
        // The first file becomes the project; the rest join its library — the
        // same split the old "open a file" path used.
        await project.loadFromBackend(paths[0]);
        if (paths.length > 1) await project.importPaths(paths.slice(1));
        if (typed) await project.rename(typed);
        await cutDeadAir();
        toast.push('info', `${paths.length} file import ho gayi`);
      } else {
        const files = await pickMediaFiles();
        if (!files.length) return;
        await project.startNew(typed, frame);
        enterEditor();
        await project.importBlobs(files);
        if (typed) await project.rename(typed);
        toast.push('info', `${files.length} file import ho gayi`);
      }
    } catch (e) {
      error = `${i18n.t('new.failed')}: ${e instanceof Error ? e.message : e}`;
    } finally {
      busy = false;
    }
  }

  /** "Video Link" — yt-dlp streams the download to disk, never through the heap. */
  async function createFromLink(): Promise<void> {
    const url = linkUrl.trim();
    if (!url || busy) return;
    busy = true;
    error = '';
    const typed = nameTouched ? name.trim() : '';
    try {
      const available = await checkYtDlp().catch(() => false);
      if (!available) {
        error = i18n.t('new.ytMissing');
        return;
      }
      const path = await downloadFromUrl(url);
      await project.startNew(typed, frame);
      enterEditor();
      await project.loadFromBackend(path);
      if (typed) await project.rename(typed);
      await cutDeadAir();
      toast.push('info', 'Download ho gaya');
    } catch (e) {
      error = `${i18n.t('new.failed')}: ${e instanceof Error ? e.message : e}`;
    } finally {
      busy = false;
    }
  }

  /** "Telegram" — the vault's own QR handshake, opened by the cloud menu. */
  function connectTelegram(): void {
    window.dispatchEvent(new CustomEvent('t9:connect-telegram'));
    toast.push('info', i18n.t('new.tgStarted'));
    open = false;
  }

  async function chooseExportFolder(): Promise<void> {
    const dir = await pickFolder();
    if (dir) exportDefaults.setDir(dir);
  }

  function pickFrame(next: ProjectFrame): void {
    frame = next;
    moreOpen = false;
  }

  function focusName(): void {
    nameEl?.focus();
    nameEl?.select();
  }

  function close(): void {
    if (busy) return;
    open = false;
  }

  // Every open starts clean: no name from the previous project, no error, 16:9,
  // and dead-air cutting off — a silent, content-removing default is a trap.
  $effect(() => {
    if (!open) return;
    name = '';
    nameTouched = false;
    frame = '16:9';
    moreOpen = false;
    linkOpen = false;
    linkUrl = '';
    advanced = false;
    deadAir = false;
    deadAirSecs = 3.0;
    busy = false;
    error = '';
    const t = setTimeout(() => nameEl?.focus(), 40);
    return () => clearTimeout(t);
  });

  // "Video Link" reveals an input instead of a tile row, so focus has to follow.
  $effect(() => {
    if (!linkOpen) return;
    const t = setTimeout(() => linkEl?.focus(), 40);
    return () => clearTimeout(t);
  });

  const mainFrames = MAIN_FRAMES;
  const extraFrames = EXTRA_FRAMES;
  const resolutions = RESOLUTIONS;
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') close();
  }}
/>

{#if open}
  <!-- The scrim is the dialog's own hit area: a click outside means cancel. -->
  <div
    class="t9-fade-in fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4 backdrop-blur-[3px]"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      tabindex="-1"
      class="t9-fade-in flex max-h-[calc(100vh-40px)] w-full max-w-[1000px] flex-col overflow-hidden
             rounded-2xl border border-nc-line bg-nc-panel shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
    >
      <!-- ------------------------------------------------------------ header -->
      <div class="flex items-start gap-4 px-9 pt-7 pb-4">
        <div
          class="mt-0.5 grid h-12 w-12 shrink-0 place-items-center rounded-full border border-nc-brand/45"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            class="text-nc-brand"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <h2
            id="new-project-title"
            class="text-[26px] leading-tight font-bold tracking-tight text-nc-txt"
          >
            {i18n.t('new.title')}
          </h2>
          <p class="mt-1 text-[13px] text-nc-mut">{i18n.t('new.sub')}</p>
        </div>
        <button
          type="button"
          onclick={close}
          class="-mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-nc-mut
                 transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
          aria-label={i18n.t('new.cancel')}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <!-- -------------------------------------------------------------- body -->
      <div class="nc-scroll min-h-0 flex-1 px-9 pb-3">
        <!-- name -->
        <div class="rounded-xl border border-nc-line px-4 pt-3 pb-4">
          <label for="new-project-name" class="text-[12.5px] font-medium text-nc-txt">
            {i18n.t('new.name')}
          </label>
          <div class="relative mt-2">
            <input
              id="new-project-name"
              bind:this={nameEl}
              bind:value={name}
              oninput={() => (nameTouched = true)}
              placeholder={i18n.t('new.untitled')}
              autocomplete="off"
              class="w-full rounded-lg border border-nc-line-2 bg-nc-panel-2/50 py-2.5 pr-11 pl-3.5
                     text-[13.5px] text-nc-txt placeholder:text-nc-mut-2
                     transition-colors duration-150 focus:border-nc-brand/70 focus:outline-none"
            />
            <button
              type="button"
              onclick={focusName}
              class="absolute top-1/2 right-1.5 grid h-7 w-7 -translate-y-1/2 place-items-center
                     rounded-md text-nc-mut transition-colors duration-150 hover:bg-white/5 hover:text-nc-txt"
              aria-label={i18n.t('new.name')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5 17.5 10.5" />
              </svg>
            </button>
          </div>
        </div>

        <!-- format -->
        <section class="mt-5">
          <div class="flex items-center gap-1.5">
            <h3 class="text-[14px] font-semibold text-nc-txt">{i18n.t('new.format')}</h3>
            <span
              class="grid h-3.5 w-3.5 place-items-center rounded-full border border-nc-mut-2
                     text-[8px] leading-none font-bold text-nc-mut-2"
              title={i18n.t('new.formatSub')}
              aria-hidden="true"
            >
              i
            </span>
          </div>
          <p class="mt-1 text-[12px] text-nc-mut-2">{i18n.t('new.formatSub')}</p>

          <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {#each mainFrames as id (id)}
              {@const f = framePreset(id)}
              <button
                type="button"
                onclick={() => pickFrame(id)}
                aria-pressed={frame === id}
                class="relative flex flex-col items-center justify-center gap-1 rounded-[10px] border
                       px-3 py-3.5 transition-[border-color,background-color] duration-150
                       {frame === id ? 'bg-nc-brand/[0.07]' : ''}"
                class:border-nc-brand={frame === id}
                class:border-nc-line={frame !== id}
                class:hover:border-nc-line-2={frame !== id}
              >
                {#if frame === id}
                  <span
                    class="absolute top-2 right-2 grid h-4 w-4 place-items-center rounded-full bg-nc-brand"
                    aria-hidden="true"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#15171b"
                      ><path
                        d="M5 13l4 4L19 7"
                        stroke-width="3"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      /></svg
                    >
                  </span>
                {/if}
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class={frame === id ? 'text-nc-brand' : 'text-nc-mut'}
                  aria-hidden="true"
                >
                  {#if id === '16:9'}
                    <rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path
                      d="M10 9.5l5 2.5-5 2.5z"
                    />
                  {:else if id === '9:16'}
                    <rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 5.5h2" />
                  {:else}
                    <rect x="4" y="4" width="16" height="16" rx="2.5" />
                  {/if}
                </svg>
                <span class="mt-1 text-[13px] font-semibold text-nc-txt">{i18n.t(f.label)}</span>
                <span class="text-[11.5px] text-nc-mut-2">{f.id}</span>
              </button>
            {/each}

            <!-- "More formats": 4:5 and 4:3 live behind it, not in a fake menu. -->
            <button
              type="button"
              onclick={() => (moreOpen = !moreOpen)}
              aria-expanded={moreOpen}
              class="relative flex flex-col items-center justify-center gap-1 rounded-[10px] border px-3 py-3.5
                     transition-[border-color,background-color] duration-150
                     {moreOpen || extraFrames.includes(frame) ? 'bg-nc-brand/[0.07]' : ''}"
              class:border-nc-brand={moreOpen || extraFrames.includes(frame)}
              class:border-nc-line={!moreOpen && !extraFrames.includes(frame)}
              class:hover:border-nc-line-2={!moreOpen && !extraFrames.includes(frame)}
            >
              {#if extraFrames.includes(frame)}
                <span
                  class="absolute top-2 right-2 grid h-4 w-4 place-items-center rounded-full bg-nc-brand"
                  aria-hidden="true"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#15171b"
                    ><path
                      d="M5 13l4 4L19 7"
                      stroke-width="3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    /></svg
                  >
                </span>
              {/if}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
                class={moreOpen || extraFrames.includes(frame) ? 'text-nc-brand' : 'text-nc-mut'}
                aria-hidden="true"
              >
                <circle cx="6" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle
                  cx="18"
                  cy="12"
                  r="1.5"
                />
              </svg>
              <span class="mt-1 text-[13px] font-semibold text-nc-txt">{i18n.t('new.more')}</span>
              <span class="text-[11.5px] text-nc-mut-2">
                {extraFrames.includes(frame) ? frame : i18n.t('new.moreSub')}
              </span>
            </button>
          </div>

          {#if moreOpen}
            <div class="mt-2 flex flex-wrap items-center gap-2">
              {#each extraFrames as id (id)}
                <button
                  type="button"
                  onclick={() => pickFrame(id)}
                  class="rounded-lg border px-3 py-1.5 text-[12px] transition-colors duration-150"
                  class:border-nc-brand={frame === id}
                  class:text-nc-brand={frame === id}
                  class:border-nc-line={frame !== id}
                  class:text-nc-mut={frame !== id}
                  class:hover:border-nc-line-2={frame !== id}
                >
                  {framePreset(id).id} · {i18n.t(framePreset(id).label)}
                </button>
              {/each}
            </div>
          {/if}
        </section>

        <div class="my-5 h-px bg-nc-line"></div>

        <!-- import media -->
        <section>
          <h3 class="text-[14px] font-semibold text-nc-txt">
            {i18n.t('new.import')}
            <span class="font-normal text-nc-mut-2">({i18n.t('new.optional')})</span>
          </h3>

          {#if linkOpen}
            <!-- --------------------------------------------------- link input -->
            <p class="mt-1 text-[12px] text-nc-mut-2">{i18n.t('new.linkTitle')}</p>
            <div class="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                bind:this={linkEl}
                bind:value={linkUrl}
                type="url"
                inputmode="url"
                placeholder={i18n.t('new.linkPlaceholder')}
                class="min-w-0 flex-1 rounded-lg border border-nc-line-2 bg-nc-panel-2/50 px-3.5 py-2.5
                       text-[13px] text-nc-txt placeholder:text-nc-mut-2
                       transition-colors duration-150 focus:border-nc-brand/70 focus:outline-none"
                onkeydown={(e) => {
                  if (e.key === 'Enter') void createFromLink();
                }}
              />
              <button
                type="button"
                onclick={() => {
                  linkOpen = false;
                  linkUrl = '';
                  error = '';
                }}
                class="rounded-lg border border-nc-line px-3.5 py-2.5 text-[12.5px] text-nc-mut
                       transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
              >
                {i18n.t('new.linkBack')}
              </button>
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-nc-mut-2">{i18n.t('new.linkHint')}</p>
          {:else}
            <p class="mt-1 text-[12px] text-nc-mut-2">{i18n.t('new.importSub')}</p>
            <div class="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <!-- This PC -->
              <button
                type="button"
                onclick={() => void createFromPc()}
                disabled={busy}
                class="group relative flex items-center gap-2.5 rounded-lg border border-nc-line px-3 py-2.5
                       text-left transition-colors duration-150 hover:border-nc-line-2 disabled:opacity-50"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0 text-nc-mut"
                  aria-hidden="true"
                >
                  <rect x="2.5" y="4" width="19" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-semibold text-nc-txt"
                    >{i18n.t('new.pc')}</span
                  >
                  <span class="block truncate text-[10.5px] text-nc-mut-2"
                    >{i18n.t('new.pcSub')}</span
                  >
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="shrink-0 text-nc-mut-2"
                  aria-hidden="true"
                >
                  <path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>

              <!-- Video Link -->
              <button
                type="button"
                onclick={() => (linkOpen = true)}
                disabled={busy}
                class="group relative flex items-center gap-2.5 rounded-lg border border-nc-line px-3 py-2.5
                       text-left transition-colors duration-150 hover:border-nc-line-2 disabled:opacity-50"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0 text-nc-mut"
                  aria-hidden="true"
                >
                  <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path
                    d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"
                  />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-semibold text-nc-txt"
                    >{i18n.t('new.link')}</span
                  >
                  <span class="block truncate text-[10.5px] text-nc-mut-2"
                    >{i18n.t('new.linkSub')}</span
                  >
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="shrink-0 text-nc-mut-2"
                  aria-hidden="true"
                >
                  <path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>

              <!-- Telegram - honest about needing the vault handshake first. -->
              <button
                type="button"
                onclick={connectTelegram}
                disabled={busy}
                class="group relative flex items-center gap-2.5 rounded-lg border border-nc-line px-3 py-2.5
                       text-left transition-colors duration-150 hover:border-nc-line-2 disabled:opacity-50"
              >
                <span
                  class="absolute -top-1.5 right-2 rounded-full bg-nc-brand px-1.5 py-[1px]
                         text-[8.5px] font-bold tracking-wide text-nc-bg"
                >
                  {i18n.t('new.tgConnect')}
                </span>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0 text-nc-mut"
                  aria-hidden="true"
                >
                  <path d="M21 3 3 10.5l6 2.3 2.3 6L21 3z" /><path d="m9 13 5-4" />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-semibold text-nc-txt"
                    >{i18n.t('new.tg')}</span
                  >
                  <span class="block truncate text-[10.5px] text-nc-mut-2"
                    >{i18n.t('new.tgSub')}</span
                  >
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="shrink-0 text-nc-mut-2"
                  aria-hidden="true"
                >
                  <path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>

              <!-- Empty Project -->
              <button
                type="button"
                onclick={createEmpty}
                disabled={busy}
                class="group relative flex items-center gap-2.5 rounded-lg border border-nc-line px-3 py-2.5
                       text-left transition-colors duration-150 hover:border-nc-line-2 disabled:opacity-50"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0 text-nc-mut"
                  aria-hidden="true"
                >
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path
                    d="M14 3v5h5"
                  />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-semibold text-nc-txt"
                    >{i18n.t('new.empty')}</span
                  >
                  <span class="block truncate text-[10.5px] text-nc-mut-2"
                    >{i18n.t('new.emptySub')}</span
                  >
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="shrink-0 text-nc-mut-2"
                  aria-hidden="true"
                >
                  <path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          {/if}
        </section>

        <!-- advanced -->
        <section class="mt-4">
          <button
            type="button"
            onclick={() => (advanced = !advanced)}
            aria-expanded={advanced}
            class="flex w-full items-center gap-3 rounded-xl border border-nc-line px-4 py-3 text-left
                   transition-colors duration-150 hover:border-nc-line-2"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-nc-mut"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" /><path
                d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
              />
            </svg>
            <span class="min-w-0 flex-1">
              <span class="block text-[12.5px] font-semibold text-nc-txt"
                >{i18n.t('new.advanced')}</span
              >
              <span class="block text-[11px] text-nc-mut-2">{i18n.t('new.advancedSub')}</span>
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-nc-mut transition-transform duration-150"
              class:rotate-180={advanced}
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {#if advanced}
            <div
              class="mt-2 grid gap-3 rounded-xl border border-nc-line px-4 py-3.5 sm:grid-cols-2"
            >
              <div class="min-w-0">
                <p class="text-[11px] font-medium text-nc-mut">{i18n.t('new.exportDir')}</p>
                <div class="mt-1.5 flex items-center gap-2">
                  <span
                    class="min-w-0 flex-1 truncate rounded-md border border-nc-line bg-nc-panel-2/40 px-2.5 py-1.5
                           font-mono text-[11px] text-nc-mut"
                    title={exportDefaults.dir}
                  >
                    {exportDefaults.dir || i18n.t('new.askEveryTime')}
                  </span>
                  <button
                    type="button"
                    onclick={() => void chooseExportFolder()}
                    class="shrink-0 rounded-md border border-nc-line px-2.5 py-1.5 text-[11.5px] text-nc-txt
                           transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
                  >
                    {i18n.t('new.choose')}
                  </button>
                </div>
              </div>

              <div class="min-w-0">
                <label for="new-project-resolution" class="text-[11px] font-medium text-nc-mut">
                  {i18n.t('new.exportRes')}
                </label>
                <select
                  id="new-project-resolution"
                  value={exportDefaults.resolution}
                  onchange={(e) =>
                    exportDefaults.setResolution(
                      (e.currentTarget as HTMLSelectElement).value as ResolutionId
                    )}
                  class="mt-1.5 w-full rounded-md border border-nc-line bg-nc-panel-2/40 px-2.5 py-1.5
                         text-[11.5px] text-nc-txt focus:border-nc-brand/70 focus:outline-none"
                >
                  {#each resolutions as r (r.id)}
                    <option value={r.id}>{r.label} — {r.note}</option>
                  {/each}
                </select>
              </div>

              <!--
                Dead air — rescued from the old Media page.
                The scan runs on the imported file with FFmpeg `silencedetect`;
                the result marks transcript lines that fall inside a pause.
                Off by default: cutting content without being asked is worse
                than leaving a pause in.
              -->
              <div class="min-w-0 border-t border-nc-line pt-3 sm:col-span-2">
                <label class="flex cursor-pointer items-center gap-2.5 select-none">
                  <input
                    type="checkbox"
                    bind:checked={deadAir}
                    class="h-3.5 w-3.5 accent-nc-brand"
                  />
                  <span class="text-[11.5px] font-medium text-nc-txt">
                    {i18n.t('new.deadAir')}
                  </span>
                  {#if !isTauri()}
                    <span class="text-[10px] text-nc-mut-2">(desktop)</span>
                  {/if}
                </label>
                <p class="mt-1 text-[10.5px] leading-relaxed text-nc-mut-2">
                  {i18n.t('new.deadAirHint')}
                </p>
                {#if deadAir}
                  <div class="mt-2 flex items-center gap-3">
                    <label for="new-dead-air" class="text-[11px] text-nc-mut">
                      {i18n.t('new.deadAirPause')}
                    </label>
                    <input
                      id="new-dead-air"
                      type="range"
                      min="0.5"
                      max="10"
                      step="0.5"
                      bind:value={deadAirSecs}
                      class="flex-1 accent-nc-brand"
                    />
                    <span class="w-10 text-right font-mono text-[11.5px] text-nc-txt">
                      {deadAirSecs.toFixed(1)}s
                    </span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </section>

        {#if error}
          <p class="mt-3 text-[12px] leading-relaxed text-nc-red" role="alert">{error}</p>
        {/if}
      </div>

      <!-- ------------------------------------------------------------ footer -->
      <div class="flex items-center justify-end gap-3 px-9 py-4">
        <button
          type="button"
          onclick={close}
          disabled={busy}
          class="rounded-lg border border-nc-line px-5 py-2.5 text-[13px] font-medium text-nc-txt
                 transition-colors duration-150 hover:border-nc-line-2 disabled:opacity-50"
        >
          {i18n.t('new.cancel')}
        </button>
        <button
          type="button"
          onclick={() => (linkOpen ? void createFromLink() : void createEmpty())}
          disabled={busy}
          class="inline-flex items-center gap-2 rounded-lg bg-nc-brand px-5 py-2.5 text-[13px]
                 font-semibold text-nc-bg transition-[filter] duration-150 hover:brightness-110
                 disabled:opacity-60"
        >
          {#if busy}
            <span
              class="t9-spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px] border-nc-bg/30 border-t-nc-bg"
              aria-hidden="true"
            ></span>
            {i18n.t('new.busy')}
          {:else}
            {i18n.t('new.create')}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h13M13 6l6 6-6 6" />
            </svg>
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
