<script lang="ts">
  /**
   * Source loader + environment check.
   *
   * FFmpeg and hardware encoder support are probed once at startup so problems
   * surface here — a clear banner — rather than three chunks deep at export time.
   */
  import { open } from "@tauri-apps/plugin-dialog";
  import { checkFfmpeg, detectHardware, errorMessage } from "../ipc";
  import { project } from "../stores/project.svelte";
  import type { HardwareSupport } from "../types";

  let hardware = $state<HardwareSupport | null>(null);
  let ffmpegVersion = $state<string | null>(null);
  let envError = $state<string | null>(null);

  // The input is not an <input type="file"> — Tauri gives us a native picker,
  // which matters when the user is browsing a 5 GB file on a spinning disk.
  async function pickVideo() {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: "Select a source video",
        filters: [
          {
            name: "Video",
            extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "ts"],
          },
        ],
      });
      if (typeof picked === "string") {
        await project.load(picked);
      }
    } catch (err) {
      project.error = errorMessage(err);
    }
  }

  async function checkEnvironment() {
    envError = null;
    try {
      ffmpegVersion = await checkFfmpeg();
      hardware = await detectHardware();
    } catch (err) {
      envError = errorMessage(err);
    }
  }

  $effect(() => {
    void checkEnvironment();
  });

  const encoderLabel = $derived(
    hardware
      ? hardware.qsv
        ? "Intel QuickSync"
        : hardware.nvenc
          ? "NVIDIA NVENC"
          : hardware.amf
            ? "AMD AMF"
            : "CPU only (no hardware encoder)"
      : null,
  );
</script>

<section class="flex shrink-0 items-center gap-3 border-b border-base-700 bg-base-850 px-4 py-2">
  <button type="button" class="btn btn-primary" onclick={pickVideo}>
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
      <path d="M22 19l-9-9-9 9" />
      <path d="M16 5l-4-4-4 4" />
      <path d="M4 19v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
    {project.info ? "Change source" : "Load source video"}
  </button>

  {#if project.loading}
    <span class="mono text-[11px] text-ink-500">probing with ffprobe…</span>
  {/if}

  {#if project.info}
    <span class="mono max-w-[280px] truncate text-[11px] text-ink-500" title={project.info.path}>
      {project.info.path}
    </span>
  {/if}

  <div class="flex-1"></div>

  <!-- Environment readout -->
  <div class="mono flex items-center gap-2 text-[10px]">
    {#if envError}
      <span
        class="rounded px-2 py-0.5"
        style="background: var(--color-cut-dim); color: var(--color-cut)"
        title={envError}
      >
        FFmpeg not usable
      </span>
    {:else if ffmpegVersion}
      <span class="text-ink-500" title={ffmpegVersion}>
        ffmpeg {ffmpegVersion.replace(/^ffmpeg version /, "").split(" ")[0]}
      </span>
      <span class="text-base-600">·</span>
      <span
        class="rounded px-2 py-0.5"
        style={hardware?.qsv
          ? "background: color-mix(in oklab, var(--color-keep) 18%, transparent); color: var(--color-keep)"
          : "background: var(--color-base-700); color: var(--color-ink-300)"}
        title="Hardware encoder available for export"
      >
        {encoderLabel}
      </span>
    {/if}
  </div>
</section>

{#if project.error}
  <div
    class="shrink-0 border-b px-4 py-1.5 text-[12px]"
    style="background: var(--color-cut-dim); color: var(--color-cut); border-color: var(--color-cut-dim)"
    role="alert"
  >
    {project.error}
  </div>
{/if}
