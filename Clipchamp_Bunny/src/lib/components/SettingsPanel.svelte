<script lang="ts">
  /**
   * The settings dialog — four tabs, one source of truth each.
   *
   *   · **General**    — the two things the app has always let you set: how
   *                      long trash records live, and how far J / L skip.
   *   · **Language**   — English · हिन्दी · Hinglish, from the central i18n
   *                      store. The change lands while you are still reading
   *                      the menu that offered it.
   *   · **Appearance** — accent, typography, text size, density, panel look
   *                      and motion; every one is a CSS variable (or a
   *                      data-attribute) written on `<html>`, so it applies
   *                      instantly and needs no restart.
   *   · **About**      — version and build, read from the binary.
   *
   * Everything persists to `localStorage`, like the rest of this app's
   * per-machine choices — six strings do not deserve a database.
   *
   * The dialog is a real dialog: a tablist with arrow keys, Escape to close,
   * `max-h-full overflow-auto` so it scrolls instead of growing past the
   * window, and each tab's content arriving on a 180 ms settle.
   */
  import { tick } from 'svelte';
  import { defaultDbPath, installedBuild, purgeExpiredTrash, isTauri } from '../ipc';
  import { app } from '../stores/app.svelte';
  import { layout } from '../stores/layout.svelte';
  import { settings, SEEK_STEP_DEFAULT, TRASH_DAYS_DEFAULT } from '../stores/settings.svelte';
  import { toast } from '../stores/toast.svelte';
  import {
    ACCENTS,
    appearance,
    type DensityId,
    type MotionId,
    type PanelId,
    type TextSizeId,
    type TypographyId
  } from '../stores/appearance.svelte';
  import { i18n, UI_LANGS, type UiLang } from '../stores/i18n.svelte';

  /** The option rows of the appearance tab, in the order they are offered. */
  const appearanceAccents = ACCENTS;
  const appearanceTypo: TypographyId[] = ['clean', 'cinematic', 'gaming'];
  const appearanceSizes: TextSizeId[] = ['sm', 'md', 'lg'];
  const appearanceDensity: DensityId[] = ['compact', 'comfortable'];
  const appearancePanels: PanelId[] = ['solid', 'translucent', 'minimal'];
  const appearanceMotion: MotionId[] = ['standard', 'reduced'];

  type TabId = 'general' | 'language' | 'appearance' | 'about';

  const TABS: { id: TabId; label: string }[] = [
    { id: 'general', label: 'set.tab.general' },
    { id: 'language', label: 'set.tab.language' },
    { id: 'appearance', label: 'set.tab.appearance' },
    { id: 'about', label: 'set.tab.about' }
  ];

  /** The presets most people want; the custom field covers everything else. */
  const PRESETS = [7, 12, 30, 60, 0];

  /** Transport skip presets, in seconds. */
  const STEP_PRESETS = [0.5, 1, 5, 10, 30];

  let customDays = $state(String(settings.trashRetentionDays));
  let customStep = $state(settings.seekStepLabel);
  let cleaning = $state(false);
  /** The installed build's id — shown in About when there is one. */
  let buildId = $state('');

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      layout.settingsOpen = false;
      e.stopPropagation();
    }
  }

  /* -------------------------------------------------------------- general */

  function pick(days: number) {
    settings.setTrashRetentionDays(days);
    customDays = String(days);
  }

  function applyCustom() {
    const n = Math.round(Number(customDays));
    if (!Number.isFinite(n) || n < 0) {
      toast.push('warn', i18n.t('set.trash.badDays'));
      customDays = String(settings.trashRetentionDays);
      return;
    }
    settings.setTrashRetentionDays(n);
    toast.push('info', n === 0 ? i18n.t('set.trash.neverToast') : i18n.t('set.trash.toast', { n }));
  }

  function pickStep(sec: number) {
    settings.setSeekStep(sec);
    customStep = settings.seekStepLabel;
  }

  function applyCustomStep() {
    const n = Number(customStep);
    if (!Number.isFinite(n) || n <= 0) {
      toast.push('warn', i18n.t('set.skip.bad'));
      customStep = settings.seekStepLabel;
      return;
    }
    settings.setSeekStep(n);
    customStep = settings.seekStepLabel;
    toast.push('info', i18n.t('set.skip.toast', { n: settings.seekStepLabel }));
  }

  async function cleanExpired() {
    if (cleaning) return;
    cleaning = true;
    try {
      const db = await defaultDbPath();
      const removed = await purgeExpiredTrash(db, settings.trashRetentionDays);
      if (removed > 0) toast.push('info', i18n.t('set.trash.cleaned', { n: removed }));
      else toast.push('info', i18n.t('set.trash.cleanNone'));
    } catch (e) {
      toast.push('warn', i18n.t('set.trash.cleanFail', { e: String(e) }));
    } finally {
      cleaning = false;
    }
  }

  /* ------------------------------------------------------------- language */

  function chooseLang(id: UiLang) {
    i18n.setLang(id);
    toast.push('info', i18n.t('set.lang.toast', { name: i18n.currentNative }));
  }

  /* ------------------------------------------------------------ appearance */

  /** The one style every preset chip shares; only the palette changes. */
  const chip = (active: boolean): string =>
    `rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors duration-150 ${
      active
        ? 'border-nc-brand bg-nc-brand/15 text-nc-brand'
        : 'border-nc-line bg-nc-panel text-nc-mut hover:border-nc-line-2 hover:text-nc-txt'
    }`;

  function resetAppearance() {
    appearance.reset();
    toast.push('info', i18n.t('set.resetDone'));
  }

  /* ---------------------------------------------------------------- about */

  $effect(() => {
    if (layout.settingsOpen && layout.settingsTab === 'about' && !buildId) {
      void installedBuild()
        .then((b) => (buildId = b?.buildId ?? ''))
        .catch(() => (buildId = ''));
    }
  });

  /* -------------------------------------------------------------- tablist */

  function tabKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === layout.settingsTab);
    const step = e.key === 'ArrowRight' ? 1 : TABS.length - 1;
    layout.settingsTab = TABS[(i + step + TABS.length) % TABS.length].id;
    void tick().then(() =>
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    );
  }

  const isBrowser = !isTauri();
