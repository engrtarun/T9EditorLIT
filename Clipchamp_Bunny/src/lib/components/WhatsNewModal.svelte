<script lang="ts">
  import { installedBuild } from '../ipc';
  import { whatsNew } from '../stores/whatsnew.svelte';
  import { whatsNewFor } from '../whatsnew';

  /**
   * The only facts on this sheet: the build the app is actually holding.
   * Read from the on-disk marker every time the sheet opens, so it can never
   * show a stale identity after a deploy. Notes are looked up by that exact
   * build id — an unknown build gets "no verified notes", never an old list.
   */
  let facts = $state<{
    buildId: string;
    runningBuildId: string;
    builtAt: string;
    version: string;
  } | null>(null);

  const release = $derived(whatsNewFor(facts?.buildId));

  $effect(() => {
    if (!whatsNew.open) return;
    let dead = false;
    void installedBuild()
      .then((b) => {
        if (!dead && b) facts = b;
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  });
</script>

{#if whatsNew.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="whats-new-title"
  >
    <div
      class="relative flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl border border-nc-line bg-nc-panel shadow-2xl"
    >
      <!-- Header -->
      <header class="shrink-0 border-b border-nc-line bg-nc-panel-2 px-6 py-4">
        <div class="flex items-center gap-3">
          <span
            class="grid h-9 w-9 place-items-center rounded-lg bg-nc-brand/15 text-nc-brand"
            aria-hidden="true"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 13h6M9 17h4" />
            </svg>
          </span>
          <div class="min-w-0">
            <h1 id="whats-new-title" class="text-[18px] font-semibold leading-tight text-nc-txt">
              What's New
            </h1>
            <p class="text-[12px] text-nc-mut">
              Sirf is exact build ke verified notes - niche build identity hai
            </p>
          </div>
        </div>
        {#if release}
          <h2 class="mt-3 text-[15px] font-medium text-nc-brand">{release.headline}</h2>
        {:else}
          <p class="mt-3 text-[13px] leading-relaxed text-nc-mut">
            Is build ({facts?.buildId ?? 'unknown'}) ke liye verified notes nahi hain. Exact changes
            dekhne ke liye CI run / commit ka diff dekho.
          </p>
        {/if}
        {#if facts}
          <dl
            class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-nc-mut"
          >
            <dt>staged build</dt>
            <dd class="break-all text-nc-txt">{facts.buildId}</dd>
            <dt>running</dt>
            <dd class="break-all">{facts.runningBuildId || 'unknown'}</dd>
            <dt>built</dt>
            <dd>{facts.builtAt} · v{facts.version}</dd>
          </dl>
        {/if}
      </header>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <div class="space-y-5">
          {#if release}
            {#each release.items as item, i (i)}
              <section class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
                <h3 class="flex items-start gap-2 text-[14px] font-semibold text-nc-txt">
                  <span class="mt-0.5 text-nc-brand">•</span>
                  {item.title}
                </h3>
                <p class="mt-1.5 text-[13px] leading-relaxed text-nc-txt/90">
                  {item.detail}
                </p>
                <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">
                  <span class="font-semibold text-nc-brand">Reason:</span>
                  {item.reason}
                </p>
              </section>
            {/each}
          {:else}
            <p class="text-[13px] leading-relaxed text-nc-mut">
              Koi verified note nahi. Notes tabhi add hote hain jab koi change commit ke saath
              verify ho.
            </p>
          {/if}
        </div>
      </div>

      <!-- Footer -->
      <footer
        class="shrink-0 flex items-center justify-end gap-2 border-t border-nc-line bg-nc-panel-2 px-6 py-3"
      >
        <button
          type="button"
          onclick={() => whatsNew.hide()}
          class="rounded-md border border-nc-line bg-nc-panel px-4 py-2 text-[13px] font-medium text-nc-mut transition-colors hover:border-nc-brand/40 hover:text-nc-txt"
        >
          Skip
        </button>
        <button
          type="button"
          onclick={() => whatsNew.updateNow()}
          disabled={whatsNew.applying}
          class="rounded-md bg-nc-brand px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {whatsNew.applying ? 'Restarting...' : 'Update Now'}
        </button>
      </footer>
    </div>
  </div>
{/if}
