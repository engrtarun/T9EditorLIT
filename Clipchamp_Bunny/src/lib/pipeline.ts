import type { AudioChunk } from './types';
import type { LineFlag } from './types';

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
  error?: string;
  transcript?: CloudSegment[];
  corrected?: CloudSegment[];
  analysis?: CloudSegment[];
}

export type Progress = (message: string, fraction: number) => void;

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

/** Poll a job to a terminal state. */
async function waitJob(id: string, onProgress?: Progress): Promise<CloudJob> {
  for (let i = 0; i < 600; i++) {
    const j = await job(id);
    if (j.state === 'done' || j.state === 'failed' || j.state === 'partial') return j;
    if (onProgress && j.total) {
      onProgress(`${j.kind} ${j.completed ?? 0}/${j.total}`, (j.completed ?? 0) / j.total);
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error('job timed out');
}

/** Whisper transcription of the audio chunks the Rust side already split. */
export async function runTranscription(
  sourcePath: string,
  chunks: AudioChunk[],
  onProgress?: Progress
): Promise<CloudSegment[]> {
  const created = await post<CloudJob>('/v1/transcribe', {
    source_path: sourcePath,
    chunks: chunks.map((c) => ({
      path: c.path,
      offset_secs: c.offsetSecs,
      index: c.index
    })),
    // Hinglish tech vocabulary bias for Whisper.
    prompt: 'Aapne Hindi aur English mein baat ki, coding tutorial.'
  });
  const done = await waitJob(created.id, onProgress);
  if (!done.transcript?.length) {
    throw new Error(done.error || 'transcribe returned no segments');
  }
  return done.transcript;
}

/** Autocorrect: clean up Whisper's spelling before the analyser judges it. */
export async function runCorrection(
  sourcePath: string,
  segments: CloudSegment[]
): Promise<CloudSegment[]> {
  const created = await post<CloudJob>('/v1/correct', { source_path: sourcePath, segments });
  const done = await waitJob(created.id);
  return done.corrected?.length ? done.corrected : segments;
}

/** Gemini: flag retakes, fumbles and wrong examples. */
export async function runAnalysis(
  sourcePath: string,
  segments: CloudSegment[]
): Promise<CloudSegment[]> {
  const created = await post<CloudJob>('/v1/analyze', {
    source_path: sourcePath,
    segments,
    creator_handle: '@EngrTarunDilwal'
  });
  const done = await waitJob(created.id);
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

/** The daemon's flag vocabulary → ours. */
export function toLineFlag(flag: string): LineFlag {
  switch (flag) {
    case 'fumble':
      return 'fumble';
    case 'retake':
      return 'repeat';
    case 'wrong_example':
      return 'wrong-example';
    case 'silence':
      return 'silence';
    default:
      return 'none';
  }
}
