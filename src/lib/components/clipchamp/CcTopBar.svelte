<script lang="ts">
  /**
   * Clipchamp-style top bar.
   *
   * Two variants, one per screen:
   *   • home    — search box in the middle (Clipchamp's template search)
   *   • editor  — project title, then the two T9 readouts that must never be
   *               a tab away: the mode switcher and the live RAM meter.
   *
   * Three popovers live here, each built from CcMenu so they share the same
   * outside-click / Escape handling and the same Fluent row styling:
   *
   *   1. Project title — Rename (inline field) / Open file location /
   *      divider / Create a new video. The row set and order come straight
   *      from resource_Clipchamp/singleFiles/fileRenameer.html.
   *   2. Cloud — connection status plus the two ways into the vault, and
   *      the three API backends the avatar menu will own once the backend
   *      lands (see cell 6 of resource_Clipchamp/desing4use.ipynb).
   *   3. Theme — Clipchamp dark / Nanami / Clipchamp light.
   *
   * The RAM meter stays here in every mode on purpose — see AGENTS.md §4.
   */
  import { tick } from "svelte";
  import ModeSwitcher from "../ModeSwitcher.svelte";
  import RamMeter from "../RamMeter.svelte";
  import CcMenu from "./CcMenu.svelte";
  import { cc } from "../../stores/cc.svelte";
  import { project } from "../../stores/project.svelte";
  import { shortcuts } from "../../stores/shortcuts.svelte";
  import { theme, THEME_LABEL, type ThemeId } from "../../stores/theme.svelte";
  import { defaultDbPath, loadProjects, revealInFolder, saveProject, vaultStatus } from "../../ipc";

  let { variant = "home" }: { variant?: "home" | "editor" } = $props();

  /** Display order in the theme menu. */
  const THEMES: ThemeId[] = ["clipchamp", "nanami", "clipchamp-light"];

  let open: "title" | "cloud" | "theme" | null = $state(null);
  /** True while the title menu is showing its inline rename field. */
  let renaming = $state(false);
  let draft = $state("");
  let renameField: HTMLInputElement | null = $state(null);

  function toggle(which: "title" | "cloud" | "theme"): void {
    open = open === which ? null : which;
    renaming = false;
  }

  // ── Project title ───────────────────────────────────────────────────────
  /** Folder shown under "Open file location", mirroring the source's
   *  `drives > … > root: > Videos > Clipchamp` second line. */
  const locationLabel = $derived(
    project.info
      ? project.info.path.split(/[\\/]/).slice(0, -1).join(" › ")
      : "no project open yet",
  );

  async function startRename(): Promise<void> {
    draft = cc.projectName;
    renaming = true;
    await tick();
    renameField?.focus();
    renameField?.select();
  }

  /**
   * Commit the rename.
   *
   * `saveProject` upserts on `id`, and `project.load` uses the source path
   * as the id — so re-saving under the same id with a new name is a rename.
   * Rows written before that convention are looked up by `sourcePath` first,
   * otherwise a legacy `p1` row would be left behind alongside a fresh one.
   */
  async function commitRename(): Promise<void> {
    const name = draft.trim();
    renaming = false;
    if (!name || name === cc.projectName) {
      open = null;
      return;
    }
    cc.projectName = name;
    open = null;
    if (!project.info) return;
    try {
      const dbPath = await defaultDbPath();
      const rows = await loadProjects(dbPath);
      const existing = rows.find((r) => r.sourcePath === project.info?.path);
      await saveProject(
        dbPath,
        existing?.id ?? project.info.path,
        name,
        project.info.path,
        project.info.durationSecs,
        Date.now(),
      );
    } catch {
      // The in-memory name is already updated; a failed persist only means
      // the row keeps its old label until the next successful save.
    }
  }

  function cancelRename(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      renaming = false;
      open = null;
    }
  }

  async function openFileLocation(): Promise<void> {
    open = null;
    if (!project.info) return;
    try {
      await revealInFolder(project.info.path);
    } catch {
      // Explorer refusing to open is not worth interrupting the edit for.
    }
  }

  /** "Create a new video" from the title menu — same fresh-editor state the
   *  home screen's CTA reaches, without a trip back through Home. */
  function createNewVideo(): void {
    open = null;
    project.clear();
    cc.projectName = "Video Project 1";
    cc.openEditor();
  }

  // ── Cloud ───────────────────────────────────────────────────────────────
  let vaultState = $state<{ label: string; ok: boolean } | null>(null);

  $effect(() => {
    if (open !== "cloud") return;
    let live = true;
    vaultState = null;
    void (async () => {
      try {
        // vaultStatus talks to the local t9cloud daemon; a stopped daemon is
        // a normal state, not a failure worth interrupting the edit for.
        const status = await vaultStatus();
        if (live) {
          vaultState = {
            label: status.authorised ? "Connected" : "Not connected",
            ok: status.authorised,
          };
        }
      } catch {
        if (live) vaultState = { label: "Daemon offline", ok: false };
      }
    })();
    return () => {
      live = false;
    };
  });

  function goToRail(tab: "vault" | "settings"): void {
    open = null;
    cc.railTab = tab;
  }
