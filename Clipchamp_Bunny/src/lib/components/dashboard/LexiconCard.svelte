<script lang="ts">
  /**
   * The creator vocabulary (case 39).
   *
   * Whisper pays a phonetic-spelling tax on every video: "RAG" came back as
   * "Retrive Argument Document General", "ChatGPT" as "चैनल जीपीटी". The fix is
   * memory, not a better model — one term learned once applies to every later
   * transcription, both in the deterministic pass and in the autocorrect
   * prompt.
   *
   * The store owns the file; this card is the editor. A row is a canonical
   * term plus the spellings the transcriber keeps producing.
   */
  import { onMount } from 'svelte';
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    MAX_ALIASES_PER_TERM,
    entryLabel,
    normalizeLexicon,
    type LexiconEntry
  } from '../../lexicon';

  let rows = $state<LexiconEntry[]>([]);
  let freshTerm = $state('');
  let freshAliases = $state('');
  let saving = $state(false);
  let loaded = $state(false);

  onMount(() => {
    void (async () => {
      if (!project.lexicon.length) await project.loadLexicon();
      rows = project.lexicon.map((e) => ({ term: e.term, aliases: [...e.aliases] }));
      loaded = true;
    })();
  });

  function addRow() {
    const term = freshTerm.trim();
    if (!term) return;
    rows = normalizeLexicon([
      ...rows,
      {
        term,
        aliases: freshAliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      }
    ]);
    freshTerm = '';
    freshAliases = '';
  }

  function removeRow(index: number) {
    rows = rows.filter((_, i) => i !== index);
  }

  function editAliases(index: number, value: string) {
    const aliases = value
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    rows = rows.map((row, i) => (i === index ? { term: row.term, aliases } : row));
  }

  async function save() {
    saving = true;
    try {
      const clean = normalizeLexicon(rows);
      const ok = await project.saveLexiconEntries(clean);
      if (ok) {
        rows = project.lexicon.map((e) => ({ term: e.term, aliases: [...e.aliases] }));
        toast.push('info', 'Vocabulary saved — agle transcript se apply hogi.');
      } else {
        toast.push('warn', 'Vocabulary save nahi hui (daemon band hai?).');
      }
    } finally {
      saving = false;
    }
  }

  function reload() {
    void (async () => {
      await project.loadLexicon();
      rows = project.lexicon.map((e) => ({ term: e.term, aliases: [...e.aliases] }));
    })();
  }
</script>

<section class="mt-4 rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
  <div class="flex items-baseline justify-between gap-3">
    <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">CREATOR VOCABULARY</h3>
    <span class="font-mono text-[10px] text-nc-mut">{rows.length} terms</span>
  </div>
  <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
    Jo shabd channel har video me bolta hai aur Whisper har baar galat likhta hai — unki canonical
    spelling yahan ek baar daalo. Term left me, aur "heard as" spellings comma se. Deterministic
    pass aur autocorrect dono isi list ko follow karte hain.
  </p>

  {#if !loaded}
    <p class="mt-3 text-[10.5px] text-nc-mut-2">Loading…</p>
  {:else}
    <div class="mt-3 max-h-64 space-y-1.5 overflow-auto nc-scroll pr-1">
      {#each rows as row, i (row.term)}
        <div class="rounded border border-nc-line bg-nc-bg px-2 py-1.5">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-[11px] font-semibold text-nc-txt"
              >{row.term}</span
            >
            <button
              onclick={() => removeRow(i)}
              class="rounded px-1 text-[10px] text-nc-mut-2 hover:text-nc-red"
              title="Remove term"
            >
              ✕
            </button>
          </div>
          <input
            value={row.aliases.join(', ')}
            onchange={(e) => editAliases(i, e.currentTarget.value)}
            placeholder="heard as: alias 1, alias 2"
            class="mt-1 w-full rounded border border-nc-line-2 bg-nc-panel px-1.5 py-1 text-[10px] text-nc-mut outline-none focus:border-nc-brand/60"
            title={entryLabel(row)}
          />
        </div>
      {/each}
      {#if !rows.length}
        <p class="text-[10.5px] text-nc-mut-2">Koi term nahi. Neeche se add karo.</p>
      {/if}
    </div>

    <div class="mt-2 grid grid-cols-[1fr_1.4fr_auto] gap-1.5">
      <input
        bind:value={freshTerm}
        placeholder="Term (e.g. RAG)"
        class="rounded border border-nc-line bg-nc-bg px-1.5 py-1 text-[10.5px] outline-none focus:border-nc-brand/60"
      />
      <input
        bind:value={freshAliases}
        placeholder="heard as: retrive argument document general"
        class="rounded border border-nc-line bg-nc-bg px-1.5 py-1 text-[10.5px] outline-none focus:border-nc-brand/60"
      />
      <button
        onclick={addRow}
        disabled={!freshTerm.trim()}
        class="rounded border border-nc-line-2 px-2 py-1 text-[10px] font-semibold text-nc-mut hover:border-nc-brand hover:text-nc-brand disabled:opacity-40"
      >
        Add
      </button>
    </div>
    <p class="mt-1 text-[9px] text-nc-mut-2">
      Max {MAX_ALIASES_PER_TERM} spellings per term. Aliases are matched case-insensitively, whole words
      only.
    </p>

    <div class="mt-2 flex gap-2">
      <button
        onclick={save}
        disabled={saving}
        class="rounded bg-nc-brand px-2.5 py-1 text-[10.5px] font-bold text-nc-bg hover:brightness-110 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save vocabulary'}
      </button>
      <button
        onclick={reload}
        class="rounded border border-nc-line px-2.5 py-1 text-[10.5px] text-nc-mut hover:text-nc-txt"
      >
        Reload
      </button>
    </div>
  {/if}
</section>
