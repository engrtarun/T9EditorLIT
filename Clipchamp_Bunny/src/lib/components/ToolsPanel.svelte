<script lang="ts">
  /**
   * Tools panel — the 9-dots launcher.
   *
   * Nine built-in websites the app ships with (search, TTS, trends, docs, the
   * video indexes) that can never be removed, plus whatever the user pins with
   * the + button. Pinned tools live in `pinnedTools`, which the browser's
   * new-tab page reads too — pin a site once, see it in both places.
   *
   * **A tile never leaves the app.** It is a button, not an `<a target="_blank">`:
   * an anchor with a target hands the URL to Windows, which opens Edge/Firefox
   * over the editor. Clicking here switches to the in-built browser and
   * navigates its active tab, so the page the user asked for is the page they
   * get, inside T9.
   */
  import { i18n } from '../stores/i18n.svelte';
  import { app } from '../stores/app.svelte';
  import { browser } from '../stores/browser.svelte';
  import {
    pinnedTools,
    normaliseUrl,
    hostOfUrl,
    type PinnedTool
  } from '../stores/pinned-tools.svelte';
  import SiteIcon from './browser/SiteIcon.svelte';

  type Tool = PinnedTool;

  /** Shipped and locked. Order here is the order on the grid. */
  const BUILTIN: Tool[] = [
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
    { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/?lang=en-in' },
    { id: 'qwen', name: 'Qwen Chat', url: 'https://chat.qwen.ai/' },
    { id: 'minimax', name: 'MiniMax TTS', url: 'https://www.minimax.io/audio/text-to-speech' },
    { id: 'adobe-podcast', name: 'Adobe Podcast', url: 'https://podcast.adobe.com/en/enhance#' },
    {
      id: 'trends',
      name: 'Google Trends',
      url: 'https://trends.google.com/trending?geo=IN&hours=168'
    },
    { id: 'gdocs', name: 'Google Docs', url: 'https://docs.google.com/document/u/0/' },
    { id: '4khdhub', name: '4KHDHub', url: 'https://4khdhub.one/' },
    { id: 'hdhub4u', name: 'HDHub4U', url: 'https://hdhub4u.ms/' }
  ];

  let open = $state(false);
  let adding = $state(false);
  let nameDraft = $state('');
  let urlDraft = $state('');
  let pos = $state({ x: 0, y: 0 });

  /** The panel's size, so it can be kept inside the window (CloudMenu rule). */
  const MENU_W = 320;
  const MENU_H = 470;
  const EDGE = 8;

  function toggle(e: MouseEvent) {
    if (open) {
      open = false;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = Math.round(r.left);
    if (x + MENU_W > vw - EDGE) x = vw - EDGE - MENU_W;
    if (x < EDGE) x = EDGE;

    let y = Math.round(r.bottom + 6);
    if (y + MENU_H > vh - EDGE) y = Math.max(EDGE, Math.round(r.top - MENU_H - 6));

    pos = { x, y };
    open = true;
  }

  /** Open a site in the in-built browser — never in the system browser. */
  function openTool(url: string) {
    open = false;
    adding = false;
    app.openBrowser(app.view);
    browser.navigate(url);
  }

  function pin() {
    const tool = pinnedTools.add(urlDraft, nameDraft);
    if (!tool) return;
    nameDraft = '';
    urlDraft = '';
    adding = false;
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      open = false;
      adding = false;
    }
  }}
/>

<!-- app launcher (9 dots) — the suggested-websites panel -->
<button
  onclick={toggle}
  class="grid h-8 w-8 place-items-center rounded-md text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
  title={i18n.t('bar.tools')}
  aria-label={i18n.t('bar.tools')}
  aria-haspopup="dialog"
  aria-expanded={open}
>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3" cy="3" r="1.4" /><circle cx="8" cy="3" r="1.4" /><circle
      cx="13"
      cy="3"
      r="1.4"
    />
    <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle
      cx="13"
      cy="8"
      r="1.4"
    />
    <circle cx="3" cy="13" r="1.4" /><circle cx="8" cy="13" r="1.4" /><circle
      cx="13"
      cy="13"
      r="1.4"
    />
  </svg>
</button>

