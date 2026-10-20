<script lang="ts">
  /**
   * The self-update button.
   *
   * The build installed next to the running executable carries a `build.json`
   * marker. When deploy.ps1 stages a newer build while this one is running,
   * `t9-editor-lit.new.exe` exists and this button appears. It asks for the
   * one restart that swaps the executable and starts the new build.
   *
   * The marker alone is not enough: a `-SkipBuild` deploy can change the
   * marker without staging a binary, and offering a button that cannot apply
   * would be a lie. `installed_build()` therefore sets `updateReady` from the
   * staged file, not from the timestamp.
   *
   * It lives in its own component so **every** screen can offer it: the
   * dashboard and the editor both mount this, and since only one of them is
   * ever mounted, only one of them ever polls.
   */
  import { applyStagedUpdate, installedBuild, isTauri } from '../ipc';
  import { toast } from '../stores/toast.svelte';

  let updateReady = $state(false);
  let applying = $state(false);
  let stagedBuild = $state<string | null>(null);
  /** The build we already told the user about, so the toast fires once. */
  let announcedBuild: string | null = null;

  async function checkUpdate() {
    if (!isTauri()) return;
    try {
      const build = await installedBuild();
      if (!build) {
        updateReady = false;
        return;
      }
      const ready = build.updateReady;
      const key = build.buildId || build.builtAt;
      if (ready && !updateReady && announcedBuild !== key) {
        announcedBuild = key;
        toast.push('info', 'Naya build ready hai - top bar me "Update" dabao.', 5000);
      }
      stagedBuild = build.buildId || null;
      updateReady = ready;
    } catch {
      /* the marker is missing - a dev build, nothing to update */
      updateReady = false;
    }
  }

  $effect(() => {
    if (!isTauri()) return;
    let alive = true;
    void checkUpdate();
    // Five seconds: a deploy is a deliberate action, and the user should not
    // sit in front of a finished install wondering why the chip is missing.
    const iv = setInterval(() => {
      if (alive) void checkUpdate();
    }, 5000);
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
    title={stagedBuild
      ? `Build ${stagedBuild} is staged. Click to restart into it.`
      : 'A newer build is staged. Click to restart into it.'}
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
      {applying ? 'Restarting...' : 'Update'}
    </span>
  </button>
{/if}