</script>

<header
  class="relative z-50 flex h-12 shrink-0 items-center gap-3 border-b border-cc-line bg-cc-bg px-3"
>
  <!-- App waffle — opens the home screen. -->
  <button
    type="button"
    class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-3 hover:bg-cc-tint"
    title="Home"
    onclick={() => cc.goHome()}
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {#each [2, 7, 12] as y (y)}
        {#each [2, 7, 12] as x (x)}
          <circle cx={x} cy={y} r="1.4" />
        {/each}
      {/each}
    </svg>
    <span class="sr-only">Home</span>
  </button>

  <!-- Identity: Clipchamp's stacked-plates mark, in the real purple ramp. -->
  <button type="button" class="flex items-center gap-2" onclick={() => cc.goHome()}>
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 6.2 12 3.4v3.4L3 9.6z" fill="var(--color-cc-purple)" />
      <path d="M3 10.4 12 7.6v3.4L3 13.8z" fill="var(--color-cc-purple-3)" />
      <path d="M13.2 8.7 17.6 7.3v3.4l-4.4 1.4z" fill="var(--color-cc-lilac)" />
    </svg>
    <span class="text-[15px] font-semibold tracking-tight text-cc-text">T9EditorLIT</span>
  </button>

  {#if variant === "home"}
    <!-- Template search, centred like Clipchamp's. -->
    <div
      class="mx-auto flex w-full max-w-md items-center gap-2 rounded-md border border-cc-line
        bg-cc-surface px-3 py-1.5"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-cc-text-4)"
        stroke-width="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        placeholder="Search templates"
        class="w-full bg-transparent text-[13px] text-cc-text outline-none
          placeholder:text-cc-text-4"
      />
    </div>
  {:else}
    <!-- Project title → menu (Rename / Open file location / Create a new video). -->
    <div class="relative">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-cc-line bg-cc-surface px-2.5
          py-1 text-[13px] font-semibold text-cc-text hover:bg-cc-tint"
        aria-haspopup="menu"
        aria-expanded={open === "title"}
        title="Project menu"
        onclick={() => toggle("title")}
      >
        {cc.projectName}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M2 4.2 6 8l4-3.8z" />
        </svg>
      </button>

      {#if open === "title"}
        <CcMenu label="Project menu" onclose={() => (open = null)}>
          {#if renaming}
            <div class="flex flex-col gap-1.5 p-1.5">
              <span class="cc-menu-sub">Rename project</span>
              <input
                class="cc-menu-input"
                bind:this={renameField}
                bind:value={draft}
                aria-label="Project name"
                onkeydown={cancelRename}
                onblur={() => void commitRename()}
              />
            </div>
          {:else}
            <button
              type="button"
              class="cc-menu-item"
              role="menuitem"
              onclick={() => void startRename()}
            >
              <span class="cc-menu-icon">
                <!-- Rename: the "rename" glyph from the source's first row. -->
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M8.5 2a.5.5 0 0 0 0 1h1v14h-1a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-1V3h1a.5.5 0 0 0 0-1h-3Zm-4 2h4v1h-4C3.67 5 3 5.67 3 6.5v7c0 .83.67 1.5 1.5 1.5h4v1h-4A2.5 2.5 0 0 1 2 13.5v-7A2.5 2.5 0 0 1 4.5 4Zm11 11h-4v1h4a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 4h-4v1h4c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">Rename</span>
            </button>

            <button
              type="button"
              class="cc-menu-item"
              data-lines="2"
              role="menuitem"
              disabled={!project.info}
              onclick={() => void openFileLocation()}
            >
              <span class="cc-menu-icon">
                <!-- Open file location: the folder glyph from the source. -->
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M4.5 3A2.5 2.5 0 0 0 2 5.5v9A2.5 2.5 0 0 0 4.5 17h11a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 5H9.7L8.23 3.51A1.75 1.75 0 0 0 6.98 3H4.5ZM3 5.5C3 4.67 3.67 4 4.5 4h2.48c.2 0 .4.08.53.22L8.8 5.5 7.44 6.85a.5.5 0 0 1-.35.15H3V5.5ZM3 8h4.09c.4 0 .78-.16 1.06-.44L9.7 6h5.79c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V8Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">
                <span>Open file location</span>
                <span class="cc-menu-sub">{locationLabel}</span>
              </span>
            </button>

            <hr class="cc-menu-divider" />

            <button
              type="button"
              class="cc-menu-item"
              role="menuitem"
              onclick={() => createNewVideo()}
            >
              <span class="cc-menu-icon">
                <!-- Create a new video: the plus-in-circle from the source. -->
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M6 10c0-.28.22-.5.5-.5h3v-3a.5.5 0 0 1 1 0v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3A.5.5 0 0 1 6 10Zm4 8a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-1a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"
                  />
                </svg>
              </span>
              <span class="cc-menu-text">Create a new video</span>
            </button>
          {/if}
        </CcMenu>
      {/if}
    </div>

    <!-- Cloud backup status (Clipchamp shows this next to the title). -->
    <div class="relative">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-3 hover:bg-cc-tint
          aria-expanded:bg-cc-tint"
        aria-label="Cloud backup"
        aria-haspopup="menu"
        aria-expanded={open === "cloud"}
        title="Cloud backup"
        onclick={() => toggle("cloud")}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 18z" />
          <path d="m9.5 14 1.8 1.8 3.4-3.6" />
        </svg>
      </button>

      {#if open === "cloud"}
        <CcMenu label="Cloud backup" onclose={() => (open = null)}>
          <div class="flex flex-col gap-0.5 px-2 py-1.5">
            <span class="text-[12.5px] font-semibold text-cc-text">Cloud backup</span>
            <span class="flex items-center gap-1.5 text-[11.5px] text-cc-text-3">
              <span
                class="h-1.5 w-1.5 rounded-full {vaultState?.ok ? 'bg-cc-keep' : 'bg-cc-text-4'}"
              ></span>
              {vaultState ? vaultState.label : "checking…"}
            </span>
          </div>

          <hr class="cc-menu-divider" />

          <button
            type="button"
            class="cc-menu-item"
            role="menuitem"
            onclick={() => goToRail("vault")}
          >
            <span class="cc-menu-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <path d="M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 18z" />
                <path d="M12 10v6m0 0-2.2-2.2M12 16l2.2-2.2" />
              </svg>
            </span>
            <span class="cc-menu-text">Backup to Telegram</span>
          </button>

          <button
            type="button"
            class="cc-menu-item"
            role="menuitem"
            onclick={() => goToRail("vault")}
          >
            <span class="cc-menu-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18M8 14h8" />
              </svg>
            </span>
            <span class="cc-menu-text">Open cloud vault</span>
          </button>

          <hr class="cc-menu-divider" />

          <button
            type="button"
            class="cc-menu-item"
            role="menuitem"
            onclick={() => goToRail("settings")}
          >
            <span class="cc-menu-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path
                  d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4"
                />
              </svg>
            </span>
            <span class="cc-menu-text">
              <span>Cloud &amp; API settings</span>
              <span class="cc-menu-sub">Telegram, Gemini, Groq</span>
            </span>
          </button>
        </CcMenu>
      {/if}
    </div>

    <div class="flex-1"></div>

    <!-- T9's own HUD, sized to sit inside the 48 px bar rather than over it. -->
    <div class="flex items-center gap-3 rounded-md border border-cc-line bg-cc-surface px-3 py-1">
      <ModeSwitcher compact />
      <span class="h-5 w-px bg-cc-line"></span>
      <RamMeter compact />
    </div>
  {/if}

  <!-- Help — opens the `Ctrl + /` cheat sheet, on both screens. -->
  <button
    type="button"
    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-cc-text-3
      hover:bg-cc-tint"
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts Ctrl + /"
    onclick={() => shortcuts.toggleSheet()}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8" />
    </svg>
  </button>

  <!-- Theme toggle — present on both screens, so it lives outside the {#if}. -->
  <div class="relative shrink-0">
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-3 hover:bg-cc-tint"
      aria-label="Theme"
      aria-haspopup="menu"
      aria-expanded={open === "theme"}
      title="Theme: {THEME_LABEL[theme.current]} — switch to {THEME_LABEL[theme.next]}"
      onclick={() => toggle("theme")}
    >
      {#if theme.current === "clipchamp-light"}
        <!-- Sun: the light theme is up. -->
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
          />
        </svg>
      {:else}
        <!-- Moon: a dark theme is up. -->
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
      {/if}
    </button>

    {#if open === "theme"}
      <CcMenu align="end" label="Theme" onclose={() => (open = null)}>
        <div class="px-2 py-1.5">
          <span class="text-[12.5px] font-semibold text-cc-text">Theme</span>
        </div>
        {#each THEMES as id (id)}
          <button
            type="button"
            class="cc-menu-item"
            role="menuitemradio"
            aria-checked={theme.current === id}
            onclick={() => {
              theme.set(id);
              open = null;
            }}
          >
            <span class="cc-menu-icon">
              {#if theme.current === id}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  aria-hidden="true"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              {/if}
            </span>
            <span class="cc-menu-text">{THEME_LABEL[id]}</span>
          </button>
        {/each}
      </CcMenu>
    {/if}
  </div>
</header>