</script>

<svelte:window onkeydown={onKey} />

{#if layout.settingsOpen}
  <div
    class="fixed inset-0 z-[410] grid place-items-center bg-black/70 p-6"
    role="dialog"
    aria-modal="true"
    aria-label={i18n.t('set.title')}
  >
    <div
      class="t9-panel-in max-h-full w-full max-w-xl overflow-auto rounded-2xl border border-nc-line-2 bg-nc-panel p-6 shadow-2xl"
    >
      <!-- header -->
      <div class="mb-4 flex items-center gap-3">
        <span
          class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-nc-brand to-nc-brand-dim text-[12px] font-black text-nc-bg"
          >⚙</span
        >
        <div class="min-w-0">
          <h2 class="text-base font-bold">{i18n.t('set.title')}</h2>
          <p class="truncate text-[11px] text-nc-mut">{i18n.t('set.sub')}</p>
        </div>
        <div class="flex-1"></div>
        <button
          onclick={() => (layout.settingsOpen = false)}
          class="rounded-lg border border-nc-line px-3 py-1.5 text-xs text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          {i18n.t('set.close')}
        </button>
      </div>

      <!-- tabs -->
      <div
        class="flex flex-wrap items-center gap-0.5 border-b border-nc-line"
        role="tablist"
        tabindex="-1"
        aria-label={i18n.t('set.title')}
        onkeydown={tabKey}
      >
        {#each TABS as t (t.id)}
          <button
            id="settab-{t.id}"
            role="tab"
            aria-selected={layout.settingsTab === t.id}
            aria-controls="setpanel-{t.id}"
            onclick={() => (layout.settingsTab = t.id)}
            class="relative rounded-t-md px-3 py-2 text-[12.5px] font-medium transition-colors duration-150
                   {layout.settingsTab === t.id ? 'text-nc-txt' : 'text-nc-mut hover:text-nc-txt'}"
          >
            {i18n.t(t.label)}
            {#if layout.settingsTab === t.id}
              <span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-nc-brand"></span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- the active tab's content, on a 180 ms settle -->
      {#key layout.settingsTab}
        <div
          class="t9-panel-in mt-4"
          id="setpanel-{layout.settingsTab}"
          role="tabpanel"
          aria-labelledby="settab-{layout.settingsTab}"
        >
          {#if layout.settingsTab === 'general'}
            <section class="rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <div class="flex items-baseline justify-between gap-3">
                <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                  {i18n.t('set.trash.title')}
                </h3>
                <span class="text-[11px] text-nc-mut">
                  {i18n.t('set.trash.auto', {
                    value: settings.trashNever
                      ? i18n.t('set.trash.autoNever')
                      : i18n.t('set.trash.days', { n: settings.trashRetentionDays })
                  })}
                </span>
              </div>

              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {settings.trashNever
                  ? i18n.t('set.trash.descNever')
                  : i18n.t('set.trash.desc1', { n: settings.trashRetentionDays })}
                <b class="text-nc-txt">{i18n.t('set.trash.desc2')}</b>
              </p>

              <div class="mt-3 flex flex-wrap gap-2">
                {#each PRESETS as days (days)}
                  <button
                    onclick={() => pick(days)}
                    class={chip(settings.trashRetentionDays === days)}
                  >
                    {days === 0
                      ? i18n.t('set.trash.autoNever')
                      : i18n.t('set.trash.days', { n: days })}
                  </button>
                {/each}
              </div>

              <div class="mt-3 flex items-center gap-2">
                <label class="text-[11px] text-nc-mut" for="trash-days">
                  {i18n.t('set.trash.custom')}
                </label>
                <input
                  id="trash-days"
                  type="number"
                  min="0"
                  max="3650"
                  step="1"
                  bind:value={customDays}
                  onchange={applyCustom}
                  class="w-24 rounded-md border border-nc-line bg-nc-bg px-2 py-1 text-[12px] text-nc-txt outline-none focus:border-nc-brand"
                />
                <span class="text-[11px] text-nc-mut-2">{i18n.t('set.trash.zero')}</span>
              </div>

              <div class="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onclick={cleanExpired}
                  disabled={cleaning || isBrowser}
                  class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                         transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt disabled:opacity-50"
                >
                  {cleaning ? i18n.t('set.trash.cleaning') : i18n.t('set.trash.clean')}
                </button>
                <button
                  onclick={() => pick(TRASH_DAYS_DEFAULT)}
                  class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                         transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
                >
                  {i18n.t('set.trash.reset')}
                </button>
                {#if isBrowser}
                  <span class="text-[10px] text-nc-mut-2">{i18n.t('set.trash.browser')}</span>
                {/if}
              </div>
            </section>

            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <div class="flex items-baseline justify-between gap-3">
                <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                  {i18n.t('set.skip.title')}
                </h3>
                <span class="text-[11px] text-nc-mut">
                  {i18n.t('set.skip.status', { n: settings.seekStepLabel })}
                </span>
              </div>

              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.skip.desc')}
              </p>

              <div class="mt-3 flex flex-wrap gap-2">
                {#each STEP_PRESETS as s (s)}
                  <button onclick={() => pickStep(s)} class={chip(settings.seekStepSec === s)}>
                    {s}s
                  </button>
                {/each}
              </div>

              <div class="mt-3 flex items-center gap-2">
                <label class="text-[11px] text-nc-mut" for="skip-step">
                  {i18n.t('set.skip.custom')}
                </label>
                <input
                  id="skip-step"
                  type="number"
                  min="0.5"
                  max="60"
                  step="0.5"
                  bind:value={customStep}
                  onchange={applyCustomStep}
                  class="w-24 rounded-md border border-nc-line bg-nc-bg px-2 py-1 text-[12px] text-nc-txt outline-none focus:border-nc-brand"
                />
                <span class="text-[11px] text-nc-mut-2">{i18n.t('set.skip.range')}</span>
              </div>

              <div class="mt-4">
                <button
                  onclick={() => pickStep(SEEK_STEP_DEFAULT)}
                  class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                         transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
                >
                  {i18n.t('set.skip.reset', { n: SEEK_STEP_DEFAULT })}
                </button>
              </div>
            </section>

            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <div class="flex items-baseline justify-between gap-3">
                <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                  {i18n.t('set.auto.title')}
                </h3>
                <span class="text-[11px] text-nc-mut">
                  {settings.autoTranscribe ? i18n.t('set.auto.on') : i18n.t('set.auto.off')}
                </span>
              </div>

              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.auto.desc')}
              </p>

              <div class="mt-3 flex items-center gap-2">
                <button
                  role="switch"
                  aria-checked={settings.autoTranscribe}
                  aria-label={i18n.t('set.auto.label')}
                  title={i18n.t('set.auto.label')}
                  onclick={() => {
                    settings.setAutoTranscribe(!settings.autoTranscribe);
                    toast.push(
                      'info',
                      settings.autoTranscribe ? i18n.t('set.auto.on') : i18n.t('set.auto.off')
                    );
                  }}
                  class="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150
                         {settings.autoTranscribe ? 'bg-nc-brand' : 'bg-nc-panel-2'}"
                >
                  <span
                    class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150
                           {settings.autoTranscribe ? 'translate-x-4' : ''}"
                  ></span>
                </button>
                <span class="text-[12px] text-nc-txt">{i18n.t('set.auto.label')}</span>
              </div>

              <p class="mt-2 text-[10.5px] leading-snug text-nc-mut-2">
                {i18n.t('set.auto.hint')}
              </p>
            </section>
          {:else if layout.settingsTab === 'language'}
            <section class="rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.lang.title')}
              </h3>
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.lang.desc')}
              </p>

              <div class="mt-3 grid gap-2" role="radiogroup" aria-label={i18n.t('set.lang.title')}>
                {#each UI_LANGS as lang (lang.id)}
                  <button
                    role="radio"
                    aria-checked={i18n.lang === lang.id}
                    onclick={() => chooseLang(lang.id)}
                    class="flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150
                           {i18n.lang === lang.id
                      ? 'border-nc-brand bg-nc-brand/12 text-nc-txt'
                      : 'border-nc-line bg-nc-panel text-nc-txt hover:border-nc-line-2'}"
                  >
                    <span class="text-[13px] font-medium">{lang.native}</span>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-nc-mut-2">
                      {lang.note}
                    </span>
                    {#if i18n.lang === lang.id}
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="shrink-0 text-nc-brand"
                        aria-hidden="true"
                      >
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                    {/if}
                  </button>
                {/each}
              </div>

              <p class="mt-3 text-[10.5px] text-nc-mut-2">{i18n.t('set.lang.note')}</p>
            </section>
          {:else if layout.settingsTab === 'appearance'}
            <!-- accent -->
            <section class="rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.look.title')}
              </h3>
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.look.desc')}
              </p>
              <div class="mt-3 flex flex-wrap items-center gap-2.5">
                {#each appearanceAccents as a (a.id)}
                  <button
                    onclick={() => appearance.set('accent', a.id)}
                    aria-pressed={appearance.accent === a.id}
                    aria-label={i18n.t(`set.look.${a.id}`)}
                    title={i18n.t(`set.look.${a.id}`)}
                    class="grid h-8 w-8 place-items-center rounded-full border-2 transition-[border-color,filter] duration-150
                           {appearance.accent === a.id
                      ? 'border-nc-txt'
                      : 'border-transparent hover:brightness-110'}"
                    style="background:{a.brand}"
                  >
                    {#if appearance.accent === a.id}
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#0b0d10"
                        stroke-width="3.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                    {/if}
                  </button>
                {/each}
              </div>
            </section>

            <!-- typography -->
            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.typo.title')}
              </h3>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each appearanceTypo as t (t)}
                  <button
                    onclick={() => appearance.set('typography', t)}
                    aria-pressed={appearance.typography === t}
                    class={chip(appearance.typography === t)}
                  >
                    {i18n.t(`set.typo.${t}`)}
                  </button>
                {/each}
              </div>
            </section>

            <!-- text size + density -->
            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.size.title')}
              </h3>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each appearanceSizes as s (s)}
                  <button
                    onclick={() => appearance.set('textSize', s)}
                    aria-pressed={appearance.textSize === s}
                    class={chip(appearance.textSize === s)}
                  >
                    {i18n.t(`set.size.${s}`)}
                  </button>
                {/each}
              </div>

              <h3 class="mt-4 text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.density.title')}
              </h3>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each appearanceDensity as d (d)}
                  <button
                    onclick={() => appearance.set('density', d)}
                    aria-pressed={appearance.density === d}
                    class={chip(appearance.density === d)}
                  >
                    {i18n.t(`set.density.${d}`)}
                  </button>
                {/each}
              </div>
            </section>

            <!-- panels -->
            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.panels.title')}
              </h3>
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.panels.desc')}
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each appearancePanels as p (p)}
                  <button
                    onclick={() => appearance.set('panels', p)}
                    aria-pressed={appearance.panels === p}
                    class={chip(appearance.panels === p)}
                  >
                    {i18n.t(`set.panels.${p}`)}
                  </button>
                {/each}
              </div>
            </section>

            <!-- motion -->
            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.motion.title')}
              </h3>
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.motion.desc')}
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each appearanceMotion as m (m)}
                  <button
                    onclick={() => appearance.set('motion', m)}
                    aria-pressed={appearance.motion === m}
                    class={chip(appearance.motion === m)}
                  >
                    {i18n.t(`set.motion.${m}`)}
                  </button>
                {/each}
              </div>

              <div class="mt-4 flex justify-end">
                <button
                  onclick={resetAppearance}
                  class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                         transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
                >
                  {i18n.t('set.reset')}
                </button>
              </div>
            </section>
          {:else}
            <section class="rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.about.title')}
              </h3>

              <p class="mt-2 text-[12.5px] leading-relaxed text-nc-mut">
                {i18n.t('set.about.blurb')}
              </p>

              <div class="mt-3 grid gap-2">
                <div
                  class="flex items-center justify-between gap-3 rounded-lg border border-nc-line bg-nc-panel px-3 py-2"
                >
                  <span class="text-[11px] text-nc-mut">{i18n.t('set.about.version')}</span>
                  <span class="font-mono text-[12px] text-nc-txt tabular-nums">{app.version}</span>
                </div>
                {#if buildId}
                  <div
                    class="flex items-center justify-between gap-3 rounded-lg border border-nc-line bg-nc-panel px-3 py-2"
                  >
                    <span class="text-[11px] text-nc-mut">{i18n.t('set.about.build')}</span>
                    <span class="truncate font-mono text-[12px] text-nc-txt">{buildId}</span>
                  </div>
                {/if}
              </div>

              <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span class="text-[11px] text-nc-mut-2">{i18n.t('set.about.helpHint')}</span>
                <button
                  onclick={() => {
                    layout.settingsOpen = false;
                    layout.helpOpen = true;
                  }}
                  class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-txt
                         transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
                >
                  {i18n.t('set.about.help')}
                </button>
              </div>
            </section>
          {/if}
        </div>
      {/key}
    </div>
  </div>
{/if}
