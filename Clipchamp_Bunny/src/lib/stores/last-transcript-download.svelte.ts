/**
 * The transcript file the in-built browser just saved.
 *
 * ElevenLabs' export buttons build the file **inside the page** (a `blob:`
 * URL), so the daemon's multi-segment downloader cannot fetch it — WebView2
 * saves it itself and Rust reports where it landed. Remembering that path turns
 * "export from the site" into a one-click import: the transcript panel can
 * offer the newest file without asking the user to find it in Explorer.
 *
 * One slot on purpose. The newest download is the one the user is thinking
 * about; a list would need a UI nobody asked for.
 */

/** Extensions the transcript importer can actually read. */
const TRANSCRIPT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'srt',
  'vtt',
  'json',
  'html',
  'htm',
  'docx',
  'pdf'
]);

class LastTranscriptDownloadStore {
  /** Full path of the newest saved transcript, or `null`. */
  path = $state<string | null>(null);
  /** Its file name, for the button's label. */
  name = $state('');
  /** When it was saved (epoch ms) — the panel ignores stale entries. */
  at = $state(0);

  /**
   * Record a saved download. Returns the file name when it is a transcript
   * (so the caller can toast about it), or `null` when it is something else —
   * the browser also saves images and other blobs, and those are not imports.
   */
  note(path: string, url = ''): string | null {
    const name = (path.split(/[\\/]/).pop() ?? '').trim();
    const ext = (name || url.split(/[?#]/)[0]).split('.').pop()?.toLowerCase() ?? '';
    if (!TRANSCRIPT_EXTENSIONS.has(ext)) return null;
    this.path = path;
    this.name = name;
    this.at = Date.now();
    return name;
  }

  clear(): void {
    this.path = null;
    this.name = '';
    this.at = 0;
  }
}

export const lastTranscriptDownload = new LastTranscriptDownloadStore();
