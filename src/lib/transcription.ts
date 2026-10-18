/**
 * End-to-end Chunk 2 orchestration: extract audio, submit to t9cloud, poll,
 * analyse with Gemini, and persist the result to SQLite.
 *
 * Talks to the Go daemon over loopback HTTP. The daemon must be running; if it
 * is not, the caller gets a readable error rather than a crash.
 */
import { defaultChunkDir, defaultDbPath, extractAudioChunks, saveTranscript } from "./ipc";
import type { CloudJob, CloudSegment, TranscriptLine } from "./types";

const DAEMON = (import.meta.env.VITE_T9CLOUD_ADDR as string | undefined) || "127.0.0.1:7878";
const BASE = `http://${DAEMON}`;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function pollJob(id: string, timeoutMs = 10 * 60 * 1000): Promise<CloudJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJson<CloudJob>(`/v1/jobs/${id}`);
    if (job.state === "done" || job.state === "partial" || job.state === "failed") {
      if (job.state === "failed") throw new Error(job.error || "job failed");
      return job;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("transcription timed out");
}

export interface TranscribeProgress {
  stage: string;
  completed?: number;
  total?: number;
}

export async function transcribeSource(
  sourcePath: string,
  onProgress?: (p: TranscribeProgress) => void,
): Promise<TranscriptLine[]> {
  onProgress?.({ stage: "extracting audio" });
  const chunkDir = await defaultChunkDir();
  const chunks = await extractAudioChunks(sourcePath, chunkDir);

  onProgress?.({ stage: "transcribing", completed: 0, total: chunks.length });
  const tJob = await postJson<CloudJob>("/v1/transcribe", {
    source_path: sourcePath,
    chunks: chunks.map((c) => ({
      path: c.path,
      offset_secs: c.offsetSecs,
      index: c.index,
    })),
    language: "",
    prompt: "Hinglish technical tutorial, Apna College / Coder Army style",
  });
  const tDone = await pollJob(tJob.id);
  const transcript = tDone.transcript ?? [];

  let segments: CloudSegment[] = transcript;
  if (transcript.length > 0) {
    onProgress?.({ stage: "analysing", completed: 0, total: transcript.length });
    const aJob = await postJson<CloudJob>("/v1/analyze", {
      source_path: sourcePath,
      segments: transcript,
      tone_profile: "Informal Hinglish coding tutorial, Apna College / Coder Army style",
      creator_handle: "@EngrTarunDilwal",
    });
    const aDone = await pollJob(aJob.id);
    segments = aDone.analysis ?? aDone.transcript ?? transcript;
  }

  const lines: TranscriptLine[] = segments.map((s) => ({
    id: s.id,
    startSecs: s.start_secs,
    endSecs: s.end_secs,
    text: s.text,
    keep: s.keep,
    flag: s.flag,
  }));

  onProgress?.({ stage: "saving" });
  const dbPath = await defaultDbPath();
  await saveTranscript(dbPath, sourcePath, lines);
  return lines;
}
