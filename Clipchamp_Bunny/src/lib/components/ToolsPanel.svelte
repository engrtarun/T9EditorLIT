<script lang="ts">
  /**
   * Tools panel — the 9-dots launcher, rebuilt.
   *
   * It used to be a plain Home button. It is now a small "suggested websites"
   * panel: nine built-in tools the app ships with (search, TTS, trends, docs,
   * the video indexes) that can never be removed, plus whatever the user pins
   * with the + button. Pinned tools live in localStorage — there is no
   * backend for this and there does not need to be one.
   *
   * The icons are round Chrome-style favicons, fetched from the site itself:
   *   1. `<origin>/favicon.ico`   — what every site serves by default,
   *   2. Google's s2 favicon CDN  — covers sites that 404 the first hop,
   *   3. an initials tile         — when both fail (offline, dead domain).
   *
   * Tiles are plain `<a target="_blank">` links: the dev preview opens them
   * as a new tab of the in-app browser pane, and the Tauri shell routes them
   * to the system browser. No JS bridge needed either way.
   */
  import { i18n } from '../stores/i18n.svelte';

  type Tool = { id: string; name: string; url: string };

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

  const STORE_KEY = 't9-editor-lit.tools';

  let open = $state(false);
  let adding = $state(false);
  let nameDraft = $state('');
  let urlDraft = $state('');
  let pos = $state({ x: 0, y: 0 });
  /** favicon URL per tool id; '' = both sources failed, show initials. */
  let favicons = $state<Record<string, string>>({});
  let mine = $state<Tool[]>(loadMine());

  function loadMine(): Tool[] {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t): t is Partial<Tool> => !!t && typeof t === 'object')
        .filter((t) => typeof t.url === 'string' && t.url.length > 0)
        .map((t) => ({
          id: String(t.id ?? 'u' + Math.random().toString(36).slice(2)),
          name: String(t.name || hostOf(String(t.url))),
          url: String(t.url)
        }));
    } catch {
      return [];
    }
  }

  $effect(() => {
    // `mine` is the dependency: add / remove writes through, reloads restore.
    localStorage.setItem(STORE_KEY, JSON.stringify(mine));
  });

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

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function favPrimary(t: Tool): string {
    try {
      return new URL(t.url).origin + '/favicon.ico';
    } catch {
      return '';
    }
  }

  function favFallback(t: Tool): string {
    try {
      return (
        'https://www.google.com/s2/favicons?sz=64&domain=' +
        encodeURIComponent(new URL(t.url).hostname)
      );
    } catch {
      return '';
    }
  }

  function favSrc(t: Tool): string {
    return favicons[t.id] ?? favPrimary(t);
  }

  /** First miss hops to the Google CDN, second miss gives up → initials. */
  function favFail(t: Tool) {
    const shown = favicons[t.id] ?? favPrimary(t);
    const next = favFallback(t);
    favicons[t.id] = next && next !== shown ? next : '';
  }

  function initials(name: string): string {
    return (
      name
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 2)
        .toUpperCase() || '··'
    );
  }

  function pin() {
    const url = normalise(urlDraft);
    if (!url) return;
    const name = nameDraft.trim() || hostOf(url);
    mine = [...mine, { id: 'u' + Date.now().toString(36), name, url }];
    nameDraft = '';
    urlDraft = '';
    adding = false;
  }

  function unpin(id: string) {
    mine = mine.filter((t) => t.id !== id);
  }

  /** `example.com` → `https://example.com/`; junk stays unpinned. */
  function normalise(raw: string): string {
    let url = raw.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      return new URL(url).toString();
    } catch {
      return '';
    }
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
    class="fixed z-[200] w-[320px] max-h-[min(470px,74vh)] overflow-y-auto rounded-md border border-nc-line-2 bg-[#1E1E29] shadow-2xl"
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
      <div class="mx-2 mb-2 rounded border border-nc-line-2 bg-nc-panel-2 p-2">
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
            disabled={!normalise(urlDraft)}
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
        <a
          href={t.url}
          target="_blank"
          rel="noreferrer"
          onclick={() => (open = false)}
          class="group relative flex flex-col items-center gap-1 rounded-lg border border-transparent px-1.5 py-2.5 text-center transition-colors hover:border-nc-line-2 hover:bg-nc-panel-2"
        >
          {#if favSrc(t)}
            <img
              src={favSrc(t)}
              alt=""
              loading="lazy"
              onerror={() => favFail(t)}
              class="h-8 w-8 rounded-full bg-white/95 object-contain p-0.5"
            />
          {:else}
            <span
              class="grid h-8 w-8 place-items-center rounded-full bg-nc-brand/20 text-[11px] font-bold text-nc-brand"
            >
              {initials(t.name)}
            </span>
          {/if}
          <span class="w-full truncate text-[11px] font-medium text-nc-txt">{t.name}</span>
          <span class="w-full truncate text-[9px] text-nc-mut-2">{hostOf(t.url)}</span>
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
        </a>
      {/each}
    </div>

    <!-- the user's own pins -->
    <p class="px-2.5 pt-2.5 pb-1 text-[9px] tracking-widest text-nc-mut-2">
      YOUR PINNED ({mine.length})
    </p>
    {#if mine.length === 0}
      <p class="px-2.5 pb-3 text-[11px] leading-relaxed text-nc-mut-2">
        {i18n.t('bar.toolsEmpty')}
      </p>
    {:else}
      <div class="grid grid-cols-3 gap-1 px-2 pb-2.5">
        {#each mine as t (t.id)}
          <div class="group relative">
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              onclick={() => (open = false)}
              class="flex w-full flex-col items-center gap-1 rounded-lg border border-transparent px-1.5 py-2.5 text-center transition-colors hover:border-nc-line-2 hover:bg-nc-panel-2"
            >
              {#if favSrc(t)}
                <img
                  src={favSrc(t)}
                  alt=""
                  loading="lazy"
                  onerror={() => favFail(t)}
                  class="h-8 w-8 rounded-full bg-white/95 object-contain p-0.5"
                />
              {:else}
                <span
                  class="grid h-8 w-8 place-items-center rounded-full bg-nc-brand/20 text-[11px] font-bold text-nc-brand"
                >
                  {initials(t.name)}
                </span>
              {/if}
              <span class="w-full truncate text-[11px] font-medium text-nc-txt">{t.name}</span>
              <span class="w-full truncate text-[9px] text-nc-mut-2">{hostOf(t.url)}</span>
            </a>
            <!-- remove: only the user's own pins have one -->
            <button
              onclick={() => unpin(t.id)}
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
