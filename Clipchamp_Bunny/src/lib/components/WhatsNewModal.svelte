<script lang="ts">
  import { whatsNew } from '../stores/whatsnew.svelte';
  import { WHATS_NEW } from '../whatsnew';

  const release = WHATS_NEW;
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
              {release.version ?? 'Naya build'} - {release.items.length} changes, deep detail ke saath
            </p>
          </div>
        </div>
        <h2 class="mt-3 text-[15px] font-medium text-nc-brand">{release.headline}</h2>
      </header>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <div class="space-y-5">
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
                <span class="font-semibold text-nc-brand">Reason:</span> {item.reason}
              </p>
            </section>
          {/each}
        </div>
      </div>

      <!-- Footer -->
      <footer class="shrink-0 flex items-center justify-end gap-2 border-t border-nc-line bg-nc-panel-2 px-6 py-3">
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
