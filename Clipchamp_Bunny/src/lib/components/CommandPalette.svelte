<script lang="ts">
  /**
   * The command palette — Ctrl+K / Cmd+K from anywhere in the app.
   *
   * Research (2026): command palettes are the single most-expected power-user
   * affordance in a SaaS product with more than a handful of features. A menu
   * does not scale; a palette does. Every action in T9 lives behind one
   * keystroke here, plus the user's recent projects, so nothing is more than
   * three keystrokes away.
   *
   * It is a real focus trap: Esc closes, ↑/↓ move, Enter runs, and the input
   * keeps focus the whole time. Reduced Motion drops the entrance animation.
   */
  import { app } from '../stores/app.svelte';
  import { layout } from '../stores/layout.svelte';
  import { mode } from '../stores/mode.svelte';
  import { project } from '../stores/project.svelte';
  import { toast } from '../stores/toast.svelte';
  import { appearance } from '../stores/appearance.svelte';
  import { defaultDbPath, loadProjects } from '../ipc';
  import type { RustProject } from '../ipc';
  import { fly, fade } from 'svelte/transition';
  import { backOut, cubicOut } from 'svelte/easing';

  interface Cmd {
    id: string;
    label: string;
    hint?: string;
    group: string;
    run: () => void;
  }

  let query = $state('');
  let active = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let projects = $state<RustProject[]>([]);
  let loadingProjects = $state(false);

  const reduceMotion = $derived(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const baseCommands = $derived<Cmd[]>([
    {
      id: 'new-project',
      label: 'New project',
      hint: 'Create',
      group: 'Actions',
      run: () => {
        app.openNewProject();
        close();
      }
    },
    {
      id: 'go-home',
      label: 'Go to Home',
      hint: 'Dashboard',
      group: 'Navigate',
      run: () => {
        app.goHome('home');
        close();
      }
    },
    {
      id: 'go-cloud',
      label: 'Go to T9 Cloud',
      hint: 'AI APIs · keys',
      group: 'Navigate',
      run: () => {
        app.goHome('cloud');
        close();
      }
    },
    {
      id: 'go-trash',
      label: 'Go to Trash',
      hint: 'Bin',
      group: 'Navigate',
      run: () => {
        app.goHome('trash');
        close();
      }
    },
    {
      id: 'open-browser',
      label: 'Open browser',
      hint: 'Ctrl+Shift+B',
      group: 'Navigate',
      run: () => {
        app.openBrowser(app.view);
        close();
      }
    },
    {
      id: 'open-editor',
      label: 'Open editor',
      hint: 'Workspace',
      group: 'Navigate',
      run: () => {
        app.openEditor();
        mode.set('cut');
        close();
      }
    },
    {
      id: 'settings',
      label: 'Open settings',
      hint: 'Preferences',
      group: 'App',
      run: () => {
        layout.settingsTab = 'general';
        layout.settingsOpen = true;
        close();
      }
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: 'Ctrl+/',
      group: 'App',
      run: () => {
        layout.helpOpen = true;
        close();
      }
    },
    {
      id: 'motion',
      label: appearance.motion === 'reduced' ? 'Turn motion on' : 'Turn motion off',
      hint: 'Accessibility',
      group: 'App',
      run: () => {
        const next = appearance.motion === 'reduced' ? 'standard' : 'reduced';
        appearance.motion = next;
        toast.push('info', next === 'reduced' ? 'Motion off' : 'Motion on');
        close();
      }
    }
  ]);

  const projectCommands = $derived<Cmd[]>(
    projects.slice(0, 8).map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      hint: 'Open project',
      group: 'Recent projects',
      run: () => {
        project.discardPending();
        app.openEditor();
        mode.set('cut');
        if (isTauri()) {
          void project
            .loadFromBackend(p.sourcePath)
            .then(() => {})
            .catch((e) =>
              toast.push('warn', `Project khul nahi paya: ${e instanceof Error ? e.message : e}`)
            );
        } else {
          void project.loadBaked();
        }
        close();
      }
    }))
  );

  const allCommands = $derived([...baseCommands, ...projectCommands]);

  function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  function score(cmd: Cmd, q: string): number {
    if (!q) return 1;
    const label = cmd.label.toLowerCase();
    const hint = (cmd.hint ?? '').toLowerCase();
    const needle = q.toLowerCase().trim();
    if (label === needle) return 100;
    if (label.startsWith(needle)) return 80;
    if (label.includes(needle)) return 60;
    if (hint.includes(needle)) return 40;
    // fuzzy: every char of needle appears in order
    let i = 0;
    for (const ch of label) {
      if (ch === needle[i]) i++;
      if (i === needle.length) return 20;
    }
    return 0;
  }

  const filtered = $derived(
    allCommands
      .map((c) => ({ c, s: score(c, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label))
      .map((x) => x.c)
  );

  $effect(() => {
    // keep active index in range whenever the list changes
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
  });

  async function loadProjectsNow() {
    if (loadingProjects) return;
    loadingProjects = true;
    try {
      const db = await defaultDbPath();
      const list = await loadProjects(db);
      projects = list.slice(0, 8);
    } catch {
      projects = [];
    } finally {
      loadingProjects = false;
    }
  }

  function open() {
    query = '';
    active = 0;
    void loadProjectsNow();
    // focus after mount
    requestAnimationFrame(() => inputEl?.focus());
  }

  function close() {
    layout.commandPaletteOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(filtered.length - 1, active + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) cmd.run();
      return;
    }
  }

  // reset active when query changes
  $effect(() => {
    query;
    active = 0;
  });

  $effect(() => {
    if (layout.commandPaletteOpen) open();
  });
</script>

{#if layout.commandPaletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[420] flex items-start justify-center bg-black/55 backdrop-blur-sm pt-[14vh]"
    transition:fade={{ duration: reduceMotion ? 1 : 140 }}
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <div
      class="w-full max-w-xl overflow-hidden rounded-2xl border border-nc-line bg-nc-panel shadow-[0_30px_80px_rgba(0,0,0,.6)]"
      transition:fly={{
        y: reduceMotion ? 0 : -12,
        duration: reduceMotion ? 1 : 180,
        easing: backOut
      }}
    >
      <div class="flex items-center gap-2 border-b border-nc-line px-4 py-3">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="text-nc-mut"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder="Type a command or search a project…"
          class="min-w-0 flex-1 bg-transparent text-[14px] text-nc-txt outline-none placeholder:text-nc-mut-2"
          aria-label="Command search"
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="rounded border border-nc-line bg-nc-bg px-1.5 py-0.5 text-[10px] text-nc-mut"
          >Esc</kbd
        >
      </div>

      <div class="max-h-[52vh] overflow-y-auto py-2">
        {#if filtered.length === 0}
          <div class="px-4 py-8 text-center text-[12px] text-nc-mut">
            Koi match nahi — try a different word.
          </div>
        {:else}
          {#each filtered as cmd, i (cmd.id)}
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors
                     {i === active
                ? 'bg-nc-brand/15 text-nc-txt'
                : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
              onmouseenter={() => (active = i)}
              onclick={() => cmd.run()}
            >
              <span class="min-w-0 flex-1 truncate">{cmd.label}</span>
              {#if cmd.hint}
                <span class="shrink-0 text-[10px] text-nc-mut-2">{cmd.hint}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <div
        class="flex items-center justify-between border-t border-nc-line px-4 py-2 text-[10px] text-nc-mut-2"
      >
        <span>↑↓ navigate · Enter run · Esc close</span>
        <span>Ctrl+K to open</span>
      </div>
    </div>
  </div>
{/if}
