<script lang="ts">
  /**
   * The new-tab page — a speed dial of favicon cards.
   *
   * This is the answer to "9 tabs ki limit hai, toh website ka icon dikhao
   * jispe click karke kholo": the dial is where the icons live, one click
   * opens the site in the active tab. It renders in the *main* webview (Svelte
   * DOM), so an empty tab costs zero megabytes — the native page webview only
   * exists once a real URL is navigated to.
   *
   * In the dev preview favicons load straight from the network; on the desktop
   * they come through the daemon's proxy (Slice 3) so the CSP stays tight.
   */
  import { browser, SPEED_DIAL, hostOf } from '../../stores/browser.svelte';
  import { isTauri } from '../../ipc';

  /** Card colour: derive a stable hue from the host so each card has an identity. */
  function hue(url: string): number {
    let h = 0;
    for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function open(url: string) {
    browser.navigate(url);
  }
</script>

<div class="flex h-full min-h-0 flex-col items-center justify-center gap-8 px-6 py-8">
  <div class="text-center">
    <p class="text-[22px] font-semibold text-nc-txt">Naya tab</p>
    <p class="mt-1 text-[13px] text-nc-mut">
      Icon pe click karo, ya upar address bar me likho — {isTauri() ? '' : '(dev preview: '}
      9 tabs tak<span class="hidden md:inline">, download ⬇ toolbar me</span>{isTauri() ? '' : ')'}
    </p>
  </div>

  <div class="grid max-w-[560px] grid-cols-3 gap-3 sm:grid-cols-3">
    {#each SPEED_DIAL as site (site.url)}
      {@const h = hue(site.url)}
      <button
        type="button"
        onclick={() => open(site.url)}
        class="group flex flex-col items-center gap-2 rounded-xl border border-nc-line bg-nc-panel px-3 py-4 transition-colors hover:border-nc-brand/50 hover:bg-nc-panel-2"
        title={site.url}
      >
        <span
          class="grid h-10 w-10 place-items-center rounded-full text-[15px] font-bold text-white transition-transform group-hover:scale-105"
          style="background: hsl({h} 45% 42%)"
          aria-hidden="true"
        >
          {site.label.charAt(0)}
        </span>
        <span class="max-w-full truncate text-[12px] text-nc-mut group-hover:text-nc-txt">
          {site.label}
        </span>
        <span class="max-w-full truncate text-[10px] text-nc-mut/70">{hostOf(site.url)}</span>
      </button>
    {/each}
  </div>

  <!-- the cap, stated where the user counts cards -->
  <p class="text-[11px] text-nc-mut/70">{browser.tabs.length} / 9 tabs open</p>
</div>
