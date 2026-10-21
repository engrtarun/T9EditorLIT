<script lang="ts">
  /**
   * Home screen — Clipchamp's landing: greeting, the two gradient CTAs,
   * quick edits, template categories, project grid.
   *
   * "Create a new video" opens the editor, mirroring the click the REA
   * scenario performed against the real app (docs/CLIPCHAMP_REA_REFERENCE.md).
   */
  import { cc } from "../../stores/cc.svelte";
  import { project } from "../../stores/project.svelte";
  import { defaultDbPath, loadProjects, probeMedia, updateProjectOpened } from "../../ipc";
  import type { Project } from "../../types";

  const QUICK = [
    { title: "Record yourself", detail: "Use your microphone, screen or webcam" },
    { title: "Text to speech", detail: "Explore lifelike voices in over 80 languages" },
  ];
  const CATEGORIES = [
    "YouTube",
    "Instagram",
    "Intro & outro",
    "Gaming",
    "Corporate",
    "Slideshows",
    "Birthday",
    "Celebrations",
  ];

  let projects = $state<Project[]>([]);
  let loading = $state(false);

  async function loadRecentProjects() {
    loading = true;
    try {
      const dbPath = await defaultDbPath();
      projects = await loadProjects(dbPath);
    } catch {
      projects = [];
    } finally {
      loading = false;
    }
  }

  /**
   * Open a Recent-project tile — paint first, I/O second.
   *
   * The editor shell draws from empty state (stage placeholder, timeline
   * placeholder, `--:--` duration), so nothing in it needs ffprobe or SQLite
   * before the first frame moves. This used to `await` the probe plus two
   * writes *before* swapping the view: four sequential IPC round trips with
   * the screen frozen, which is exactly the "app is loading" feeling the Home
   * → editor hop had.
   *
   * `project.load` already upserts the Recent row with the probe's duration
   * (its id is the source path), so the second `saveProject` here was pure
   * duplication. `updateProjectOpened` stays: it matches on `sourcePath`, so
   * rows written under a legacy id still get their "opened" stamp.
   */
  function openProject(p: Project): void {
    cc.openEditor();
    void (async () => {
      await project.load(p.sourcePath);
      try {
        const dbPath = await defaultDbPath();
        await updateProjectOpened(dbPath, p.sourcePath, Date.now());
      } catch {
        // A stale "last opened" stamp is not worth interrupting the edit for.
      }
    })();
  }

  /**
   * Warm the probe while the pointer is still travelling to the tile.
   *
   * `probe_media` caches in SQLite by path + size + mtime, so this is a no-op
   * on every later hover and on the click itself; all it buys is that a
   * first-ever open does not pay for ffprobe's seek over a 5 GB file while the
   * user is already looking at the editor. One child process at most, no
   * buffer in the heap (AGENTS.md §1).
   */
  const warmed = new Set<string>();

  function prefetch(p: Project): void {
    if (warmed.has(p.sourcePath)) return;
    warmed.add(p.sourcePath);
    void probeMedia(p.sourcePath).catch(() => {
      // The click path reports probe failures on the store; a speculative
      // warm-up has nowhere to say anything, so it stays silent and lets the
      // next hover (or the click) try again.
      warmed.delete(p.sourcePath);
    });
  }

  $effect(() => {
    void loadRecentProjects();
  });
</script>

