<script lang="ts">
  import { media } from '../../stores/media.svelte';
  import { project } from '../../stores/project.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    checkYtDlp,
    downloadFromUrl,
    isTauri,
    pickVideos,
    pickImageFile,
    importThumbnail,
    assetUrl
  } from '../../ipc';
  import { menu } from '../../stores/menu.svelte';
  import type { MenuItem } from '../../types';
  import { fmtSize } from '../../utils';

  /**
   * "My media" — Clipchamp's left panel.
   *
   * Import comes from three places: the **file manager** (several files at
   * once), a **link** (YouTube and anything `yt-dlp` understands), or the
   * **Telegram vault**. A file that arrives while a project is open becomes a
   * new project; the library keeps the old one so it can be reopened.
   */
  let renamingId = $state<string | null>(null);
  let draft = $state('');
  let busy = $state(false);

  /** The link-import dialog. */
  let linkOpen = $state(false);
  let linkUrl = $state('');
  let linkBusy = $state(false);

  const collapsed = $derived(layout.sourcePanelCollapsed);

  const IMPORT_ITEMS: MenuItem[] = [
    {
      id: 'files',
      label: 'From file manager',
      icon: 'folder',
      secondary: 'multiple files at once'
    },
    { id: 'link', label: 'From a link', icon: 'cloud', secondary: 'YouTube / any yt-dlp URL' },
    {
      id: 'telegram',
      label: 'From Telegram vault',
      icon: 'telegram',
      secondary: 'your saved chats'
    }
  ];

  const FILE_ITEMS: MenuItem[] = [
    { id: 'rename', label: 'Rename', icon: 'rename' },
    { id: 'thumb', label: 'Upload thumbnail', icon: 'image' },
    { id: 'locate', label: 'Open file location', icon: 'folder' },
    { id: 'div', label: '', divider: true },
    { id: 'remove', label: 'Remove from library', icon: 'trash', danger: true }
  ];

  async function importFromFiles() {
    const paths = await pickVideos();
    if (!paths.length) return;
    busy = true;
    toast.push('info', `${paths.length} file import ho rahi hai…`);
    try {
      await project.importPaths(paths);
      toast.push('info', `${paths.length} file library me add ho gayi`);
    } catch (e) {
      toast.push('warn', `Import failed: ${e instanceof Error ? e.message : e}`);
    }
    busy = false;
  }

  async function importFromLink() {
    linkOpen = true;
    linkBusy = false;
  }

  async function runLinkImport() {
    const url = linkUrl.trim();
    if (!url) return;
    linkBusy = true;
    const ok = await checkYtDlp().catch(() => false);
    if (!ok) {
      toast.push('warn', 'yt-dlp installed nahi hai — pip install yt-dlp');
      linkBusy = false;
      return;
    }
    toast.push('info', 'Download ho raha hai (yt-dlp)…');
    try {
      const path = await downloadFromUrl(url);
      linkOpen = false;
      linkUrl = '';
      await project.importPaths([path]);
      toast.push('info', 'Download ho gaya — naya project khul gaya');
    } catch (e) {
      toast.push('warn', `Download failed: ${e instanceof Error ? e.message : e}`);
    }
    linkBusy = false;
  }

  function importFromTelegram() {
    // The vault lives behind the cloud menu's QR / MTProto handshake.
    window.dispatchEvent(new CustomEvent('t9:connect-telegram'));
    toast.push('info', 'Telegram vault se connect ho raha hai…');
  }

  function pickImport(id: string) {
    if (id === 'files') void importFromFiles();
    else if (id === 'link') void importFromLink();
    else if (id === 'telegram') importFromTelegram();
  }

  function openImportMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.show(IMPORT_ITEMS, Math.round(r.left - 100), Math.round(r.bottom + 4), pickImport);
  }

  function openFileMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.show(FILE_ITEMS, Math.round(r.left - 160), Math.round(r.bottom + 4), (choice) =>
      pickFile(id, choice)
    );
  }

  function pickFile(id: string, choice: string) {
    const e = media.get(id);
    if (!e) return;
    if (choice === 'rename') {
      draft = e.asset.name;
      renamingId = id;
    } else if (choice === 'thumb') {
      void uploadThumbnail(id);
    } else if (choice === 'locate') {
      if (e.path) toast.push('info', e.path);
      else toast.push('warn', 'Browser mode me path nahi hota');
    } else if (choice === 'remove') {
      media.remove(id);
    }
  }

  /**
   * Put a hand-picked picture on a library entry.
   *
   * The picture is copied into the app's own cache by Rust - the library keeps
   * a path, never bytes, and the original file can be moved or deleted without
   * breaking the poster. Browser mode has no file dialog, so there the frame
   * the app picked itself simply stays.
   */
  async function uploadThumbnail(id: string) {
    const e = media.get(id);
    if (!e) return;
    const picked = await pickImageFile();
    if (!picked) return;
    try {
      // The entry's own path is the stable key; an entry that came from a
      // browser drag-and-drop has none, so fall back to its asset id.
      const key = e.path ?? e.asset.id;
      if (isTauri()) {
        const stored = await importThumbnail(key, picked);
        media.setCustomThumb(id, stored);
        toast.push('info', 'Thumbnail lag gaya');
      } else {
        // The browser has no app cache to copy into, so the picked file is
        // streamed from a blob for the session.
        media.setCustomThumb(id, picked);
        toast.push('info', 'Thumbnail lag gaya (browser mode - is session me hi rahega)');
      }
    } catch (err) {
      toast.push('warn', `Thumbnail nahi laga: ${String(err)}`);
    }
  }

  function rename(id: string, name: string) {
    const e = media.get(id);
    if (!e) return;
    e.asset.name = name;
    media.entries = [...media.entries];
    renamingId = null;
  }

  /** Same pattern as the transcript separator — drag the right edge, dbl-click resets. */
  function startWidthResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = layout.mediaWidth;
    const move = (ev: PointerEvent) => layout.setMediaWidth(startW + (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

<aside
  class="relative flex min-h-0 shrink-0 flex-col
         {collapsed ? 'w-[44px]' : 'border-r border-nc-line bg-nc-panel'}"
  style={collapsed ? undefined : `width:${layout.mediaWidth}px`}
>
  <div class="flex h-10 shrink-0 items-center justify-between px-2.5">
    {#if !collapsed}
      <h2 class="text-[13px] font-semibold">My media</h2>
    {/if}
    <button
      onclick={() => layout.setSourcePanelCollapsed(!layout.sourcePanelCollapsed)}
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title={collapsed ? 'Expand panel (Ctrl+Alt+2)' : 'Collapse panel (Ctrl+Alt+2)'}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" />
      </svg>
    </button>
  </div>

  {#if !collapsed}
    <!-- Import split button: main = file manager, caret = the three sources -->
    <div class="px-2.5 pb-2.5">
      <div class="flex">
        <button
          onclick={importFromFiles}
          disabled={busy}
          class="flex flex-1 items-center justify-center gap-1.5 rounded-l-md bg-nc-brand py-1.5 text-[12px] font-semibold text-nc-bg hover:brightness-110 disabled:opacity-50"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
          </svg>
          Import media
        </button>
        <button
          onclick={openImportMenu}
          disabled={busy}
          class="grid w-6 place-items-center rounded-r-md bg-nc-brand-dim text-nc-bg hover:brightness-110 disabled:opacity-50"
          title="Import options — file manager / link / Telegram"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- library -->
    <div class="nc-scroll min-h-0 flex-1 px-2.5 pb-3" role="listbox" aria-label="Content sidebar">
      {#if media.entries.length === 0}
        <div
          class="grid h-56 place-items-center rounded-lg border-2 border-dashed border-nc-line px-4 text-center"
        >
          <div>
            <svg
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              class="mx-auto mb-2 text-nc-mut-2"
            >
              <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
            </svg>
            <p class="text-[11px] leading-relaxed text-nc-mut-2">
              Drag &amp; drop media from your device to import<br />Videos, audio, images, GIFs
            </p>
          </div>
        </div>
      {:else}
        <ul class="space-y-2">
          {#each media.entries as e (e.asset.id)}
            <li
              class="group relative cursor-pointer"
              role="option"
              aria-selected={e.inUse}
              tabindex="0"
              aria-label="{e.asset.name}, {e.durationLabel}, {e.inUse
                ? 'Current project'
                : 'In library'}"
              onclick={() => project.openLibraryEntry(e.asset.id)}
              onkeydown={(ev) => {
                if (ev.key === 'Enter') project.openLibraryEntry(e.asset.id);
              }}
            >
              <div
                class="relative aspect-video overflow-hidden rounded-md border bg-nc-bg
                       {e.inUse ? 'border-nc-brand' : 'border-nc-line'}"
              >
                {#if e.customThumb}
                  <!-- The picture the user chose - the file lives in the app's
                       cache and is streamed through the asset protocol, so the
                       library still holds paths, never bytes. -->
                  <img
                    src={assetUrl(e.customThumb)}
                    alt=""
                    class="h-full w-full object-cover"
                    style="opacity:{e.phase === 'loading' ? 0.6 : 1}"
                  />
                {:else if e.asset.url}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video
                    src={e.asset.url}
                    muted
                    playsinline
                    preload="metadata"
                    class="h-full w-full object-cover"
                    style="opacity:{e.phase === 'loading' ? 0.6 : 1}"
                  ></video>
                {:else}
                  <div class="grid h-full w-full place-items-center text-nc-mut-2">
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" />
                    </svg>
                  </div>
                {/if}

                {#if e.phase === 'loading'}
                  <div class="absolute right-1.5 bottom-1.5 left-1.5">
                    <span class="mb-1 block font-mono text-[9px] text-white/90">
                      {Math.round(e.progress * 100)}%
                    </span>
                    <div class="h-[3px] overflow-hidden rounded-full bg-white/25">
                      <div
                        class="h-full bg-white/90 transition-[width]"
                        style="width:{e.progress * 100}%"
                      ></div>
                    </div>
                  </div>
                {/if}

                <!-- More options -->
                <button
                  onclick={(ev) => openFileMenu(e.asset.id, ev)}
                  class="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-nc-panel-2"
                  title="More options"
                  aria-label="More options"
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
              </div>

              <div class="mt-1 flex items-start gap-1">
                {#if renamingId === e.asset.id}
                  <input
                    bind:value={draft}
                    onblur={() => rename(e.asset.id, draft.trim() || e.asset.name)}
                    onkeydown={(ev) => {
                      if (ev.key === 'Enter') rename(e.asset.id, draft.trim() || e.asset.name);
                      if (ev.key === 'Escape') renamingId = null;
                    }}
                    class="min-w-0 flex-1 rounded border border-nc-brand bg-nc-bg px-1 text-[10px] leading-4 text-nc-txt outline-none"
                  />
                {:else}
                  <span
                    class="min-w-0 flex-1 truncate text-[10px] leading-4 text-nc-mut"
                    title={e.asset.name}
                  >
                    {e.asset.name}
                  </span>
                {/if}
                {#if e.inUse}
                  <span
                    class="mt-0.5 grid h-3 w-3 shrink-0 place-items-center rounded-full bg-nc-brand/25 text-nc-brand"
                    title="Current project"
                  >
                    <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                      <path
                        d="M1 6a5 5 0 1 1 10 0A5 5 0 0 1 1 6Zm7.35-.9a.5.5 0 1 0-.7-.7L5.5 6.54 4.35 5.4a.5.5 0 1 0-.7.7l1.5 1.5c.2.2.5.2.7 0l2.5-2.5Z"
                      />
                    </svg>
                  </span>
                {/if}
              </div>
              <p class="font-mono text-[9px] text-nc-mut-2">
                {e.durationLabel}
                {#if e.asset.sizeBytes > 0}· {fmtSize(e.asset.sizeBytes)}{/if}
              </p>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if !collapsed}
    <!-- right-edge separator — drag to widen, double-click resets to 248px -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize media panel"
      title="Drag to resize — double-click to reset"
      onpointerdown={startWidthResize}
      ondblclick={() => layout.resetMediaWidth()}
      class="absolute inset-y-0 right-0 w-[3px] cursor-col-resize bg-nc-line transition-colors hover:bg-nc-brand/60"
    ></div>
  {/if}
</aside>

{#if linkOpen}
  <!-- link import dialog -->
  <div
    class="fixed inset-0 z-[350] grid place-items-center bg-black/70 p-6"
    role="dialog"
    aria-modal="true"
    aria-label="Import from a link"
  >
    <div class="w-full max-w-md rounded-xl border border-nc-line-2 bg-nc-panel p-5 shadow-2xl">
      <h3 class="text-sm font-bold">Import from a link</h3>
      <p class="mt-1 text-[11px] leading-relaxed text-nc-mut">
        YouTube ya koi bhi URL jo <code class="text-nc-brand">yt-dlp</code> samajhta ho. Video seedha
        disk pe download hoga — app ke memory me nahi aayega.
      </p>
      <input
        bind:value={linkUrl}
        onkeydown={(ev) => {
          if (ev.key === 'Enter') runLinkImport();
          if (ev.key === 'Escape') linkOpen = false;
        }}
        placeholder="https://www.youtube.com/watch?v=…"
        class="mt-3 w-full rounded-lg border border-nc-line bg-nc-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-nc-brand/60"
      />
      <div class="mt-4 flex gap-2">
        <button
          onclick={() => (linkOpen = false)}
          class="flex-1 rounded-lg border border-nc-line py-2 text-xs text-nc-mut hover:bg-nc-panel-2"
        >
          Cancel
        </button>
        <button
          onclick={runLinkImport}
          disabled={linkBusy || !linkUrl.trim()}
          class="flex-1 rounded-lg bg-nc-brand py-2 text-xs font-bold text-nc-bg hover:brightness-110 disabled:opacity-40"
        >
          {linkBusy ? 'Downloading…' : 'Download'}
        </button>
      </div>
    </div>
  </div>
{/if}