{#if open}
  <!-- click-away catcher -->
  <button
    class="fixed inset-0 z-[190] cursor-default"
    aria-label="Close tools"
    onclick={() => (open = false)}
  ></button>

  <div
    class="t9-fade-in fixed z-[200] w-[320px] max-h-[min(470px,74vh)] overflow-y-auto rounded-xl border border-nc-line-2 bg-[#1E1E29] shadow-2xl"
    style="left:{pos.x}px;top:{pos.y}px"
    role="dialog"
    aria-label={i18n.t('bar.tools')}
  >
    <!-- header: title + the pin-a-website + -->
    <div class="flex items-center justify-between px-2.5 pt-2 pb-1.5">
      <p class="text-[9px] font-bold tracking-widest text-nc-mut-2">TOOLS · SUGGESTED WEBSITES</p>
      <button
        onclick={() => (adding = !adding)}
        class="grid h-5 w-5 place-items-center rounded text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
        title={i18n.t('bar.toolsAdd')}
        aria-label={i18n.t('bar.toolsAdd')}
        aria-expanded={adding}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <!-- add form -->
    {#if adding}
      <div class="mx-2 mb-2 rounded-lg border border-nc-line-2 bg-nc-panel-2 p-2">
        <input
          bind:value={urlDraft}
          placeholder={i18n.t('bar.toolsUrl')}
          class="mb-1.5 w-full rounded border border-nc-line bg-nc-panel px-2 py-1 font-mono text-[11px] outline-none focus:border-nc-brand"
        />
        <div class="flex gap-1.5">
          <input
            bind:value={nameDraft}
            placeholder={i18n.t('bar.toolsName')}
            class="min-w-0 flex-1 rounded border border-nc-line bg-nc-panel px-2 py-1 text-[11px] outline-none focus:border-nc-brand"
            onkeydown={(e) => {
              if (e.key === 'Enter') pin();
            }}
          />
          <button
            onclick={pin}
            disabled={!normaliseUrl(urlDraft)}
            class="shrink-0 rounded bg-nc-brand px-2.5 text-[11px] font-bold text-nc-bg transition hover:brightness-110 disabled:opacity-40"
          >
            {i18n.t('bar.toolsPin')}
          </button>
        </div>
      </div>
    {/if}

    <!-- built-in tools: locked, no remove -->
    <p class="px-2.5 pt-1 pb-1 text-[9px] tracking-widest text-nc-mut-2">
      BUILT-IN · {i18n.t('bar.toolsLocked')}
    </p>
    <div class="grid grid-cols-3 gap-1 px-2">
      {#each BUILTIN as t (t.id)}
        <button
          type="button"
          onclick={() => openTool(t.url)}
          class="group relative flex flex-col items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-2.5 text-center transition-colors hover:border-nc-line-2 hover:bg-nc-panel-2"
          title="{t.name} — in-built browser me khulega"
        >
          <SiteIcon url={t.url} label={t.name} size={34} framed />
          <span class="w-full truncate text-[11px] font-medium text-nc-txt">{t.name}</span>
          <span class="w-full truncate text-[9px] text-nc-mut-2">{hostOfUrl(t.url)}</span>
          <!-- the lock: these nine are shipped with the app -->
          <span
            class="absolute top-1 right-1 text-nc-mut-2 opacity-0 transition-opacity group-hover:opacity-100"
            title={i18n.t('bar.toolsLocked')}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"
              />
            </svg>
          </span>
        </button>
      {/each}
    </div>

    <!-- the user's own pins -->
    <p class="px-2.5 pt-2.5 pb-1 text-[9px] tracking-widest text-nc-mut-2">
      YOUR PINNED ({pinnedTools.items.length})
    </p>
    {#if pinnedTools.items.length === 0}
      <p class="px-2.5 pb-3 text-[11px] leading-relaxed text-nc-mut-2">
        {i18n.t('bar.toolsEmpty')}
      </p>
    {:else}
      <div class="grid grid-cols-3 gap-1 px-2 pb-2.5">
        {#each pinnedTools.items as t (t.id)}
          <div class="group relative">
            <button
              type="button"
              onclick={() => openTool(t.url)}
              class="flex w-full flex-col items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-2.5 text-center transition-colors hover:border-nc-line-2 hover:bg-nc-panel-2"
              title="{t.name} — in-built browser me khulega"
            >
              <SiteIcon url={t.url} label={t.name} size={34} framed />
              <span class="w-full truncate text-[11px] font-medium text-nc-txt">{t.name}</span>
              <span class="w-full truncate text-[9px] text-nc-mut-2">{hostOfUrl(t.url)}</span>
            </button>
            <!-- remove: only the user's own pins have one -->
            <button
              onclick={() => pinnedTools.remove(t.id)}
              title={i18n.t('bar.toolsRemove')}
              aria-label="{i18n.t('bar.toolsRemove')}: {t.name}"
              class="absolute -top-1 -right-1 hidden h-4 w-4 place-items-center rounded-full border border-nc-line-2 bg-nc-panel text-[9px] leading-none text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt group-hover:grid"
            >
              ✕
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