<div class="flex min-h-0 flex-1">
  <!-- Left nav -->
  <nav
    class="flex w-[248px] shrink-0 flex-col gap-1 border-r border-cc-line p-2"
    aria-label="Sidebar menu"
  >
    <button
      type="button"
      class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px]
        {cc.homeTab === 'home'
        ? 'bg-cc-surface font-semibold text-cc-text shadow-sm'
        : 'text-cc-text-2 hover:bg-cc-tint'}"
      aria-current={cc.homeTab === "home" ? "page" : undefined}
      onclick={() => (cc.homeTab = "home")}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </svg>
      Home
    </button>
    <button
      type="button"
      class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px]
        {cc.homeTab === 'templates'
        ? 'bg-cc-surface font-semibold text-cc-text shadow-sm'
        : 'text-cc-text-2 hover:bg-cc-tint'}"
      aria-current={cc.homeTab === "templates" ? "page" : undefined}
      onclick={() => (cc.homeTab = "templates")}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
      Templates
    </button>

    <!-- Storage card pinned to the bottom, as in the reference. -->
    <div class="mt-auto flex flex-col gap-2 rounded-lg border border-cc-line bg-cc-surface p-3">
      <span class="text-[13px] font-semibold text-cc-text">Local storage</span>
      <div class="h-1.5 overflow-hidden rounded-full bg-cc-tint">
        <div class="h-full rounded-full bg-cc-purple" style="width: 28%"></div>
      </div>
      <span class="text-[11.5px] text-cc-text-3">1.50 GB used of 5 GB (28%)</span>
      <button type="button" class="cc-btn mt-1 text-[12.5px]">Free up space</button>
      <button
        type="button"
        class="mt-1 flex items-center gap-1.5 text-[12.5px]
        font-semibold text-cc-purple hover:underline"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" />
        </svg>
        Install desktop app
      </button>
    </div>
  </nav>

  <!-- Main -->
  <main class="min-w-0 flex-1 overflow-y-auto p-6">
    {#if cc.homeTab === "home"}
      <h1 class="mb-5 text-[26px] font-semibold tracking-tight text-cc-text">
        Good to see you again
      </h1>

      <!-- The two gradient CTAs. -->
      <div class="mb-6 grid max-w-[820px] grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          class="flex items-center justify-between rounded-lg p-4 text-left text-white
            transition-transform hover:-translate-y-0.5"
          style="background: linear-gradient(115deg, var(--color-cc-purple), var(--color-cc-purple-3))"
          onclick={() => cc.openEditor()}
        >
          <span>
            <span class="block text-[15px] font-semibold">Create a new video</span>
            <span class="block text-[12.5px] opacity-90">Start from scratch</span>
          </span>
          <span
            class="flex h-7 w-7 items-center justify-center rounded-full bg-white/25 text-xl
            leading-none">+</span
          >
        </button>
        <button
          type="button"
          class="flex items-center justify-between rounded-lg p-4 text-left text-white
            transition-transform hover:-translate-y-0.5"
          style="background: linear-gradient(115deg, var(--color-cc-purple-2), #4f6bf5)"
          onclick={() => cc.openEditor()}
        >
          <span>
            <span class="block text-[15px] font-semibold">Create a video with AI</span>
            <span class="block text-[12.5px] opacity-90">Quickly auto compose a video</span>
          </span>
          <span class="text-2xl" aria-hidden="true">✦</span>
        </button>
      </div>

      <!-- Quick edits -->
      <section class="cc-panel mb-6 max-w-[820px] p-5">
        <h2 class="mb-4 text-[17px] font-semibold text-cc-text">
          Get started with these easy edits
        </h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {#each QUICK as item (item.title)}
            <div class="cc-panel overflow-hidden">
              <div
                class="h-24 w-full"
                style="background: linear-gradient(120deg, var(--color-cc-purple), var(--color-cc-lilac))"
              ></div>
              <div class="flex items-center justify-between gap-2 p-3">
                <div class="min-w-0">
                  <div class="truncate text-[13.5px] font-semibold text-cc-text">{item.title}</div>
                  <div class="truncate text-[11.5px] text-cc-text-3">{item.detail}</div>
                </div>
                <button
                  type="button"
                  class="cc-btn cc-btn-primary shrink-0 px-3 py-1 text-[12.5px]"
                  onclick={() => cc.openEditor()}
                >
                  Try it
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>

      <!-- Template categories -->
      <section class="mb-6 max-w-[820px]">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-[17px] font-semibold text-cc-text">Get inspired with a template</h2>
          <button
            type="button"
            class="text-[13px] font-semibold text-cc-purple hover:underline"
            onclick={() => (cc.homeTab = "templates")}
          >
            All templates
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          {#each CATEGORIES as category (category)}
            <button
              type="button"
              class="cc-btn rounded-full px-3.5 py-1.5 text-[12.5px]"
              onclick={() => (cc.homeTab = "templates")}
            >
              {category}
            </button>
          {/each}
        </div>
      </section>

      <!-- Projects -->
      <section>
        <h2 class="mb-3 text-[17px] font-semibold text-cc-text">Your videos</h2>
        {#if loading}
          <div class="flex items-center justify-center p-4">
            <span class="mono text-[11px] text-cc-text-3">loading recent projects…</span>
          </div>
        {:else if projects.length === 0}
          <div class="flex flex-col items-center justify-center gap-1.5 p-4 text-center">
            <span class="text-[12.5px] text-cc-text-3">no recent projects</span>
            <span class="mono text-[10px] text-cc-text-4"> import a video to see it here </span>
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {#each projects as p (p.id)}
              <button
                type="button"
                class="group text-left"
                onpointerenter={() => prefetch(p)}
                onfocus={() => prefetch(p)}
                onclick={() => openProject(p)}
              >
                <div
                  class="aspect-video w-full rounded-lg border border-cc-line bg-cc-tint
                  transition group-hover:border-cc-purple"
                ></div>
                <div class="mt-1.5 truncate text-[12.5px] font-medium text-cc-text">
                  {p.name}
                </div>
                <div class="truncate text-[11.5px] text-cc-text-3">
                  {Math.floor(p.durationSecs / 60)}:{String(
                    Math.floor(p.durationSecs % 60),
                  ).padStart(2, "0")}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {:else}
      <!-- Templates tab: the gallery grid. -->
      <h1 class="mb-5 text-[26px] font-semibold tracking-tight text-cc-text">Templates</h1>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {#each Array(12) as _, i (i)}
          <button type="button" class="text-left" onclick={() => cc.openEditor()}>
            <div
              class="aspect-video w-full rounded-lg border border-cc-line"
              style="background: linear-gradient({110 + i * 17}deg,
                color-mix(in oklab, var(--color-cc-purple) {18 +
                (i % 5) * 8}%, var(--color-cc-surface)),
                color-mix(in oklab, var(--color-cc-lilac) {26 +
                (i % 4) * 9}%, var(--color-cc-surface)))"
            ></div>
            <div class="mt-1.5 text-[12.5px] font-medium text-cc-text">Template {i + 1}</div>
          </button>
        {/each}
      </div>
    {/if}
  </main>
</div>
