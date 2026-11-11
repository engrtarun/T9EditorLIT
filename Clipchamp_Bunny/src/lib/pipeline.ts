import type { AudioChunk } from './types.ts';
import { logTranscriptionJob } from './ipc.ts';
import { JOB_CAP_MS, jobWatchdog } from './cloud-contract.ts';

// The flag vocabulary lives with the other pure contract rules, and is
// re-exported here because every caller already imports it from this module.
export { toLineFlag } from './cloud-contract.ts';

/**
 * The cloud pipeline: `t9cloud` on 127.0.0.1:7878.
 *
 *   transcribe (Groq Whisper Large v3) → correct (autocorrect) → analyze (Gemini flags)
 *
 * Each step is a job: POST returns a job, the result is polled from
 * `GET /v1/jobs/{id}`.
 *
 * **This runs once per imported source.** The result is written to SQLite by
 * the project store; from then on the transcript comes straight off the disk and
 * the API is never called again.
 */

const BASE = 'http://127.0.0.1:7878';

export interface CloudWord {
  word: string;
  start: number;
  end: number;
}

export interface CloudSegment {
  id: string;
  start_secs: number;
  end_secs: number;
  text: string;
  flag: string;
  keep: boolean;
  reason?: string;
  original_text?: string;
  /** Word-level timings — this is what makes a split cut the text too. */
  words?: CloudWord[];
}

export interface CloudJob {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'partial' | string;
  total?: number;
  completed?: number;
  /**
   * How many transcript lines exist **so far**.
   *
   * Deliberately not derived from `completed`: `completed` counts audio
   * chunks, and one 15-minute chunk yields forty lines. The old UI divided
   * lines by chunks and showed "400/24".
   */
  lines?: number;
  /** Tail of the newest line — proof the transcript is really filling up. */
  last_line?: string;
  /** Unix seconds; the daemon stamps it on every step. Drives stall detection. */
  updated_unix?: number;
  created_unix?: number;
  error?: string;
  /**
   * True when the source had **no speech at all**: Whisper ran, everything it
   * emitted was filtered as hallucination, and the honest answer is "no words
   * here". `transcript` comes back empty while the job still finished — this
   * is a result, not a failure.
   */
  no_speech?: boolean;
  transcript?: CloudSegment[];
  corrected?: CloudSegment[];
  analysis?: CloudSegment[];
  /**
   * Positions (in the request's `chunks` array) that could not be read.
   *
   * Present only on a `partial` transcribe job. The app retries exactly these
   * instead of re-transcribing the whole video — the words from the successful
   * chunks are already paid for and already on disk.
   */
  failed_chunks?: number[];
}

/**
 * One progress tick from a running job.
 *
 * `fraction` is the stage's own 0..1 (chunks finished / chunks total); the
 * caller maps it into its band of the whole pipeline, because only the caller
 * knows how many stages are left.
 */
export interface StageProgress {
  /** Ready to show: "Whisper 3/12". */
  message: string;
  fraction: number;
  /** Chunks/segments the stage has finished, when it counts in units. */
  completed?: number;
  total?: number;
  /** Transcript lines written so far (transcription stage). */
  lines?: number;
  /** Tail of the newest line, so the panel can show real words. */
  lastLine?: string;
}

export type Progress = (tick: StageProgress) => void;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status} ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

async function job(id: string): Promise<CloudJob> {
  const res = await fetch(`${BASE}/v1/jobs/${id}`);
  if (!res.ok) throw new Error(`job ${id} → ${res.status}`);
  return (await res.json()) as CloudJob;
}

/** How often a running job is asked for its state. */
const POLL_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Human name for the daemon's job kinds. */
const KIND_LABEL: Record<string, string> = {
  transcribe: 'Whisper',
  correct: 'Autocorrect',
  analyze: 'Gemini'
};

/** "Whisper 3/12" when the stage counts units, the bare name otherwise. */
function progressMessage(j: CloudJob): string {
  const label = KIND_LABEL[j.kind] ?? j.kind;
  return j.total ? `${label} ${j.completed ?? 0}/${j.total}` : label;
}

