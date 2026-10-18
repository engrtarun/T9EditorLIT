<script lang="ts">
  /**
   * "My media" panel — the only rail tab that does real work today.
   *
   * `Import media` opens the native Tauri file dialog and probes the pick with
   * ffprobe through ipc.ts (never a raw `invoke`, never an <input type=file> —
   * a 5 GB file on a spinning disk needs the OS picker). Everything else in
   * this panel is the Clipchamp layout holding the slot where the media grid
   * will land once files are imported.
   *
   * The FFmpeg/hardware readout at the bottom is the old SourceBar's job,
   * kept: environment problems must surface here rather than three chunks
   * deep into an export.
   */
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    checkFfmpeg,
    defaultDbPath,
    detectHardware,
    errorMessage,
    loadProjects,
  } from "../../ipc";
  import { formatBytes, project } from "../../stores/project.svelte";
  import type { HardwareSupport, Project } from "../../types";

  let hardware = $state<HardwareSupport | null>(null);
  let ffmpegVersion = $state<string | null>(null);
  let envError = $state<string | null>(null);
  let recentProjects = $state<Project[]>([]);

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

  async function importMedia() {
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        title: "Import media",
        filters: [
          {
            name: "Media",
            extensions: ["mp4", "mkv", "mov", "webm", "mp3", "wav", "png", "jpg", "gif"],
          },
        ],
      });
      const first = Array.isArray(picked) ? picked[0] : picked;
      if (first) {
        await project.load(first);
        await fetchRecent();
      }
    } catch (err) {
      project.error = errorMessage(err);
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
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
      class="cc-btn cc-btn-primary rounded-l-none border-l border-white/25 px-2"
      title="More import sources"
      onclick={importMedia}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M2 4.2 6 8l4-3.8z" />
      </svg>
    </button>
  </div>

  <!-- Imported file summary — real ffprobe facts, not a placeholder. -->
  {#if project.info}
    <div class="cc-panel flex items-start gap-2 p-2.5">
      <div class="h-10 w-16 shrink-0 rounded bg-black"></div>
      <div class="min-w-0">
        <div class="truncate text-[12px] font-semibold text-cc-text" title={project.info.path}>
          {project.info.path.split(/[\\/]/).pop()}
        </div>
        <div class="cc-sub mono">
          {project.durationLabel} · {formatBytes(project.info.sizeBytes)}
        </div>
      </div>
    </div>
  {/if}

  <!-- Video history list -->
  {#if recentProjects.length > 0}
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <span class="text-[11.5px] font-semibold text-cc-text-2">Video history</span>
        <span class="text-[10px] text-cc-text-3">{recentProjects.length} saved</span>
      </div>
      <div class="flex max-h-40 flex-col gap-1 overflow-y-auto pr-0.5">
        {#each recentProjects as rp (rp.id)}
          <button
            type="button"
            class="cc-panel flex items-center justify-between p-2 text-left transition hover:border-cc-purple {project
              .info?.path === rp.sourcePath
              ? 'border-cc-purple bg-cc-tint/30'
              : ''}"
            onclick={async () => {
              if (project.info?.path !== rp.sourcePath) {
                await project.load(rp.sourcePath);
                await fetchRecent();
              }
            }}
          >
            <div class="min-w-0">
              <div class="truncate text-[12px] font-medium text-cc-text" title={rp.name}>
                {rp.name}
              </div>
              <div class="mono text-[10.5px] text-cc-text-3">
                {Math.floor(rp.durationSecs / 60)}:{String(
                  Math.floor(rp.durationSecs % 60),
                ).padStart(2, "0")}
              </div>
            </div>
            {#if project.info?.path === rp.sourcePath}
              <span
                class="rounded bg-cc-purple/10 px-1.5 py-0.5 text-[10px] font-medium text-cc-purple"
                >Active</span
              >
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if project.error}
    <div
      class="rounded px-2 py-1.5 text-[12px]"
      role="alert"
      style="background: #fde7e9; color: #a80000"
    >
      {project.error}
    </div>
  {/if}

  <!-- The drop zone: dashed, tall, and where Clipchamp puts it. -->
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

  <!-- Environment readout: one line, always visible. -->
  <div class="mono flex shrink-0 items-center gap-2 text-[10px]">
    {#if envError}
      <span
        class="rounded px-2 py-0.5"
        style="background: #fde7e9; color: #a80000"
        title={envError}
      >
        FFmpeg not usable
      </span>
    {:else if ffmpegVersion}
      <span class="text-cc-text-3" title={ffmpegVersion}>
        ffmpeg {ffmpegVersion.replace(/^ffmpeg version /, "").split(" ")[0]}
      </span>
      <span class="text-cc-text-4">·</span>
      <span
        class="rounded px-2 py-0.5"
        style={hardware?.qsv
          ? "background: #ece5ff; color: var(--color-cc-purple)"
          : "background: var(--color-cc-tint); color: var(--color-cc-text-3)"}
        title="Hardware encoder available for export"
      >
        {encoderLabel}
      </span>
    {/if}
  </div>
</div>
