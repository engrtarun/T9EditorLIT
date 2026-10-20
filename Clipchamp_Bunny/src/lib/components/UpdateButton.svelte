<script lang="ts">
  /**
   * The self-update button.
   *
   * The build installed next to the running executable carries a `build.json`
   * marker. When a newer build has been staged while this one was running,
   * the marker changes — and this button appears, asking for the restart that
   * swaps the executable and starts the new build. The pinned taskbar icon
   * keeps working, because it points at the same path.
   *
   * It lives in its own component so **every** screen can offer it: the
   * dashboard and the editor both mount this, and since only one of them is
   * ever mounted, only one of them ever polls.
   */
  import { applyStagedUpdate, installedBuild, isTauri } from '../ipc';
  import { toast } from '../stores/toast.svelte';

  let updateReady = $state(false);
  /** The build this session started on — used to notice a newer one. */
  let runningBuild = $state<string | null>(null);
  let applying = $state(false);

  async function checkUpdate() {
    if (!isTauri()) return;
    try {
      const build = await installedBuild();
      if (!build) return;
      // Two ways an update can be pending: the marker changed since this
      // session started, or a build is staged and only a restart is needed.
      const changed = runningBuild !== null && build.builtAt !== runningBuild;
      if (runningBuild === null) runningBuild = build.builtAt;
      updateReady = build.updateReady || changed;
    } catch {
      /* the marker is missing - a dev build, nothing to update */
    }
  }

  $effect(() => {
    if (!isTauri()) return;
    let alive = true;
    void checkUpdate();
    const iv = setInterval(() => {
      if (alive) void checkUpdate();
    }, 20000);
    const onFocus = () => {
      if (alive) void checkUpdate();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  });

  async function restartIntoNewBuild() {
    if (applying) return;
    applying = true;
    try {
      await applyStagedUpdate();
    } catch (e) {
      applying = false;
      toast.push('warn', `Update nahi lag paaya: ${e instanceof Error ? e.message : e}`);
    }
  }
</script>

{#if updateReady}
  <button
    onclick={restartIntoNewBuild}
    disabled={applying}
    class="group mr-1 flex shrink-0 items-center rounded-md border border-nc-line bg-nc-panel-2 px-2 py-[3px] text-[11px] leading-4 font-medium text-nc-mut transition-colors hover:border-nc-gold/50 hover:text-nc-gold disabled:opacity-50"
    title="A newer build is installed. Click to restart into it."
  >
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="shrink-0">
      <path
        d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span class="ms-1.5 me-px transition-colors duration-150 group-hover:text-nc-gold">
      {applying ? 'Restarting…' : 'Update'}
    </span>
  </button>
{/if}
