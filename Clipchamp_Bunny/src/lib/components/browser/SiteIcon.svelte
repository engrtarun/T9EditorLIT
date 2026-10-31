<script lang="ts">
  /**
   * A site's real favicon, with a fallback chain and a letter tile.
   *
   * The desktop webview runs under a CSP, so an icon request can fail for a
   * reason the page never sees: a blocked origin looks exactly like a 404. One
   * `<img>` per candidate (daemon proxy → the site itself → Google's favicon
   * CDN) and a stable letter tile when all of them miss means the UI never
   * shows a broken image — and it is the same component in the tab strip, the
   * new-tab shortcuts and the 9-dots panel, so an icon cannot look different
   * depending on where it is drawn.
   */
  import { faviconSources } from '../../stores/browser.svelte';

  let {
    url,
    label = '',
    size = 16,
    shape = 'square',
    framed = false
  }: {
    url: string;
    /** Used for the letter tile when every icon source fails. */
    label?: string;
    /** Outer box in px. */
    size?: number;
    shape?: 'square' | 'circle';
    /** White tile behind the icon (Firefox's shortcut look). */
    framed?: boolean;
  } = $props();

  let attempt = $state(0);

  // A new site starts at the best source again, not at the one the old site
  // failed on.
  $effect(() => {
    void url;
    attempt = 0;
  });

  const sources = $derived(faviconSources(url));
  const src = $derived(sources[attempt] ?? null);
  const letter = $derived((label || hostLetter(url)).charAt(0).toUpperCase() || '·');
  const hue = $derived(hueOf(url));
  const inner = $derived(Math.max(8, Math.round(size * 0.66)));

  function hostLetter(u: string): string {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '?';
    }
  }

  /** A stable hue per host, so a letter tile still has an identity. */
  function hueOf(u: string): number {
    let h = 0;
    for (const ch of u) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
</script>

<span
  class="relative grid shrink-0 place-items-center overflow-hidden {shape === 'circle'
    ? 'rounded-full'
    : 'rounded-[5px]'} {framed ? 'bg-white' : ''}"
  style="width:{size}px;height:{size}px"
>
  {#if src}
    <img
      {src}
      alt=""
      loading="lazy"
      decoding="async"
      width={inner}
      height={inner}
      style="width:{inner}px;height:{inner}px"
      class="object-contain"
      onerror={() => (attempt += 1)}
    />
  {:else}
    <span
      class="grid h-full w-full place-items-center font-bold text-white"
      style="background:hsl({hue} 42% 40%);font-size:{Math.max(8, Math.round(size * 0.44))}px"
      aria-hidden="true">{letter}</span
    >
  {/if}
</span>
