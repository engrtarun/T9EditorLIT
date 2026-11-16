<script lang="ts">
  /**
   * Transcript import — the free path.
   *
   * The editor's own transcript is bought from ElevenLabs/Groq through the
   * daemon. A user who does not want to spend that budget can run the same
   * speech-to-text on elevenlabs.io, download the result and bring it here.
   * This sheet is where that file (or a plain paste) becomes the project's
   * transcript.
   *
   * It is deliberately a **tool sheet, not a landing page**: one work area,
   * two ways in, one primary action. Editors like Descript and Premiere keep
   * this flow to a text box and a button; the free path is a footnote, not a
   * sidebar, because the user already knows what they came to do.
   *
   * The one rule that shapes the copy: **a guess must look like a guess.** An
   * SRT/VTT/JSON keeps real timings; plain Text/PDF/DOCX has none, so its rows
   * are spread over the media by word count. The status line says which one
   * this import is, in one short sentence.
   */
  import { tick } from 'svelte';
  import { project } from '../../stores/project.svelte';
  import { app } from '../../stores/app.svelte';
  import { browser } from '../../stores/browser.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { lastTranscriptDownload } from '../../stores/last-transcript-download.svelte';
  import { fmtShort } from '../../utils';
  import {
    isTauri,
    pickTranscriptFile,
    readTranscriptFile,
    type ImportedTranscriptFile
  } from '../../ipc';
  import { MAX_IMPORT_CHARS, buildTranscriptLines, parseTranscript } from '../../transcript-import';
  import type { BuiltImport } from '../../transcript-import';

  let { onclose }: { onclose: () => void } = $props();

  const ELEVEN_URL = 'https://elevenlabs.io/app/speech-to-text';
  const AUDIO_EXTENSIONS = new Set(['docx', 'pdf']);

  /** The text that will be imported — typed, pasted, or read from a file. */
  let text = $state('');
  /** What the last file put in the box, so an edit can drop the file label. */
  let loadedText = $state('');
  /** File name of the last picked/read file (`''` for a paste). */
  let fileName = $state('');
  /** Its path on disk (`''` in browser mode or for a paste). */
  let filePath = $state('');
  /** The debounced parse: what the status line shows. */
  let preview = $state<BuiltImport | null>(null);
  /** Why the last read/paste failed — shown inside the work area. */
  let error = $state<string | null>(null);
  /** A file is being read (PDF can take a moment). */
  let reading = $state(false);
  /** The import is being written. */
  let saving = $state(false);
  /** Replacing an existing transcript is a deliberate tick, not a dialog. */
  let replaceOk = $state(false);
  /** File is the first stop; paste is one click away. */
  let tab = $state<'file' | 'paste'>('file');
  /** The drop zone is hot right now. */
  let over = $state(false);
  /** The ElevenLabs steps, collapsed until asked for. */
  let showHelp = $state(false);

  let pasteBox = $state<HTMLTextAreaElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);

  const hasLines = $derived(project.lines.length > 0);
  const tooLong = $derived(text.length > MAX_IMPORT_CHARS);
  const canImport = $derived(
    !!preview && preview.lines.length > 0 && !tooLong && !saving && (!hasLines || replaceOk)
  );

  /** "1 line" / "3 lines" — a count is never followed by the wrong noun. */
  function lineCount(n: number): string {
    return `${n} ${n === 1 ? 'line' : 'lines'}`;
  }

  function wordCount(n: number): string {
    return `${n.toLocaleString('en-IN')} ${n === 1 ? 'word' : 'words'}`;
  }

  function speakerCount(n: number): string {
    return `${n} ${n === 1 ? 'speaker' : 'speakers'}`;
  }

  /**
   * The import sheet owns the keyboard while it is open (App.svelte checks
   * `layout.importOpen`): typing here must never cut a line behind the overlay.
   */
  $effect(() => {
    layout.importOpen = true;
    return () => {
      layout.importOpen = false;
    };
  });

  $effect(() => {
    panel?.focus();
  });

  /**
   * Preview, debounced.
   *
   * A 50 000-character paste parses in a few milliseconds, but doing it on
   * every keystroke of a four-paste edit is wasted work; 180 ms is below the
   * threshold where the status line feels laggy.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const body = text;
    const name = fileName;
    if (timer) clearTimeout(timer);
    if (!body.trim()) {
      preview = null;
      return;
    }
    timer = setTimeout(() => runPreview(body, name), 180);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  /** Parse without touching the store — the preview and the import share this. */
  function build(body: string, name: string, prefix?: string): BuiltImport {
    const doc = parseTranscript(body, {
      durationSecs: project.durationSec,
      fileName: name
    });
    return buildTranscriptLines(doc, project.durationSec, prefix);
  }

  function runPreview(body: string, name: string) {
    if (body.length > MAX_IMPORT_CHARS) {
      preview = null;
      return;
    }
    try {
      const built = build(body, name, 'imp-preview');
      preview = built;
      error = built.lines.length
        ? null
        : 'Is text me koi transcript line nahi mili — format ya content check karo.';
    } catch (e) {
      preview = null;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** A file read by the native side, the browser input, or a drop. */
  function applyFile(file: ImportedTranscriptFile) {
    error = null;
    text = file.text;
    loadedText = file.text;
    fileName = file.name;
    filePath = file.path;
    replaceOk = false;
  }

  /** The text changed by hand: the file's name no longer describes it. */
  function onTextInput() {
    if (loadedText && text !== loadedText) {
      loadedText = '';
      fileName = '';
      filePath = '';
    }
  }

  async function chooseFile() {
    error = null;
    reading = true;
    try {
      const file = await pickTranscriptFile();
      if (file) applyFile(file);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      reading = false;
    }
  }

  /** The transcript the in-built browser just saved (ElevenLabs' export). */
  async function useLastDownload() {
    const path = lastTranscriptDownload.path;
    if (!path) return;
    error = null;
    reading = true;
    try {
      applyFile(await readTranscriptFile(path));
      toast.push('info', `${lastTranscriptDownload.name} padh liya`, 2200);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      reading = false;
    }
  }

  /** Clipboard button. Ctrl+V works too — this is the one-click version. */
  async function pasteClipboard() {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        error = 'Clipboard khali hai — pehle transcript copy karo.';
        return;
      }
      text = clip;
      loadedText = '';
      fileName = '';
      filePath = '';
      replaceOk = false;
      error = null;
      toast.push('info', 'Clipboard paste ho gaya', 1600);
    } catch {
      error = 'Clipboard padhi nahi ja saki — box me click karke Ctrl+V dabao.';
    }
  }

  /**
   * Browser-mode drop. On the desktop the OS drop belongs to the media
   * importer (Tauri hands it real paths), so this sheet offers the picker
   * there instead of pretending to accept a drag it will not get.
   */
  function onDragOver(e: DragEvent) {
    if (isTauri()) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    over = true;
  }

  async function onDrop(e: DragEvent) {
    if (isTauri()) return;
    e.preventDefault();
    over = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (AUDIO_EXTENSIONS.has(ext)) {
      error = `${ext.toUpperCase()} file padhne ke liye desktop app chahiye. Abhi Text, SRT, VTT, JSON ya HTML use karo.`;
      return;
    }
    error = null;
    reading = true;
    try {
      applyFile({
        name: file.name,
        kind: 'text',
        text: await file.text(),
        bytes: file.size,
        path: ''
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      reading = false;
    }
  }

  async function openPaste() {
    tab = 'paste';
    await tick();
    pasteBox?.focus();
  }

  function openEleven() {
    onclose();
    app.openBrowser(app.view);
    browser.navigate(ELEVEN_URL);
  }

  async function doImport() {
    if (!canImport) return;
    saving = true;
    error = null;
    try {
      // Re-parse from the box, not from the debounced copy: the last keystroke
      // may still be waiting for its timer, and the user must get what they see.
      const built = build(text, fileName);
      if (!built.lines.length) {
        error = 'Is text me koi transcript line nahi mili.';
        return;
      }
      const count = await project.importTranscript(built, {
        name: fileName || 'Paste',
        path: filePath
      });
      if (!count) {
        error = 'Import nahi hua — text dobara check karo.';
        return;
      }
      toast.push(
        'keep',
        count === 1 ? '1 line import ho gayi' : `${count} lines import ho gayin`,
        2800
      );
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="fixed inset-0 z-[360] grid place-items-center bg-black/65 p-4"
  role="dialog"
  aria-modal="true"
  aria-labelledby="import-title"
>
  <!-- click-away catcher -->
  <button class="absolute inset-0 cursor-default" aria-label="Close" onclick={onclose}></button>

  <div
    bind:this={panel}
    tabindex="-1"
    class="t9-fade-in relative flex max-h-full w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-nc-line-2 bg-nc-panel shadow-2xl outline-none"
  >
    <!-- header -->
    <div class="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
      <div class="min-w-0 flex-1">
        <h2 id="import-title" class="text-[14px] font-semibold text-nc-txt">
          Transcript import karo
        </h2>
        <p class="mt-0.5 text-[11px] leading-snug text-nc-mut">
          ElevenLabs ya kisi bhi tool ka transcript — API key ke bina.
        </p>
      </div>
      <button
        onclick={onclose}
        aria-label="Band karo"
        class="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      </button>
    </div>

    <!-- tabs: an underline row, the way an editor's inspector switches panes -->
    <div
      class="flex shrink-0 gap-5 border-b border-nc-line px-5"
      role="tablist"
      aria-label="Transcript source"
    >
      <button
        role="tab"
        aria-selected={tab === 'file'}
        onclick={() => (tab = 'file')}
        class="relative -mb-px py-2 text-[11.5px] font-medium transition-colors
               {tab === 'file' ? 'text-nc-txt' : 'text-nc-mut hover:text-nc-txt'}"
      >
        File
        {#if tab === 'file'}
          <span class="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-nc-brand"></span>
        {/if}
      </button>
      <button
        role="tab"
        aria-selected={tab === 'paste'}
        onclick={() => void openPaste()}
        class="relative -mb-px py-2 text-[11.5px] font-medium transition-colors
               {tab === 'paste' ? 'text-nc-txt' : 'text-nc-mut hover:text-nc-txt'}"
      >
        Paste
        {#if tab === 'paste'}
          <span class="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-nc-brand"></span>
        {/if}
      </button>
    </div>

    <!-- work area: fixed height so switching tabs never jumps the footer -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {#if tab === 'file'}
        {#if fileName || filePath}
          <!-- one file, one row: the editor pattern for "the file is loaded" -->
          <div
            class="flex h-[212px] flex-col items-center justify-center rounded-xl border border-nc-line-2 bg-nc-bg/30 px-5 text-center"
          >
            <span class="grid h-10 w-10 place-items-center rounded-lg bg-nc-brand/15 text-nc-brand">
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" /><path d="M8 13h8M8 17h5" />
              </svg>
            </span>
            <p
              class="mt-3 max-w-full truncate text-[12px] font-medium text-nc-txt"
              title={fileName || filePath}
            >
              {fileName || filePath}
            </p>
            <p class="mt-1 text-[10.5px] text-nc-mut">
              {#if preview}
                {preview.label} · {lineCount(preview.lines.length)}
              {:else}
                Padh liya
              {/if}
            </p>
            <button
              onclick={() => void chooseFile()}
              disabled={reading}
              class="mt-3 rounded-md border border-nc-line-2 px-2.5 py-1 text-[10.5px] font-medium text-nc-mut transition-colors hover:border-nc-brand hover:text-nc-brand disabled:opacity-50"
            >
              {reading ? 'Padh rahe hain…' : 'Doosri file chuno'}
            </button>
          </div>
        {:else}
          <!--
            Drop / browse. The zone is the whole input: one target, one label.
            On desktop it is a picker with a drop-looking frame, because the OS
            drag belongs to the media importer (see onDragOver).
          -->
          <div
            role="button"
            tabindex="0"
            aria-label="Transcript file chuno"
            onclick={() => void chooseFile()}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void chooseFile();
              }
            }}
            ondragover={onDragOver}
            ondragleave={() => (over = false)}
            ondrop={(e) => void onDrop(e)}
            class="flex h-[212px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition-colors
                   {over
              ? 'border-nc-brand bg-nc-brand/10'
              : 'border-nc-line-2 bg-nc-bg/30 hover:border-nc-brand/60 hover:bg-nc-brand/5'}"
          >
            <span class="grid h-10 w-10 place-items-center rounded-full bg-nc-panel-2 text-nc-mut">
              {#if reading}
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="animate-spin"
                >
                  <path d="M21 12a9 9 0 1 1-6.2-8.56" stroke-linecap="round" />
                </svg>
              {:else}
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
                </svg>
              {/if}
            </span>
            <p class="mt-3 text-[12px] font-medium text-nc-txt">
              {reading ? 'File padh rahe hain…' : 'Transcript file yahan chuno'}
            </p>
            <p class="mt-1 text-[10.5px] leading-snug text-nc-mut">
              SRT · VTT · JSON · HTML · TXT · DOCX · PDF
            </p>
            <span
              class="mt-3 rounded-md border border-nc-line-2 bg-nc-panel px-3 py-1.5 text-[11px] font-medium text-nc-txt"
            >
              File chuno
            </span>
          </div>
        {/if}

        {#if lastTranscriptDownload.path}
          <button
            onclick={() => void useLastDownload()}
            disabled={reading}
            title={lastTranscriptDownload.path}
            class="mt-2 flex w-full items-center gap-2 rounded-lg border border-nc-green/30 bg-nc-green/5 px-2.5 py-1.5 text-left transition-colors hover:bg-nc-green/10 disabled:opacity-50"
          >
            <span class="shrink-0 text-[10px] font-semibold text-nc-green">Browser</span>
            <span class="min-w-0 flex-1 truncate text-[10.5px] text-nc-mut">
              {lastTranscriptDownload.name || 'Abhi download hui transcript'}
            </span>
            <span class="shrink-0 text-[10px] font-medium text-nc-green">Use karo</span>
          </button>
        {/if}
      {:else}
        <div>
          <textarea
            bind:this={pasteBox}
            bind:value={text}
            oninput={onTextInput}
            spellcheck="false"
            aria-label="Transcript text"
            placeholder={'Yahan paste karo — SRT, VTT, JSON, HTML ya plain text.\\n\\n00:00:01,000 --> 00:00:03,500\\nNamaste doston, aaj hum…'}
            class="h-[186px] w-full resize-none rounded-xl border border-nc-line-2 bg-nc-bg/40 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-nc-txt outline-none transition-colors placeholder:text-nc-mut-2/70 focus:border-nc-brand/70"
          ></textarea>
          <!-- Actions live below the box, never on top of the words being checked. -->
          <div class="mt-1.5 flex items-center gap-2">
            <button
              onclick={() => void pasteClipboard()}
              class="rounded-md border border-nc-line-2 px-2 py-1 text-[10px] font-medium text-nc-mut transition-colors hover:border-nc-brand hover:text-nc-brand"
            >
              Clipboard se paste
            </button>
            <span class="flex-1"></span>
            <span class="font-mono text-[9.5px] {tooLong ? 'text-nc-red' : 'text-nc-mut-2'}">
              {text.length.toLocaleString('en-IN')} chars
            </span>
          </div>
        </div>
      {/if}

      {#if tooLong}
        <p class="mt-2 text-[10.5px] leading-snug text-nc-red">
          Itna bada text ek saath import nahi hota (limit {MAX_IMPORT_CHARS.toLocaleString('en-IN')} chars).
          Video ko hisson me export karke alag-alag import karo.
        </p>
      {/if}

      {#if error}
        <p class="mt-2 text-[10.5px] leading-snug text-nc-red">{error}</p>
      {/if}

      <!-- status line: what was parsed, and whether the times are real -->
      {#if preview && preview.lines.length > 0}
        <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] leading-tight">
          <span class="font-medium text-nc-txt">{preview.label}</span>
          <span class="text-nc-mut-2">·</span>
          <span class="text-nc-mut">{lineCount(preview.lines.length)}</span>
          <span class="text-nc-mut-2">·</span>
          <span class="text-nc-mut">{wordCount(preview.words)}</span>
          {#if preview.speakers > 1}
            <span class="text-nc-mut-2">·</span>
            <span class="text-nc-mut">{speakerCount(preview.speakers)}</span>
          {/if}
          <span class="flex-1"></span>
          {#if preview.estimated}
            <span class="flex items-center gap-1 text-amber-300">
              <span class="h-1.5 w-1.5 rounded-full bg-amber-300"></span>
              estimated timings
            </span>
          {:else}
            <span class="flex items-center gap-1 text-nc-green">
              <span class="h-1.5 w-1.5 rounded-full bg-nc-green"></span>
              exact timings
            </span>
          {/if}
        </div>
        {#if preview.estimated}
          <p class="mt-1 text-[10px] leading-snug text-amber-300/85">
            File me timestamps nahi the — har line ka time words ke hisaab se baanta gaya hai. Exact
            cuts ke liye SRT, VTT ya JSON export karo.
          </p>
        {/if}
        {#if preview.dropped > 0}
          <p class="mt-1 text-[10px] leading-snug text-nc-mut">
            {#if preview.dropped === 1}
              1 line video ke end ke baad ki thi — chhod di gayi.
            {:else}
              {preview.dropped} lines video ke end ke baad ki thin — chhod di gayin.
            {/if}
          </p>
        {/if}
        {#if preview.timed && project.durationSec > 0 && preview.coveredSec > 0 && preview.coveredSec < project.durationSec - 2}
          <p class="mt-1 text-[10px] leading-snug text-amber-300/85">
            Transcript sirf {fmtShort(preview.coveredSec)} tak hai, video {fmtShort(
              project.durationSec
            )} ki hai — aage ki lines nahi milengi.
          </p>
        {/if}
      {/if}

      <!-- the free path, kept to one quiet line until it is asked for -->
      <div class="mt-3 border-t border-nc-line/70 pt-2.5">
        <div class="flex items-center gap-2 text-[10.5px]">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-nc-mut-2"
          >
            <circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" stroke-linecap="round" />
          </svg>
          <span class="min-w-0 text-nc-mut">Transcript nahi hai?</span>
          <button
            onclick={openEleven}
            class="shrink-0 font-medium text-nc-brand transition-colors hover:underline"
          >
            ElevenLabs se free banao ↗
          </button>
          <span class="flex-1"></span>
          <button
            onclick={() => (showHelp = !showHelp)}
            aria-expanded={showHelp}
            class="shrink-0 text-[10px] text-nc-mut-2 transition-colors hover:text-nc-mut"
          >
            {showHelp ? 'chhupao' : 'kaise?'}
          </button>
        </div>

        {#if showHelp}
          <ol class="mt-2 space-y-1 pl-[19px] text-[10px] leading-snug text-nc-mut">
            <li>1. ElevenLabs par audio upload karo — ya mic se record karo.</li>
            <li>2. Transcribe dabao; language auto-detect rehne do.</li>
            <li>
              3. Download menu se SRT, JSON ya Text chuno. Wapas yahan aao — file ka button khud
              dikhega.
            </li>
          </ol>
          <p class="mt-1.5 pl-[19px] text-[9.5px] leading-snug text-nc-mut-2">
            Is app ke browser me elevenlabs.io ko mic permission milti hai, isliye wahin record
            karna sabse aasaan hai.
          </p>
        {/if}
      </div>
    </div>

    <!-- footer: one deliberate tick, one primary action -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-nc-line px-5 py-3">
      {#if hasLines}
        <label class="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-nc-mut">
          <input type="checkbox" bind:checked={replaceOk} class="peer sr-only" />
          <span
            class="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors
                   peer-focus-visible:ring-2 peer-focus-visible:ring-nc-brand/50
                   {replaceOk ? 'border-nc-brand bg-nc-brand' : 'border-nc-line-2 bg-nc-bg/50'}"
          >
            {#if replaceOk}
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-white"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            {/if}
          </span>
          Purani {lineCount(project.lines.length)} replace karo
        </label>
      {:else}
        <span class="text-[10px] text-nc-mut-2">Panel me turant lag jayega.</span>
      {/if}

      <div class="ml-auto flex items-center gap-2">
        <button
          onclick={onclose}
          class="rounded-md px-3 py-1.5 text-[11.5px] font-medium text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          Cancel
        </button>
        <button
          onclick={() => void doImport()}
          disabled={!canImport}
          class="rounded-md bg-nc-brand px-3.5 py-1.5 text-[11.5px] font-semibold text-white transition-[filter] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {#if saving}
            Import ho raha hai…
          {:else if preview && preview.lines.length}
            Import karo · {preview.lines.length}
          {:else}
            Import karo
          {/if}
        </button>
      </div>
    </div>
  </div>
</div>
