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
    normaliseHex,
    type AccentId,
    type DensityId,
    type MotionId,
    type PanelId,
    type TextSizeId,
    type TypographyId
  } from '../stores/appearance.svelte';
  import { i18n, UI_LANGS, type UiLang } from '../stores/i18n.svelte';
  import { TIME_FORMATS, formatTimecode, type TimeFormat } from '../utils';
  import LexiconCard from './dashboard/LexiconCard.svelte';

  /** The option rows of the appearance tab, in the order they are offered. */
  const appearanceAccents = ACCENTS;
  const appearanceTypo: TypographyId[] = ['clean', 'cinematic', 'gaming'];
  const appearanceSizes: TextSizeId[] = ['sm', 'md', 'lg'];
  const appearanceDensity: DensityId[] = ['compact', 'comfortable'];
  const appearancePanels: PanelId[] = ['solid', 'translucent', 'minimal'];
  const appearanceMotion: MotionId[] = ['standard', 'reduced'];

  type TabId = 'general' | 'language' | 'appearance' | 'about';

  /**
   * A plain-English intro per tab. Settings dialogs tend to list controls and
   * leave the reader guessing what they change; this says it once, at the top,
   * before the switches.
   */
  const TAB_INTRO: Record<TabId, { title: string; body: string }> = {
    general: {
      title: 'How the editor behaves',
      body: 'Machine-level defaults — how long deleted projects stay recoverable, how far the transport skips, and how time is written. Nothing here touches your media or an export.'
    },
    language: {
      title: 'Interface language',
      body: 'Changes menus, dialogs and tooltips only. The language of a transcript is detected from the audio and is not affected by this choice.'
    },
    appearance: {
      title: 'How the app looks',
      body: 'Every option is a local preference applied through CSS variables, so the change is instant and needs no restart. Panel styling is a foreground setting — the footage itself is never tinted, blurred or filtered.'
    },
    about: {
      title: 'About this build',
      body: 'The version and build id are read from the installed binary, so what you see here is exactly what is running on this machine.'
    }
  };

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
  /** The hex field; empty means "the preset is in charge". */
  let customHex = $state(appearance.customAccent ?? '');
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

  function pickTimeFormat(fmt: TimeFormat) {
    settings.setTimeFormat(fmt);
    toast.push('info', i18n.t('set.time.toast', { value: formatTimecode(3723.45, fmt) }));
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
    customHex = '';
    toast.push('info', i18n.t('set.resetDone'));
  }

  /** A preset is the opposite of a custom colour: it clears the hex field. */
  function pickAccent(id: AccentId) {
    appearance.set('accent', id);
    customHex = '';
  }

  /** Type a hex (or pick one) and the whole UI repaints in one write. */
  function applyCustomHex(raw: string = customHex) {
    const hex = normaliseHex(raw);
    if (!hex) {
      toast.push('warn', 'That is not a colour — use a hex code like #4d8dff or #4af.');
      customHex = appearance.customAccent ?? '';
      return;
    }
    appearance.setCustomAccent(hex);
    customHex = hex;
    toast.push('info', `Accent colour set to ${hex}`);
  }

  /** The native picker fires while dragging; apply live so the preview is honest. */
  function pickerInput(e: Event) {
    const hex = (e.currentTarget as HTMLInputElement).value;
    customHex = hex;
    appearance.setCustomAccent(hex);
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
          <div class="mb-4 rounded-xl border border-nc-line bg-nc-bg/40 px-4 py-3">
            <h3 class="text-[11.5px] font-semibold text-nc-txt">
              {TAB_INTRO[layout.settingsTab].title}
            </h3>
            <p class="mt-1 text-[11px] leading-relaxed text-nc-mut">
              {TAB_INTRO[layout.settingsTab].body}
            </p>
          </div>

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
                  {i18n.t('set.time.title')}
                </h3>
                <span class="font-mono text-[11px] text-nc-mut">
                  {formatTimecode(3723.45, settings.timeFormat)}
                </span>
              </div>

              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                {i18n.t('set.time.desc')}
              </p>

              <div class="mt-3 flex flex-wrap gap-2">
                {#each TIME_FORMATS as f (f.id)}
                  <button
                    onclick={() => pickTimeFormat(f.id)}
                    class="{chip(settings.timeFormat === f.id)} font-mono"
                    title={formatTimecode(3723.45, f.id)}
                  >
                    {f.label}
                  </button>
                {/each}
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

              <div class="mt-3 flex items-center gap-2 border-t border-nc-line/70 pt-3">
                <button
                  role="switch"
                  aria-checked={settings.autoResumeTranscript}
                  aria-label={i18n.t('set.autoResume.label')}
                  title={i18n.t('set.autoResume.label')}
                  onclick={() => {
                    settings.setAutoResumeTranscript(!settings.autoResumeTranscript);
                    toast.push(
                      'info',
                      settings.autoResumeTranscript
                        ? i18n.t('set.autoResume.on')
                        : i18n.t('set.autoResume.off')
                    );
                  }}
                  class="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150
                         {settings.autoResumeTranscript ? 'bg-nc-brand' : 'bg-nc-panel-2'}"
                >
                  <span
                    class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150
                           {settings.autoResumeTranscript ? 'translate-x-4' : ''}"
                  ></span>
                </button>
                <span class="min-w-0 flex-1 text-[12px] text-nc-txt">
                  {i18n.t('set.autoResume.label')}
                </span>
                <span class="shrink-0 text-[10.5px] text-nc-mut">
                  {settings.autoResumeTranscript
                    ? i18n.t('set.autoResume.on')
                    : i18n.t('set.autoResume.off')}
                </span>
              </div>
              <p class="mt-1.5 text-[10.5px] leading-relaxed text-nc-mut-2">
                {i18n.t('set.autoResume.desc')}
              </p>
              <p class="mt-1 text-[10px] leading-snug text-nc-mut-2">
                {i18n.t('set.autoResume.hint')}
              </p>
            </section>

            <!-- Case 39: the channel's own spelling, remembered across videos. -->
            <LexiconCard />
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
                    onclick={() => pickAccent(a.id)}
                    aria-pressed={appearance.accent === a.id && !appearance.customAccent}
                    aria-label={i18n.t(`set.look.${a.id}`)}
                    title={i18n.t(`set.look.${a.id}`)}
                    class="grid h-8 w-8 place-items-center rounded-full border-2 transition-[border-color,filter] duration-150
                           {appearance.accent === a.id && !appearance.customAccent
                      ? 'border-nc-txt'
                      : 'border-transparent hover:brightness-110'}"
                    style="background:{a.brand}"
                  >
                    {#if appearance.accent === a.id && !appearance.customAccent}
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

              <!-- custom accent: the presets above, and an exact colour below -->
              <div class="mt-4 rounded-lg border border-nc-line/70 bg-nc-bg/40 p-3">
                <div class="flex items-baseline justify-between gap-3">
                  <label for="accent-hex" class="text-[11px] font-medium text-nc-txt">
                    Custom colour
                  </label>
                  <span class="font-mono text-[10px] text-nc-mut-2">#RRGGBB</span>
                </div>
                <p class="mt-1 text-[10.5px] leading-relaxed text-nc-mut-2">
                  Pick any colour or paste a hex code. The accent is one token, so this repaints
                  buttons, selections and the focus ring everywhere, and it is remembered on this
                  machine.
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick a custom accent colour"
                    value={appearance.customAccent ?? appearance.brand}
                    oninput={pickerInput}
                    class="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-nc-line bg-transparent p-0.5"
                  />
                  <input
                    id="accent-hex"
                    bind:value={customHex}
                    onchange={() => applyCustomHex()}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') applyCustomHex();
                    }}
                    placeholder="#4d8dff"
                    spellcheck="false"
                    autocomplete="off"
                    class="w-28 rounded-md border border-nc-line bg-nc-bg px-2 py-1 font-mono text-[12px]
                           tracking-wide text-nc-txt uppercase outline-none focus:border-nc-brand"
                  />
                  <button
                    onclick={() => applyCustomHex()}
                    class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                           transition-colors duration-150 hover:border-nc-brand hover:text-nc-txt"
                  >
                    Use colour
                  </button>
                  {#if appearance.customAccent}
                    <button
                      onclick={() => {
                        appearance.setCustomAccent(null);
                        customHex = '';
                      }}
                      class="rounded-lg px-2 py-1.5 text-[11px] text-nc-mut-2 underline decoration-dotted
                             underline-offset-2 transition-colors hover:text-nc-txt"
                    >
                      Back to preset
                    </button>
                  {/if}
                  <span
                    class="ml-auto h-6 w-6 rounded-full border border-white/25"
                    style="background:{appearance.brand}"
                    title={appearance.brand}
                  ></span>
                </div>
              </div>
            </section>

            <!-- typography -->
            <section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
              <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">
                {i18n.t('set.typo.title')}
              </h3>
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                The heading face. Body text keeps the system font, so a decorative face never
                reaches the transcript or a timecode. All three ship with Windows — nothing is
                downloaded.
              </p>
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
              <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
                Scales text only, never the whole webview — the timeline measures in real pixels, so
                a global zoom would make every seek land slightly off.
              </p>
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
