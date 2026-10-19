<script lang="ts">
  /**
   * "My media" panel — the Clipchamp asset browser.
   *
   * `Import media` opens the native Tauri file dialog and probes the pick with
   * ffprobe through ipc.ts (never a raw `invoke`, never an `<input type=file>` —
   * a 5 GB file on a spinning disk needs the OS picker). Dropped files are
   * accepted the same way: the path crosses the boundary, the bytes stay on
   * disk, and ffprobe reads only the header.
   *
   * Each asset is a Clipchamp tile: thumbnail, title, duration, an
   * "in use" checkmark when it is on the timeline, and a "…" button that
   * opens the same three-row menu Clipchamp uses — Rename, Open file
   * location, Create a new video. Right-clicking the tile opens the same
   * menu, which is how the real app's context menu behaves.
   *
   * Drag & drop is native (Tauri `onDragDropEvent`), not HTML5 DnD: WebView2
   * never exposes a dropped file's absolute path on `DataTransfer`, and reading
   * the blob instead would mean pulling the whole file into the heap — which
   * AGENTS.md §1 forbids outright. `onAppDrop` in ipc.ts hands back real paths.
   *
   * The FFmpeg/hardware readout at the bottom is the old SourceBar's job,
   * kept: environment problems must surface here rather than three chunks
   * deep into an export.
   */
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    MEDIA_EXTENSIONS,
    checkFfmpeg,
    defaultDbPath,
    detectHardware,
    errorMessage,
    loadProjects,
    onAppDrop,
    revealInFolder,
    saveProject,
  } from "../../ipc";
  import { formatBytes, project } from "../../stores/project.svelte";
  import { cc } from "../../stores/cc.svelte";
  import { shortcuts } from "../../stores/shortcuts.svelte";
  import CcMenu from "./CcMenu.svelte";
  import type { HardwareSupport, Project } from "../../types";

  let hardware = $state<HardwareSupport | null>(null);
  let ffmpegVersion = $state<string | null>(null);
  let envError = $state<string | null>(null);
  let recentProjects = $state<Project[]>([]);

  /** Which tile's "…" / context menu is open — `null` when all are closed. */
  let menuFor = $state<string | null>(null);
  /** Target of an in-progress rename, identified the same way as `menuFor`. */
  let renaming = $state<string | null>(null);
  let draft = $state("");
  let renameField: HTMLInputElement | null = $state(null);

  /** Files currently hovering over the panel — highlighted so the drop is
   *  obvious before it happens, exactly like Clipchamp's asset grid. */
  let dragOver = $state(false);

  async function checkEnvironment() {
    envError = null;
    try {
      ffmpegVersion = await checkFfmpeg();
      hardware = await detectHardware();
    } catch (err) {
      envError = errorMessage(err);
    }
  }

  async function fetchRecent() {
    try {
      const db = await defaultDbPath();
      recentProjects = await loadProjects(db);
    } catch {
      recentProjects = [];
    }
  }

  $effect(() => {
    void checkEnvironment();
    void fetchRecent();
  });

  // `Alt + I` — Clipchamp's "Go to import media".
  $effect(() => {
    return shortcuts.bind("import", () => void importMedia(), "always");
  });

  // Accept files dropped anywhere on this panel.
  $effect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await onAppDrop(
        (paths) => {
          if (cancelled) return;
          void importPaths(paths);
        },
        (hover) => {
          if (!cancelled) dragOver = hover;
        },
      );
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  const encoderLabel = $derived(
    hardware
      ? hardware.qsv
        ? "Intel QuickSync"
        : hardware.nvenc
          ? "NVIDIA NVENC"
          : hardware.amf
            ? "AMD AMF"
            : "CPU only"
      : null,
  );

  /** First path wins — the rest are recorded so they appear in history. */
  async function importPaths(paths: string[]): Promise<void> {
    const media = paths.filter((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
    });
    if (media.length === 0) return;
    try {
      await project.load(media[0]);
      cc.projectName = media[0].split(/[\\/]/).pop() ?? cc.projectName;
      await fetchRecent();
    } catch (err) {
      project.error = errorMessage(err);
    }
  }

  async function importMedia() {
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        title: "Import media",
        filters: [{ name: "Media", extensions: [...MEDIA_EXTENSIONS] }],
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length > 0) await importPaths(paths);
    } catch (err) {
      project.error = errorMessage(err);
    }
  }

  // ── The "…" / context menu ──────────────────────────────────────────────
  function openMenu(id: string, event: MouseEvent): void {
    // Keep the click from also firing the row's load button underneath.
    event.preventDefault();
    event.stopPropagation();
    menuFor = menuFor === id ? null : id;
    renaming = null;
  }

  /** Source path behind whichever row owns the open menu. */
  function menuTargetPath(id: string | null): string | null {
    if (id === "current") return project.info?.path ?? null;
    if (id === null) return null;
    return recentProjects.find((r) => r.id === id)?.sourcePath ?? null;
  }

  function startRename(id: string, event: MouseEvent): void {
    event.stopPropagation();
    const path = menuTargetPath(id);
    if (!path) return;
    draft =
      id === "current" ? cc.projectName : (recentProjects.find((r) => r.id === id)?.name ?? "");
    renaming = id;
    // The field mounts inside the menu on the next frame; focus it after.
    queueMicrotask(() => {
      renameField?.focus();
      renameField?.select();
    });
  }

  /**
   * Persist a rename.
   *
   * `saveProject` upserts on `id`. Rows created by `project.load` use the
   * source path as their id; older rows may not, so the row is looked up by
   * `sourcePath` first — otherwise the save would add a second entry instead
   * of renaming the existing one.
   */
  async function commitRename(): Promise<void> {
    const id = renaming;
    const name = draft.trim();
    renaming = null;
    menuFor = null;
    if (!id || !name) return;

    const path = menuTargetPath(id);
    if (!path) return;
    if (id === "current") cc.projectName = name;

    try {
      const dbPath = await defaultDbPath();
      const rows = await loadProjects(dbPath);
      const existing = rows.find((r) => r.sourcePath === path);
      const duration =
        id === "current" ? (project.info?.durationSecs ?? 0) : (existing?.durationSecs ?? 0);
      await saveProject(dbPath, existing?.id ?? path, name, path, duration, Date.now());
      await fetchRecent();
    } catch {
      // In-memory name already applied; the row catches up on the next save.
    }
  }

  function cancelRename(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      renaming = null;
      menuFor = null;
    }
  }

  async function openLocation(id: string): Promise<void> {
    const path = menuTargetPath(id);
    menuFor = null;
    if (!path) return;
    try {
      await revealInFolder(path);
    } catch {
      // Explorer failing to open should not interrupt the edit.
    }
  }

  function createNewVideo(id: string): void {
    if (id !== "current") void openLocation(id);
    menuFor = null;
    project.clear();
    cc.projectName = "Video Project 1";
    cc.openEditor();
  }

  /**
   * Open a tile's menu from a right-click, the way Clipchamp's asset context
   * menu works. Cancels the browser's own menu so the two never stack.
   */
  function onContextMenu(id: string, event: MouseEvent): void {
    event.preventDefault();
    menuFor = id;
    renaming = null;
  }

  /** Duration in seconds → the `0:36` label a Clipchamp tile shows. */
  function tileDuration(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** A tile is "in use" when its source is the loaded project. */
  function inUse(rp: Project): boolean {
    return project.info?.path === rp.sourcePath;
  }

  async function loadProject(rp: Project): Promise<void> {
    if (project.info?.path !== rp.sourcePath) {
      await project.load(rp.sourcePath);
      cc.projectName = rp.name;
      await fetchRecent();
    }
  }
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-3 p-3" role="group" aria-label="My media">
  <!-- Split button: label opens the picker, the caret will grow a menu. -->
  <div class="flex">
    <button
      type="button"
      class="cc-btn cc-btn-primary flex-1 rounded-r-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cc-purple/40"
      onclick={importMedia}
      disabled={project.loading}
    >
      {project.loading ? "Importing…" : "Import media"}
    </button>
    <button
      type="button"
      class="cc-btn cc-btn-primary rounded-l-none border-l border-black/25 px-2"
      title="More import sources"
      onclick={importMedia}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M2 4.2 6 8l4-3.8z" />
      </svg>
    </button>
  </div>

  <!-- Drag-over highlight — the panel itself is the drop target. -->
  {#if dragOver}
    <div
      class="pointer-events-none absolute inset-2 z-20 rounded-lg border-2 border-dashed
        border-cc-purple bg-cc-purple/10"
      role="presentation"
    >
      <div class="flex h-full items-center justify-center">
        <span class="text-[12.5px] font-semibold text-cc-link">Drop to import</span>
      </div>
    </div>
  {/if}

  <!-- Imported file summary — real ffprobe facts, not a placeholder. -->
  {#if project.info}
    {@const currentId = "current"}
    <div
      class="cc-panel group relative flex items-start gap-2 p-2.5"
      role="group"
      aria-label="Current media"
      oncontextmenu={(e) => onContextMenu(currentId, e)}
    >
      <div class="h-10 w-16 shrink-0 rounded bg-black"></div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[12px] font-semibold text-cc-text" title={project.info.path}>
          {project.info.path.split(/[\\/]/).pop()}
        </div>
        <div class="cc-sub mono">
          {project.durationLabel} · {formatBytes(project.info.sizeBytes)}
        </div>
      </div>

      <button
        type="button"
        class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded
          text-cc-text-3 opacity-0 transition hover:bg-cc-tint hover:text-cc-text
          focus-visible:opacity-100 group-hover:opacity-100"
        style="opacity: {menuFor === currentId ? 1 : ''}"
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={menuFor === currentId}
        onclick={(e) => openMenu(currentId, e)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {#if menuFor === currentId}
        <CcMenu align="end" label="Media options" onclose={() => (menuFor = null)}>
          {#if renaming === currentId}
            <div class="flex flex-col gap-1.5 p-1.5">
              <span class="cc-menu-sub">Rename project</span>
              <input
                class="cc-menu-input"
                bind:this={renameField}
                bind:value={draft}
                aria-label="Project name"
                onkeydown={cancelRename}
                onblur={() => void commitRename()}
              />
            </div>
          {:else}
            <button
              type="button"
              class="cc-menu-item"
              role="menuitem"
              onclick={(e) => startRename(currentId, e)}
            >
              <span class="cc-menu-icon">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M8.5 2a.5.5 0 0 0 0 1h1v14h-1a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-1V3h1a.5.5 0 0 0 0-1h-3Zm-4 2h4v1h-4C3.67 5 3 5.67 3 6.5v7c0 .83.67 1.5 1.5 1.5h4v1h-4A2.5 2.5 0 0 1 2 13.5v-7A2.5 2.5 0 0 1 4.5 4Zm11 11h-4v1h4a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 4h-4v1h4c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">Rename</span>
            </button>

            <button
              type="button"
              class="cc-menu-item"
              data-lines="2"
              role="menuitem"
              onclick={() => void openLocation(currentId)}
            >
              <span class="cc-menu-icon">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M4.5 3A2.5 2.5 0 0 0 2 5.5v9A2.5 2.5 0 0 0 4.5 17h11a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 5H9.7L8.23 3.51A1.75 1.75 0 0 0 6.98 3H4.5ZM3 5.5C3 4.67 3.67 4 4.5 4h2.48c.2 0 .4.08.53.22L8.8 5.5 7.44 6.85a.5.5 0 0 1-.35.15H3V5.5ZM3 8h4.09c.4 0 .78-.16 1.06-.44L9.7 6h5.79c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V8Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">
                <span>Open file location</span>
                <span class="cc-menu-sub">
                  {project.info.path.split(/[\\/]/).slice(0, -1).join(" › ")}
                </span>
              </span>
            </button>

            <hr class="cc-menu-divider" />

            <button
              type="button"
              class="cc-menu-item"
              role="menuitem"
              onclick={() => createNewVideo(currentId)}
            >
              <span class="cc-menu-icon">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M6 10c0-.28.22-.5.5-.5h3v-3a.5.5 0 0 1 1 0v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3A.5.5 0 0 1 6 10Zm4 8a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-1a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">Create a new video</span>
            </button>
          {/if}
        </CcMenu>
      {/if}
    </div>
  {/if}

  <!-- Asset grid — Clipchamp's "My media" tile layout. -->
  <div class="flex min-h-0 flex-1 flex-col gap-1.5">
    <div class="flex items-center justify-between">
      <span class="text-[11.5px] font-semibold text-cc-text-2">Video history</span>
      <span class="text-[10px] text-cc-text-3">{recentProjects.length} saved</span>
    </div>

    {#if recentProjects.length === 0}
      <div
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2
          border-dashed border-cc-line p-4 text-center"
      >
        <svg width="46" height="40" viewBox="0 0 46 40" aria-hidden="true">
          <rect x="2" y="12" width="24" height="20" rx="4" fill="var(--color-cc-blush)" />
          <path d="M11 18.5v9l8-4.5z" fill="var(--color-cc-purple)" />
          <circle cx="32" cy="14" r="9" fill="var(--color-cc-lilac)" />
          <path d="M32 10v8M28 14h8" stroke="#fff" stroke-width="2" stroke-linecap="round" />
          <rect x="20" y="24" width="22" height="14" rx="3" fill="var(--color-cc-purple-3)" />
          <path
            d="M24 31h6M33 28v6M36.5 29.5l-3 3"
            stroke="#fff"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <p class="max-w-[190px] text-[12.5px] font-semibold leading-snug text-cc-text">
          Drag &amp; drop media from your device to import
        </p>
        <p class="text-[11.5px] text-cc-text-3">Videos, audio, images, GIFs</p>
      </div>
    {:else}
      <div class="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto pr-0.5">
        {#each recentProjects as rp (rp.id)}
          <!--
            Outer container, not a button: a nested "…" button inside a button
            is invalid HTML, so the tile is split into a load button and a
            separate menu button. Right-click anywhere on the tile opens the
            same menu, matching Clipchamp's asset context menu.
          -->
          <div
            class="cc-panel group relative flex items-stretch transition
              {inUse(rp) ? 'border-cc-purple bg-cc-tint/30' : 'hover:border-cc-purple/60'}"
            role="group"
            aria-label={rp.name}
            data-testid="asset-draggable"
            oncontextmenu={(e) => onContextMenu(rp.id, e)}
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center justify-between gap-2 p-2 text-left
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cc-purple/40"
              data-testid="click-to-add"
              onclick={() => void loadProject(rp)}
            >
              <div class="h-10 w-16 shrink-0 rounded bg-black"></div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] font-medium text-cc-text" title={rp.name}>
                  {rp.name}
                </div>
                <div class="mono text-[10.5px] text-cc-text-3">{tileDuration(rp.durationSecs)}</div>
              </div>
              {#if inUse(rp)}
                <span
                  class="flex items-center gap-1 rounded bg-cc-purple/10 px-1.5 py-0.5 text-[10px]
                    font-medium text-cc-link"
                  data-testid="in-use-checkmark"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="m5 12.5 4.5 4.5L19 7.5" />
                  </svg>
                  In use
                </span>
              {/if}
            </button>

            <button
              type="button"
              class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center
                rounded text-cc-text-3 opacity-0 transition hover:bg-cc-tint hover:text-cc-text
                focus-visible:opacity-100 group-hover:opacity-100"
              style="opacity: {menuFor === rp.id ? 1 : ''}"
              aria-label="More options for {rp.name}"
              aria-haspopup="menu"
              aria-expanded={menuFor === rp.id}
              onclick={(e) => openMenu(rp.id, e)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>

            {#if menuFor === rp.id}
              <CcMenu align="end" label="Project options" onclose={() => (menuFor = null)}>
                {#if renaming === rp.id}
                  <div class="flex flex-col gap-1.5 p-1.5">
                    <span class="cc-menu-sub">Rename project</span>
                    <input
                      class="cc-menu-input"
                      bind:this={renameField}
                      bind:value={draft}
                      aria-label="Project name"
                      onkeydown={cancelRename}
                      onblur={() => void commitRename()}
                    />
                  </div>
                {:else}
                  <button
                    type="button"
                    class="cc-menu-item"
                    role="menuitem"
                    onclick={(e) => startRename(rp.id, e)}
                  >
                    <span class="cc-menu-icon">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          d="M8.5 2a.5.5 0 0 0 0 1h1v14h-1a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-1V3h1a.5.5 0 0 0 0-1h-3Zm-4 2h4v1h-4C3.67 5 3 5.67 3 6.5v7c0 .83.67 1.5 1.5 1.5h4v1h-4A2.5 2.5 0 0 1 2 13.5v-7A2.5 2.5 0 0 1 4.5 4Zm11 11h-4v1h4a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 4h-4v1h4c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5Z"
                        />
                      </svg>
                    </span>
                    <span class="cc-menu-text">Rename</span>
                  </button>

                  <button
                    type="button"
                    class="cc-menu-item"
                    data-lines="2"
                    role="menuitem"
                    onclick={() => void openLocation(rp.id)}
                  >
                    <span class="cc-menu-icon">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          d="M4.5 3A2.5 2.5 0 0 0 2 5.5v9A2.5 2.5 0 0 0 4.5 17h11a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 5H9.7L8.23 3.51A1.75 1.75 0 0 0 6.98 3H4.5ZM3 5.5C3 4.67 3.67 4 4.5 4h2.48c.2 0 .4.08.53.22L8.8 5.5 7.44 6.85a.5.5 0 0 1-.35.15H3V5.5ZM3 8h4.09c.4 0 .78-.16 1.06-.44L9.7 6h5.79c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V8Z"
                        />
                      </svg>
                    </span>
                    <span class="cc-menu-text">
                      <span>Open file location</span>
                      <span class="cc-menu-sub">
                        {rp.sourcePath.split(/[\\/]/).slice(0, -1).join(" › ")}
                      </span>
                    </span>
                  </button>

                  <hr class="cc-menu-divider" />

                  <button
                    type="button"
                    class="cc-menu-item"
                    role="menuitem"
                    onclick={() => createNewVideo(rp.id)}
                  >
                    <span class="cc-menu-icon">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          d="M6 10c0-.28.22-.5.5-.5h3v-3a.5.5 0 0 1 1 0v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3A.5.5 0 0 1 6 10Zm4 8a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-1a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"
                        />
                      </svg>
                    </span>
                    <span class="cc-menu-text">Create a new video</span>
                  </button>
                {/if}
              </CcMenu>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if project.error}
    <div class="rounded bg-cc-cut-dim px-2 py-1.5 text-[12px] text-cc-cut" role="alert">
      {project.error}
    </div>
  {/if}

  <!-- Environment readout: one line, always visible. -->
  <div class="mono flex shrink-0 items-center gap-2 text-[10px]" aria-live="polite">
    {#if envError}
      <span
        class="rounded bg-cc-cut-dim px-2 py-0.5 text-cc-cut"
        title={envError}
        role="alert"
        aria-live="assertive"
      >
        FFmpeg not usable
      </span>
    {:else if ffmpegVersion}
      <span class="text-cc-text-3" title={ffmpegVersion}>
        ffmpeg {ffmpegVersion.replace(/^ffmpeg version /, "").split(" ")[0]}
      </span>
      <span class="text-cc-text-4">·</span>
      <span
        class="rounded px-2 py-0.5 {hardware?.qsv
          ? 'bg-cc-purple/10 text-cc-link'
          : 'bg-cc-tint text-cc-text-3'}"
        title="Hardware encoder available for export"
      >
        {encoderLabel}
      </span>
    {/if}
  </div>
</div>
