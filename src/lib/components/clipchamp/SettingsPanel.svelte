<script lang="ts">
  /**
   * Settings panel — manage Gemini & Groq API keys locally.
   */
  const GEMINI_KEY = "t9.geminiApiKey";
  const GROQ_KEY = "t9.groqApiKey";

  let gemini = $state(localStorage.getItem(GEMINI_KEY) || "");
  let groq = $state(localStorage.getItem(GROQ_KEY) || "");
  let showGemini = $state(false);
  let showGroq = $state(false);
  let saved = $state(false);
  let daemonStatus = $state<"checking" | "online" | "offline">("checking");

  async function checkDaemon() {
    try {
      const res = await fetch("http://127.0.0.1:7878/healthz");
      if (res.ok) daemonStatus = "online";
      else daemonStatus = "offline";
    } catch {
      daemonStatus = "offline";
    }
  }

  $effect(() => {
    void checkDaemon();
  });

  function save() {
    localStorage.setItem(GEMINI_KEY, gemini.trim());
    localStorage.setItem(GROQ_KEY, groq.trim());
    saved = true;
    setTimeout(() => (saved = false), 1800);
  }

  function clearAll() {
    gemini = "";
    groq = "";
    localStorage.removeItem(GEMINI_KEY);
    localStorage.removeItem(GROQ_KEY);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between">
      <h3 class="text-[13px] font-semibold text-cc-text">API keys</h3>
      <span
        class="inline-flex items-center gap-1.5 text-[11px] {daemonStatus === 'online'
          ? 'text-emerald-500'
          : 'text-amber-500'}"
      >
        <span
          class="h-2 w-2 rounded-full {daemonStatus === 'online'
            ? 'bg-emerald-500'
            : 'bg-amber-500'}"
        ></span>
        {daemonStatus === "online" ? "Daemon Online" : "Daemon Offline"}
      </span>
    </div>
    <p class="text-[11.5px] text-cc-text-3">
      Stored locally on this device. Used by the cloud daemon for transcription & analysis.
    </p>
  </div>

  <!-- Gemini -->
  <div class="flex flex-col gap-1.5">
    <label class="text-[12px] font-medium text-cc-text-2" for="gemini-key">Gemini API key</label>
    <div class="flex items-center gap-2">
      <input
        id="gemini-key"
        type={showGemini ? "text" : "password"}
        bind:value={gemini}
        placeholder="AIza…"
        class="h-8 flex-1 rounded border border-cc-line bg-cc-bg px-2 text-[12.5px] text-cc-text outline-none focus:border-cc-purple"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        type="button"
        class="cc-btn cc-btn-ghost h-8 px-2 text-[11.5px]"
        onclick={() => (showGemini = !showGemini)}
      >
        {showGemini ? "Hide" : "Show"}
      </button>
    </div>
    <p class="text-[11px] text-cc-text-3">
      Status: {gemini.trim() ? "configured" : "not set"}
    </p>
  </div>

  <!-- Groq -->
  <div class="flex flex-col gap-1.5">
    <label class="text-[12px] font-medium text-cc-text-2" for="groq-key">Groq API key</label>
    <div class="flex items-center gap-2">
      <input
        id="groq-key"
        type={showGroq ? "text" : "password"}
        bind:value={groq}
        placeholder="gsk_…"
        class="h-8 flex-1 rounded border border-cc-line bg-cc-bg px-2 text-[12.5px] text-cc-text outline-none focus:border-cc-purple"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        type="button"
        class="cc-btn cc-btn-ghost h-8 px-2 text-[11.5px]"
        onclick={() => (showGroq = !showGroq)}
      >
        {showGroq ? "Hide" : "Show"}
      </button>
    </div>
    <p class="text-[11px] text-cc-text-3">
      Status: {groq.trim() ? "configured" : "not set"}
    </p>
  </div>

  <div class="flex items-center gap-2">
    <button type="button" class="cc-btn cc-btn-primary h-8 px-3 text-[12px]" onclick={save}>
      Save
    </button>
    <button type="button" class="cc-btn cc-btn-ghost h-8 px-3 text-[12px]" onclick={clearAll}>
      Clear all
    </button>
    {#if saved}
      <span class="text-[11.5px] text-emerald-500">Saved</span>
    {/if}
  </div>
</div>
