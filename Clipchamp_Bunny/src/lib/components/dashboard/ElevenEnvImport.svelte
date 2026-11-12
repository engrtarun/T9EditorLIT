<script lang="ts">
  /**
   * THE .env IMPORT BLOCK — one input for a whole folder of keys.
   *
   * ElevenLabs is a POOL, so the realistic move is not pasting keys one at a
   * time: the user has a hand-maintained `.env` with every account in it.
   * This block pastes (or picks) that file and hands it to the daemon's
   * `POST /v1/keys/elevenlabs/import`, which:
   *
   *   · reads only THREE variables (ELEVENLABS_API_KEYS, GROQ_API_KEY,
   *     GEMINI_API_KEY) — a secrets import never becomes a config import,
   *   · probes every candidate ElevenLabs key, so a batch reports its dead
   *     keys instead of failing on the first one,
   *   · fills the Groq and Gemini overlays too when the file carries them.
   *
   * The file is read HERE, in the frontend (a File is already in this
   * process), and travels as content over loopback — the daemon is never
   * asked to become a general file reader.
   *
   * Owned by ElevenKeysPanel: it only tells the parent "something landed,
   * re-read the pool" through `onImported`.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { importElevenEnv } from '../../cloud';

  interface Props {
    /** Called after a successful import, so the parent can re-read the pool. */
    onImported: () => void;
  }

  let { onImported }: Props = $props();

  let envText = $state('');
  let importing = $state(false);
  /** Success line: "2 added · 1 rejected · 3 already there". */
  let summary = $state('');
  let error = $state('');

  async function runImport(): Promise<void> {
    if (importing) return;
    const content = envText.trim();
    if (!content) {
      error = i18n.t('cloud.eleven.needEnv');
      return;
    }
    importing = true;
    error = '';
    summary = '';
    try {
      const res = await importElevenEnv({ content });
      if (!res.ok) {
        // Same vocabulary as the panel: a stable token becomes a sentence.
        error =
          res.detail === 'unavailable'
            ? i18n.t('cloud.daemonDown')
            : res.detail === 'network'
              ? i18n.t('cloud.eleven.network')
              : res.detail;
        return;
      }
      const r = res.result;
      summary = i18n.t('cloud.eleven.imported', {
        added: r.added.length,
        rejected: r.rejected.length,
        duplicate: r.duplicate
      });
      envText = '';
      onImported();
    } finally {
      importing = false;
    }
  }

  function onFilePicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void file.text().then((text) => (envText = text));
    input.value = ''; // the same file must be pickable twice
  }
</script>

<div class="border-t border-nc-line/60 pt-3">
  <label for="t9-eleven-env" class="block text-[11px] font-medium text-nc-mut-2">
    {i18n.t('cloud.eleven.importLabel')}
  </label>

  <textarea
    id="t9-eleven-env"
    bind:value={envText}
    rows="2"
    placeholder={i18n.t('cloud.eleven.importPlaceholder')}
    spellcheck="false"
    class="mt-1.5 w-full resize-y rounded-lg border border-nc-line bg-nc-bg/70 px-3 py-2
           font-mono text-[11.5px] leading-relaxed text-nc-txt placeholder:text-nc-mut-2
           focus:border-nc-brand/60 focus:outline-none"
  ></textarea>

  <div class="mt-2 flex flex-wrap items-center gap-2">
    <button
      type="button"
      onclick={() => void runImport()}
      disabled={importing}
      class="inline-flex items-center justify-center gap-2 rounded-lg border border-nc-line
             bg-nc-panel-2 px-3 py-1.5 text-[12.5px] font-medium text-nc-txt
             transition-[border-color] duration-150 hover:border-nc-brand/50
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nc-brand
             disabled:opacity-60"
    >
      {#if importing}
        <span
          class="t9-spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px]
                 border-nc-brand/30 border-t-nc-brand"
          aria-hidden="true"
        ></span>
      {/if}
      {i18n.t('cloud.eleven.import')}
    </button>

    <!-- Visually hidden input, but keyboard focusable — the label carries the
         focus ring so tabbing to the invisible input still shows where you
         are. -->
    <label
      class="inline-flex cursor-pointer items-center rounded-lg px-2 py-1.5 text-[12px] text-nc-mut
             transition-colors hover:text-nc-txt
             focus-within:ring-1 focus-within:ring-nc-brand/60 focus-within:text-nc-txt"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        class="mr-1.5"
        aria-hidden="true"
      >
        <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v13m0-13-4 4m4-4 4 4" />
      </svg>
      {i18n.t('cloud.eleven.pickFile')}
      <input type="file" accept=".env,.txt,text/plain" onchange={onFilePicked} class="sr-only" />
    </label>
  </div>

  <!-- The outcome speaks for itself; role=status announces it politely. -->
  {#if summary}
    <p role="status" class="mt-2 text-[12px] text-nc-green">{summary}</p>
  {:else if error}
    <p role="alert" class="mt-2 text-[12px] text-nc-red">{error}</p>
  {/if}
</div>
