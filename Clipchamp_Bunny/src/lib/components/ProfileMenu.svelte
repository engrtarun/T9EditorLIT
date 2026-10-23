<script lang="ts">
  /**
   * THE PROFILE POPOVER — what the avatar in the top bar opens.
   *
   * Compact on purpose: identity on top, four destinations under it
   * (Edit profile · App settings · Language · Help & About), nothing else.
   * There is no sign-out row because there is no authentication anywhere in
   * T9 Editor LIT — a button that pretended to log somebody out would be the
   * exact kind of fake control this app must not ship.
   *
   * Behaviour:
   *   · the avatar toggles it, outside-click and Escape close it,
   *   · it is positioned from the avatar's own rectangle and clamped to the
   *     window, then re-anchored on resize/scroll so it can never be clipped
   *     or left behind,
   *   · Arrow keys / Home / End move through the items, Enter activates,
   *     focus is visible, and the editor's global shortcuts are held off
   *     while it is open (`layout.profileOpen`),
   *   · open = 160 ms fade-and-settle, close = 130 ms fade (app.css).
   *
   * The name shown is the real local Windows account name (it can be changed
   * here, and the change is stored on this machine only) — no fake account,
   * no network, no session.
   */
  import { tick } from 'svelte';
  import { layout } from '../stores/layout.svelte';
  import { i18n, UI_LANGS, type UiLang } from '../stores/i18n.svelte';
  import { toast } from '../stores/toast.svelte';
  import { accountDisplayName } from '../ipc';

  /** One popover width for the whole component — measured in CSS px. */
  const W = 268;
  const GAP = 6;
  const EDGE = 8;
  /** Matches the 130 ms close animation in app.css. */
  const CLOSE_MS = 130;

  const NAME_KEY = 't9-editor-lit.displayName';

  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);

  let open = $state(false);
  let closing = $state(false);
  let page = $state<'main' | 'language' | 'edit'>('main');

  /** Anchor position, in the coordinate space `position: fixed` resolves in. */
  let left = $state(0);
  let top = $state(0);

  let name = $state('');
  let draft = $state('');
  let nameError = $state('');

  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Initials for the avatar — derived, never an uploaded picture. */
  const initials = $derived(
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'T9'
  );

  /* ------------------------------------------------------------- placement */

  /**
   * Re-anchor to the avatar and clamp inside the window.
   *
   * One unit throughout — plain viewport pixels, which is exactly what
   * `getBoundingClientRect`, `window.innerWidth` and `position: fixed` all
   * speak. Resize and scroll re-run this while the popover is open, and it
   * flips above the avatar instead of running off the bottom edge.
   */
  function place(): void {
    const anchor = trigger;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const pw = panel?.offsetWidth || W;
    const ph = panel?.offsetHeight || 240;

    let x = Math.round(r.right - pw);
    let y = Math.round(r.bottom + GAP);

    // Flip above the avatar rather than run off the bottom edge.
    if (y + ph > vh - EDGE) y = Math.round(r.top - GAP - ph);

    left = Math.max(EDGE, Math.min(x, vw - pw - EDGE));
    top = Math.max(EDGE, Math.min(y, vh - ph - EDGE));
  }

  /* --------------------------------------------------------------- opening */

  async function show(): Promise<void> {
    page = 'main';
    open = true;
    closing = false;
    layout.profileOpen = true;
    await tick();
    place();
    focusItem(0);
  }

  function hide(returnFocus = false): void {
    if (!open || closing) return;
    closing = true;
    layout.profileOpen = false;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      open = false;
      closing = false;
      page = 'main';
      if (returnFocus) trigger?.focus();
    }, CLOSE_MS);
  }

  function toggle(): void {
    if (open && !closing) hide(true);
    else void show();
  }

  /** Close, then run something (open a dialog, switch a tab…). */
  function then(after: () => void): void {
    hide();
    setTimeout(after, CLOSE_MS);
  }

  /* ------------------------------------------------------ outside / resize */

  function onPointerDown(e: PointerEvent): void {
    if (!open || closing) return;
    const t = e.target as Node | null;
    if (panel?.contains(t ?? null) || trigger?.contains(t ?? null)) return;
    hide();
  }

  function onReposition(): void {
    if (open && !closing) place();
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (!open || closing) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide(true);
    }
  }

  /* ---------------------------------------------------------- keyboard nav */

  function menuItems(): HTMLElement[] {
    return panel
      ? Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]'))
      : [];
  }

  function focusItem(index: number): void {
    void tick().then(() => {
      const items = menuItems();
      if (!items.length) return;
      const i = ((index % items.length) + items.length) % items.length;
      items[i].focus();
    });
  }

  function onPanelKey(e: KeyboardEvent): void {
    // Inside a text field the arrows, Home and End belong to the caret.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

    const items = menuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(current < 0 ? items.length - 1 : current - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Tab':
        // Let Tab leave the popover the natural way, closed behind it.
        hide();
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- actions */

  function chooseLanguage(id: UiLang): void {
    i18n.setLang(id);
    toast.push('info', i18n.t('set.lang.toast', { name: i18n.currentNative }));
    // Stay open: the menu rewrites itself in the new language right there.
    void tick().then(() => {
      place();
      focusItem(0);
    });
  }

  function openEdit(): void {
    page = 'edit';
    draft = name;
    nameError = '';
    void tick().then(() => {
      place();
      document.querySelector<HTMLInputElement>('#profile-name')?.focus();
    });
  }

  function saveName(): void {
    const next = draft.trim();
    if (!next) {
      nameError = i18n.t('profile.nameEmpty');
      return;
    }
    name = next;
    try {
      localStorage.setItem(NAME_KEY, next);
    } catch {
      /* private mode */
    }
    nameError = '';
    page = 'main';
    toast.push('info', i18n.t('profile.saved'));
    void tick().then(() => {
      place();
      focusItem(0);
    });
  }

  /* --------------------------------------------------------------- mount */

  $effect(() => {
    // Keep the popover glued to its anchor while the world moves.
    if (open && !closing) {
      window.addEventListener('resize', onReposition);
      window.addEventListener('scroll', onReposition, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      return () => {
        window.removeEventListener('resize', onReposition);
        window.removeEventListener('scroll', onReposition, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
      };
    }
  });

  // Load the stored name; fall back to the machine's own account name.
  $effect(() => {
    if (name) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(NAME_KEY);
    } catch {
      /* private mode */
    }
    if (stored) {
      name = stored;
      return;
    }
    void accountDisplayName()
      .then((n) => {
        if (!name && n) name = n;
      })
      .catch(() => {
        if (!name) name = 'T9';
      });
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- avatar + chevron = the profile trigger (the reference layout's pair) -->
<button
  bind:this={trigger}
  onclick={toggle}
  class="ml-0.5 flex h-7 shrink-0 items-center gap-1 rounded-full pr-0.5 pl-0.5 transition-[filter] duration-150 hover:brightness-110"
  aria-haspopup="menu"
  aria-expanded={open && !closing}
  aria-label={i18n.t('profile.open')}
  title={i18n.t('profile.open')}
>
  <span
    class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-nc-brand text-[10px] font-bold text-white"
    aria-hidden="true">{initials}</span
  >
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="currentColor"
    class="shrink-0 text-white/85"
    aria-hidden="true"
  >
    <path d="M7 10l5 5 5-5z" />
  </svg>
</button>

{#if open}
  <div
    bind:this={panel}
    class="fixed z-[420] w-[268px] rounded-xl border border-nc-line-2 bg-nc-panel p-1.5 shadow-2xl"
    class:t9-pop-in={open && !closing}
    class:t9-pop-out={closing}
    style="left:{left}px; top:{top}px"
    role={page === 'edit' ? 'dialog' : 'menu'}
    aria-label={i18n.t(page === 'edit' ? 'profile.edit' : 'profile.menu')}
    onkeydown={onPanelKey}
  >
    {#key page}
      <div class="t9-panel-in">
        {#if page === 'main'}
          <!-- identity: avatar, name, and the chevron that collapses the menu -->
          <div class="flex items-center gap-2.5 px-2 pt-1.5 pb-2.5">
            <span
              class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-nc-brand text-[12px] font-bold text-white"
              aria-hidden="true">{initials}</span
            >
            <span
              class="min-w-0 flex-1 truncate text-[14px] leading-tight font-semibold text-nc-txt"
            >
              {name}
            </span>
            <button
              type="button"
              onclick={() => hide(true)}
              class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-nc-mut
                     transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
              aria-label={i18n.t('profile.close')}
              title={i18n.t('profile.close')}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M7 14l5-5 5 5z" />
              </svg>
            </button>
          </div>

          <div class="mx-1.5 mb-1 border-t border-nc-line"></div>

          <button
            role="menuitem"
            tabindex="-1"
            onclick={() => then(openEdit)}
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-nc-txt
                   transition-colors duration-150 hover:bg-nc-panel-2 focus-visible:bg-nc-panel-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-nc-mut"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
            </svg>
            {i18n.t('profile.edit')}
          </button>

          <button
            role="menuitem"
            tabindex="-1"
            onclick={() => then(() => (layout.settingsOpen = true))}
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-nc-txt
                   transition-colors duration-150 hover:bg-nc-panel-2 focus-visible:bg-nc-panel-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
              class="shrink-0 text-nc-mut"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 3a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
            {i18n.t('profile.settings')}
          </button>

          <button
            role="menuitem"
            tabindex="-1"
            onclick={() => {
              page = 'language';
              void tick().then(() => {
                place();
                focusItem(0);
              });
            }}
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-nc-txt
                   transition-colors duration-150 hover:bg-nc-panel-2 focus-visible:bg-nc-panel-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-nc-mut"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
              <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
            </svg>
            <span class="min-w-0 flex-1 truncate">
              {i18n.t('profile.language')} · {i18n.currentNative}
            </span>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="shrink-0 text-nc-mut-2"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6z" />
            </svg>
          </button>

          <button
            role="menuitem"
            tabindex="-1"
            onclick={() =>
              then(() => {
                layout.settingsTab = 'about';
                layout.settingsOpen = true;
              })}
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-nc-txt
                   transition-colors duration-150 hover:bg-nc-panel-2 focus-visible:bg-nc-panel-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0 text-nc-mut"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4" />
              <path d="M12 17.2h.01" />
            </svg>
            {i18n.t('profile.help')}
          </button>
        {:else if page === 'language'}
          <div class="px-2 pt-1.5 pb-2 text-[11px] font-bold tracking-widest text-nc-brand">
            {i18n.t('profile.language').toUpperCase()}
          </div>

          {#each UI_LANGS as lang (lang.id)}
            <button
              role="menuitemradio"
              tabindex="-1"
              onclick={() => chooseLanguage(lang.id)}
              aria-checked={i18n.lang === lang.id}
              class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]
                     transition-colors duration-150 hover:bg-nc-panel-2 focus-visible:bg-nc-panel-2
                     {i18n.lang === lang.id ? 'text-nc-brand' : 'text-nc-txt'}"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate">{lang.native}</span>
                <span class="block truncate text-[11px] text-nc-mut-2">{lang.note}</span>
              </span>
              {#if i18n.lang === lang.id}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0"
                  aria-hidden="true"
                >
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              {/if}
            </button>
          {/each}

          <div class="mx-1.5 my-1 border-t border-nc-line"></div>

          <button
            role="menuitem"
            tabindex="-1"
            onclick={() => {
              page = 'main';
              void tick().then(() => {
                place();
                focusItem(2);
              });
            }}
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-nc-mut
                   transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt focus-visible:bg-nc-panel-2"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
            {i18n.t('profile.back')}
          </button>
        {:else}
          <!-- Edit profile: a real, local rename — no account, no upload. -->
          <form
            class="px-2 pt-1.5 pb-2"
            onsubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <label
              class="block text-[11px] font-bold tracking-widest text-nc-brand"
              for="profile-name"
            >
              {i18n.t('profile.name')}
            </label>
            <input
              id="profile-name"
              bind:value={draft}
              placeholder={i18n.t('profile.namePlaceholder')}
              maxlength="40"
              aria-invalid={nameError ? 'true' : undefined}
              class="mt-2 w-full rounded-lg border border-nc-line bg-nc-bg px-2.5 py-1.5 text-[13px]
                     text-nc-txt outline-none transition-colors duration-150 focus:border-nc-brand"
            />
            {#if nameError}
              <p class="mt-1.5 text-[11px] text-nc-red">{nameError}</p>
            {/if}
            <div class="mt-3 flex items-center gap-2">
              <button
                type="submit"
                class="rounded-lg bg-nc-brand px-3 py-1.5 text-[12.5px] font-semibold text-white
                       transition-[filter] duration-150 hover:brightness-110"
              >
                {i18n.t('profile.save')}
              </button>
              <button
                type="button"
                role="menuitem"
                tabindex="-1"
                onclick={() => {
                  page = 'main';
                  nameError = '';
                  void tick().then(() => {
                    place();
                    focusItem(0);
                  });
                }}
                class="rounded-lg border border-nc-line px-3 py-1.5 text-[12.5px] text-nc-mut
                       transition-colors duration-150 hover:text-nc-txt"
              >
                {i18n.t('profile.cancel')}
              </button>
            </div>
            <p class="mt-2 text-[10.5px] leading-snug text-nc-mut-2">{i18n.t('profile.hint')}</p>
          </form>
        {/if}
      </div>
    {/key}
  </div>
{/if}
