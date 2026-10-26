<script lang="ts">
  /**
   * The dashboard's top bar — a transparent strip over the background video.
   *
   * It holds exactly what the reference layout holds: the brand, the section
   * tabs and the profile avatar, at the top edge of the window. Nothing else.
   * The search box, the system meters, the cloud menu, the update button and
   * the settings / help icons all lived here before and are gone: every one
   * of them is reachable from the editor bar or the profile popover, and none
   * of them belonged over the footage. The middle of the frame stays empty.
   *
   * The three sections (Home · T9 Cloud · Trash) used to be a 9-dot launcher
   * whose menu repeated them *and* a 248 px sidebar. Both are gone: the tabs
   * are the navigation now, exactly one click, with the live trash count where
   * the eye already is.
   */
  import { app } from '../../stores/app.svelte';
  import { i18n } from '../../stores/i18n.svelte';
  import { appearance } from '../../stores/appearance.svelte';
  import ProfileMenu from '../ProfileMenu.svelte';
  import BrandMark from './BrandMark.svelte';
  import WindowControls from '../WindowControls.svelte';

  /** `trashCount` comes down from the dashboard, which already holds the bin. */
  let { trashCount = 0 }: { trashCount?: number } = $props();

  const TABS = ['home', 'cloud', 'trash'] as const;
  type Tab = (typeof TABS)[number];

  const label: Record<Tab, string> = {
    home: 'nav.home',
    cloud: 'nav.cloud',
    trash: 'nav.trash'
  };

  /* ------------------------------------------- the rotating "T9 Cloud" label
   * The cloud tab is the one animated label in the bar: it slowly cycles
   * T9 Cloud → AI APIs → T9 Connections → Fast Setup and back, a 600 ms
   * cross-fade with a 6 px settle, holding ~2 s on each phrase so it stays
   * readable. The phrases are stacked in a single grid cell, so the tab's
   * width is reserved at the *widest* phrase and nothing to its right ever
   * shifts. The button keeps a plain `aria-label="T9 Cloud"` and the stack is
   * `aria-hidden`, so screen readers hear the real section name once, not four
   * decorative words. Reduced Motion (app setting or Windows) freezes it on
   * the first phrase — the loop is decoration, so it is the first thing to go.
   */
  const ROTATE_MS = 2600; // ~2 s readable + the 600 ms transition

  const cloudPhrases = $derived([
    i18n.t('cloud.rot1'),
    i18n.t('cloud.rot2'),
    i18n.t('cloud.rot3'),
    i18n.t('cloud.rot4')
  ]);

  let rotIndex = $state(0);
  let rotTimer: ReturnType<typeof setInterval> | undefined;

  const motionOff = $derived(
    appearance.motion === 'reduced' ||
      (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  );

  $effect(() => {
    // Recompute the loop whenever motion preference or language changes.
    if (motionOff || cloudPhrases.length === 0) {
      rotIndex = 0;
      return;
    }
    rotIndex = 0;
    rotTimer = setInterval(() => {
      rotIndex = (rotIndex + 1) % cloudPhrases.length;
    }, ROTATE_MS);
    return () => {
      if (rotTimer) clearInterval(rotTimer);
    };
  });
</script>

<header
  data-focus="header"
  tabindex="-1"
  class="t9-over-video flex h-12 shrink-0 items-center gap-2.5 pr-0 pl-2 select-none outline-none"
  data-tauri-drag-region
>
  <!-- brand -->
  <div class="flex shrink-0 items-center gap-2 pr-1">
    <BrandMark size={28} />
    <span class="font-brand text-[16px] leading-none tracking-[0.02em]">
      T9 Editor <span class="text-nc-brand">LIT</span>
    </span>
  </div>

  <!-- section tabs: the navigation, kept at the top-left corner -->
  <nav class="flex shrink-0 items-center gap-1" aria-label={i18n.t('nav.sections')}>
    {#each TABS as id (id)}
      <button
        onclick={() => app.goHome(id)}
        class="relative rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors duration-150
               {app.section === id ? 'text-white' : 'text-white/70 hover:text-white'}"
        aria-current={app.section === id ? 'page' : undefined}
        aria-label={id === 'cloud' ? i18n.t('nav.cloud') : undefined}
      >
        {#if id === 'cloud'}
          <!--
            The rotating label. All four phrases live in ONE grid cell, so the
            tab is as wide as the longest phrase and nothing to its right moves
            as the words cross-fade. `aria-hidden` because the button already
            carries a stable aria-label above.
          -->
          <span class="relative inline-grid" aria-hidden="true">
            {#each cloudPhrases as phrase, i (i)}
              <span
                class="t9-label-rotate col-start-1 row-start-1 whitespace-nowrap"
                data-on={i === rotIndex ? '' : undefined}
              >
                {phrase}
              </span>
            {/each}
          </span>
        {:else}
          {i18n.t(label[id])}
        {/if}
        {#if id === 'trash' && trashCount > 0}
          <span
            class="ml-1 rounded-full bg-nc-red/45 px-1.5 py-0.5 text-[10px] leading-none font-bold text-white backdrop-blur-md"
          >
            {trashCount}
          </span>
        {/if}
        {#if app.section === id}
          <span class="t9-underline-in absolute inset-x-1 -bottom-1 h-0.5 rounded-full bg-nc-brand"
          ></span>
        {/if}
      </button>
    {/each}
  </nav>

  <!-- everything between the tabs and the avatar is deliberately empty, and it
       is the window's drag handle: grab here to move, double-click to maximize -->
  <div class="h-full flex-1" data-tauri-drag-region></div>

  <!-- avatar = the profile popover (Edit profile · App settings · Language · Help & About) -->
  <div class="shrink-0 pr-3">
    <ProfileMenu />
  </div>

  <!-- caption buttons: in the bar, flush to the window corner -->
  <WindowControls />
</header>