/**
 * Poll a job to a terminal state.
 *
 * Three outcomes matter and they are different: *done*, *failed* (the job says
 * so) and *stuck* (nothing moves). Only the middle one used to be reported;
 * the third looked identical to a very long job, so the panel sat on "26%"
 * forever.
 */
async function waitJob(id: string, onProgress?: Progress): Promise<CloudJob> {
  const started = Date.now();
  // Anything that moves is progress: the daemon's stamp, the chunk counter or
  // the line count. Using all three means an older daemon without
  // `updated_unix` is still recognised as alive instead of looking stuck.
  let lastSignature = '';
  let lastChange = started;
  let fetchErrors = 0;

  for (;;) {
    let j: CloudJob;
    try {
      j = await job(id);
      fetchErrors = 0;
    } catch (e) {
      // A single dropped poll is not a dead job — the daemon may be swapping
      // a connection. Five in a row is.
      if (++fetchErrors >= 5) throw e;
      await sleep(POLL_MS);
      continue;
    }

    if (j.state === 'done' || j.state === 'failed' || j.state === 'partial') return j;

    const signature = `${j.state}|${j.completed ?? -1}|${j.lines ?? -1}|${j.updated_unix ?? -1}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChange = Date.now();
    }
    const verdict = jobWatchdog(Date.now(), started, lastChange);
    if (verdict === 'stalled') {
      throw new Error(
        `${KIND_LABEL[j.kind] ?? j.kind} ${Math.round((Date.now() - lastChange) / 60_000)} min se ruka hua hai — daemon se koi update nahi aaya`
      );
    }
    if (verdict === 'expired') {
      throw new Error(`${KIND_LABEL[j.kind] ?? j.kind} 2 ghante me poora nahi hua`);
    }

    if (onProgress) {
      const total = j.total ?? 0;
      const completed = j.completed ?? 0;
      onProgress({
        message: progressMessage(j),
        fraction: total > 0 ? Math.min(1, completed / total) : 0,
        completed: total > 0 ? completed : undefined,
        total: total > 0 ? total : undefined,
        lines: j.lines,
        lastLine: j.last_line
      });
    }
    await sleep(POLL_MS);
  }
}

/**
 * Whisper transcription of the audio chunks the Rust side already split.
 *
 * `opts.language` / `opts.prompt` are **optional on purpose**. The old version
 * always sent one hardcoded Hinglish sentence ("Aapne Hindi aur English mein
 * baat ki, coding tutorial"), which biased every video — a Marathi lecture or
 * a silent screencast still came back as a Hinglish coding tutorial. The
 * daemon now detects the language once and carries the transcript's own tail
 * into each later chunk, so the client only speaks up when it really knows
 * better (for example a language the user picked in Settings).
 */
/**
 * Thrown when the source turned out to have no speech — a music track, a toon,
 * a silent screen recording.
 *
 * Not a failure: the panel shows it in its empty state, never in the red error
 * banner, and the telemetry records a finished job. Extends Error so callers
 * that already catch `Error` keep working unchanged.
 */
export class NoSpeechError extends Error {
  constructor() {
    super('Koi speech nahi mili — is audio me sirf music/ambience hai. Transcript nahi banaya.');
    this.name = 'NoSpeechError';
  }
}

/**
 * What a transcribed run actually produced.
 *
 * The old function returned a bare array, which made "complete" and "half the
 * video failed" the same value. A 49-minute import came back with five minutes
 * of text and nothing said so. `failedChunks` is what lets the panel be honest
 * and the retry be cheap.
 */
export interface TranscriptionResult {
  segments: CloudSegment[];
  /** Request positions whose chunk errored. Empty means the run is complete. */
  failedChunks: number[];
  /** The daemon's reason for the gap, when it reported one. */
  error?: string;
  /**
   * The daemon heard no words in the chunks it *could* read.
   *
   * Usually that is a final answer (music, ambience). When `failedChunks` is
   * non-empty it is not: the unread chunks might contain speech, so the caller
   * must offer a retry instead of declaring the video wordless.
   */
  noSpeech: boolean;
}

export async function runTranscription(
  sourcePath: string,
  chunks: AudioChunk[],
  onProgress?: Progress,
  opts: { language?: string; prompt?: string } = {}
): Promise<TranscriptionResult> {
  // Telemetry: one `transcription_jobs` row when the run settles — the
  // engine writes it fire-and-forget, nothing here waits on SQLite.
  const audioSecs = chunks.reduce((sum, c) => sum + (c.durationSecs || 0), 0);
  const t0 = Date.now();
  try {
    const created = await post<CloudJob>('/v1/transcribe', {
      source_path: sourcePath,
      chunks: chunks.map((c) => ({
        path: c.path,
        offset_secs: c.offsetSecs,
        index: c.index
      })),
      // Only sent when the caller actually knows something. An absent field is
      // "let Whisper detect it", which is the honest default.
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {})
    });
    const done = await waitJob(created.id, onProgress);
    // A music-only video reaches here `done` with an empty transcript: every
    // chunk was read and none held words. A generic error would send the user
    // into a retry loop that can never converge, so it gets its own class and
    // the panel its own message.
    if (done.no_speech) {
      logTranscriptionJob(
        sourcePath,
        'done',
        'groq',
        audioSecs,
        'no speech detected',
        (Date.now() - t0) / 1000
      );
      // Chunks that could not be read are a different story: the audio that
      // never reached Whisper may well contain the speech. Hand the gaps back
      // so the caller can retry them instead of saying "no words here".
      if (!done.failed_chunks?.length) throw new NoSpeechError();
      return {
        segments: [],
        failedChunks: done.failed_chunks,
        error: done.error,
        noSpeech: true
      };
    }
    // `partial` is a real result: some chunks failed, but the ones that
    // worked are paid-for words. Keeping them beats throwing them away.
    if (!done.transcript?.length) {
      throw new Error(done.error || 'transcribe returned no segments');
    }
    logTranscriptionJob(
      sourcePath,
      done.state === 'partial' ? 'partial' : 'done',
      'groq',
      audioSecs,
      done.error ?? '',
      (Date.now() - t0) / 1000
    );
    return {
      segments: done.transcript,
      failedChunks: done.failed_chunks ?? [],
      error: done.state === 'partial' ? done.error : undefined,
      noSpeech: false
    };
  } catch (e) {
    // NoSpeechError was already logged above as `done` — logging it again as
    // `failed` would make the telemetry blame the video that did nothing wrong.
    if (!(e instanceof NoSpeechError)) {
      logTranscriptionJob(
        sourcePath,
        'failed',
        'groq',
        audioSecs,
        String(e),
        (Date.now() - t0) / 1000
      );
    }
    throw e;
  }
}

/** Autocorrect: clean up Whisper's spelling before the analyser judges it. */
export async function runCorrection(
  sourcePath: string,
  segments: CloudSegment[],
  onProgress?: Progress
): Promise<CloudSegment[]> {
  const created = await post<CloudJob>('/v1/correct', { source_path: sourcePath, segments });
  const done = await waitJob(created.id, onProgress);
  return done.corrected?.length ? done.corrected : segments;
}

/** Gemini: flag retakes, fumbles and wrong examples, one batch at a time. */
export async function runAnalysis(
  sourcePath: string,
  segments: CloudSegment[],
  onProgress?: Progress
): Promise<CloudSegment[]> {
  const created = await post<CloudJob>('/v1/analyze', {
    source_path: sourcePath,
    segments,
    creator_handle: '@EngrTarunDilwal'
  });
  const done = await waitJob(created.id, onProgress);
  return done.analysis?.length ? done.analysis : segments;
}

/** Is the daemon up at all? */
export async function daemonHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}
