<script lang="ts">
  /**
   * Telegram Cloud Vault card.
   *
   * Talks to the t9cloud Go daemon on http://127.0.0.1:8787:
   *   GET  /v1/vault/status      — configured / authorised / account
   *   POST /v1/vault/authorise   — start QR login
   *   GET  /v1/vault/authorise/{id} — poll login phase + QR URL
   *   POST /v1/vault/upload      — start backup (body: { path, chat? })
   *   GET  /v1/jobs/{id}         — live upload progress
   *
   * Only one login attempt and one upload at a time; the daemon enforces the
   * same. A cancelled scan spends nothing on Telegram.
   */
  import { project } from "../../stores/project.svelte";
  import {
    vaultStatus,
    vaultAuthorise,
    vaultPollLogin,
    vaultUpload,
    vaultJob,
    errorMessage,
  } from "../../ipc";
  import type { VaultStatus, LoginChallenge, CloudJob } from "../../types";

  const POLL_MS = 2000;

  let status = $state<VaultStatus | null>(null);
  let login = $state<LoginChallenge | null>(null);
  let job = $state<CloudJob | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  let loginTimer: ReturnType<typeof setInterval> | null = null;
  let jobTimer: ReturnType<typeof setInterval> | null = null;

  function clearTimers() {
    if (loginTimer !== null) {
      clearInterval(loginTimer);
      loginTimer = null;
    }
    if (jobTimer !== null) {
      clearInterval(jobTimer);
      jobTimer = null;
    }
  }

  async function refreshStatus() {
    try {
      status = await vaultStatus();
      error = null;
    } catch (err) {
      // Daemon may not be running yet — that's fine, show "not configured".
      status = {
        configured: false,
        authorised: false,
        account: null,
        chat: null,
        connections: 0,
        partBytes: 0,
        sessionPath: null,
        detail: errorMessage(err),
      };
    }
  }

  function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function formatRate(bps: number): string {
    return bps > 0 ? `${formatBytes(bps)}/s` : "—";
  }

  function eta(phase: string, done: number, total: number, bps: number): string {
    if (phase !== "uploading" || bps <= 0 || total <= 0 || done >= total) return "—";
    const secs = (total - done) / bps;
    if (secs < 60) return `${Math.round(secs)}s left`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}m ${s}s left`;
  }

  $effect(() => {
    void refreshStatus();
  });

  async function connectTelegram() {
    clearTimers();
    error = null;
    loading = true;
    try {
      login = await vaultAuthorise();
      loginTimer = setInterval(async () => {
        try {
          const c = await vaultPollLogin(login!.id);
          login = c;
          if (c.phase === "authorised" || c.phase === "expired" || c.phase === "failed") {
            clearTimers();
            await refreshStatus();
          }
        } catch (err) {
          error = errorMessage(err);
          clearTimers();
        }
      }, POLL_MS);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function cancelLogin() {
    if (!login) return;
    clearTimers();
    login = null;
    await refreshStatus();
  }

  async function startBackup() {
    if (!project.hasMedia || !project.info) return;
    clearTimers();
    error = null;
    loading = true;
    try {
      job = await vaultUpload(project.info.path);
      jobTimer = setInterval(async () => {
        try {
          const j = await vaultJob(job!.id);
          job = j;
          if (j.state === "done" || j.state === "failed" || j.state === "partial") {
            clearTimers();
            loading = false;
          }
        } catch (err) {
          error = errorMessage(err);
          clearTimers();
          loading = false;
        }
      }, POLL_MS);
    } catch (err) {
      error = errorMessage(err);
      loading = false;
    }
  }

  $effect(() => {
    return () => clearTimers();
  });
</script>

<div class="cc-panel flex min-h-0 flex-col gap-3 p-4">
  <div class="flex items-center justify-between">
    <h3 class="text-[15px] font-semibold text-cc-text">Telegram Vault</h3>
    <span
      class="flex h-2 w-2 items-center justify-center rounded-full text-[10px]
        {status?.authorised
        ? 'bg-cc-keep text-cc-keep'
        : status?.configured
          ? 'bg-cc-cut text-cc-cut'
          : 'bg-cc-tint text-cc-text-3'}"
    >
      {status?.authorised ? "linked" : status?.configured ? "unlinked" : "offline"}
    </span>
  </div>

  {#if error}
    <div class="rounded bg-cc-cut/10 p-2 text-[11px] text-cc-cut border border-cc-cut/30">
      {error}
    </div>
  {/if}

  {#if !status?.configured}
    <div class="flex flex-col items-center justify-center gap-2 p-4 text-center">
      <span class="text-[12px] text-cc-text-2">Telegram not configured</span>
      <span class="text-[10px] text-cc-text-3 leading-relaxed max-w-xs">
        Set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_TARGET_CHAT in the t9cloud daemon, then
        restart it.
      </span>
    </div>
  {:else if !status?.authorised}
    {#if login?.phase === "authorised"}
      <div class="flex flex-col items-center justify-center gap-2 p-4 text-center">
        <span class="text-[12px] text-cc-keep font-semibold">Linked to Telegram</span>
        <span class="text-[10px] text-cc-text-3">{login.account ?? status.account}</span>
        <button
          type="button"
          class="cc-btn cc-btn-primary text-[12px] px-3 py-1.5"
          onclick={connectTelegram}
        >
          Rescan
        </button>
      </div>
    {:else if login?.url}
      {@const loginUrl = login.url}
      <div class="flex flex-col items-center justify-center gap-3 p-4 text-center">
        <span class="text-[12px] font-semibold text-cc-text">
          Scan with Telegram → Settings → Link Desktop Device
        </span>
        <div
          class="flex min-w-0 flex-1 items-center justify-center p-2 bg-cc-surface rounded border border-cc-line"
        >
          <code class="block truncate text-[10px] mono text-cc-text leading-none" title={loginUrl}>
            {loginUrl}
          </code>
        </div>
        <button
          type="button"
          class="cc-btn text-[12px] px-3 py-1.5"
          onclick={() => navigator.clipboard.writeText(loginUrl)}
          title="Copy login URL"
        >
          Copy URL
        </button>
        <button
          type="button"
          class="cc-btn text-[11px] px-2 py-1 text-cc-text-3 hover:bg-cc-tint"
          onclick={cancelLogin}
        >
          Cancel
        </button>
        {#if login.detail}
          <span class="text-[10px] text-cc-cut">{login.detail}</span>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        class="cc-btn cc-btn-primary w-full text-[12px] px-4 py-2"
        disabled={loading}
        onclick={connectTelegram}
      >
        {loading ? "starting scan…" : "Connect Telegram"}
      </button>
    {/if}
  {:else}
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-cc-text-2">Account</span>
        <span class="text-cc-text">{status.account ?? "—"}</span>
      </div>
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-cc-text-2">Chat</span>
        <span class="text-cc-text">{status.chat ?? "—"}</span>
      </div>
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-cc-text-2">Connections</span>
        <span class="text-cc-text">{status.connections}</span>
      </div>
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-cc-text-2">Part size</span>
        <span class="text-cc-text">{formatBytes(status.partBytes)}</span>
      </div>
      {#if status.detail}
        <span class="text-[10px] text-cc-text-3">{status.detail}</span>
      {/if}
    </div>

    {#if job}
      <div class="rounded-lg border border-cc-line bg-cc-tint p-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-semibold text-cc-text">
            {job.vaultProgress?.phase === "hashing" ? "Hashing…" : "Uploading…"}
          </span>
          <span class="text-[11px] mono text-cc-text-2">
            {Math.round(
              ((job.vaultProgress?.bytesDone ?? 0) /
                Math.max(job.vaultProgress?.bytesTotal ?? 1, 1)) *
                100,
            )}%
          </span>
        </div>
        <div class="w-full h-1.5 bg-cc-line rounded overflow-hidden">
          <div
            class="h-full bg-cc-purple"
            style="width: {((job.vaultProgress?.bytesDone ?? 0) /
              Math.max(job.vaultProgress?.bytesTotal ?? 1, 1)) *
              100}%"
          ></div>
        </div>
        <div class="flex justify-between text-[10px] text-cc-text-3 mt-1">
          <span>
            {formatBytes(job.vaultProgress?.bytesDone ?? 0)} /
            {formatBytes(job.vaultProgress?.bytesTotal ?? 0)}
          </span>
          <span>{formatRate(job.vaultProgress?.bytesPerSec ?? 0)}</span>
          <span
            >{eta(
              job.vaultProgress?.phase ?? "",
              job.vaultProgress?.bytesDone ?? 0,
              job.vaultProgress?.bytesTotal ?? 0,
              job.vaultProgress?.bytesPerSec ?? 0,
            )}</span
          >
        </div>
        {#if job.vaultProgress?.message}
          <span class="text-[10px] text-cc-text-3 mt-1">{job.vaultProgress.message}</span>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        class="cc-btn cc-btn-primary w-full text-[12px] px-4 py-2"
        disabled={loading || !project.hasMedia}
        onclick={startBackup}
      >
        {loading ? "preparing…" : project.hasMedia ? "Backup to Telegram" : "Import a video first"}
      </button>
    {/if}
  {/if}
</div>
