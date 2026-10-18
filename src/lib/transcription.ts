/**
 * End-to-end Chunk 2 orchestration: extract audio, submit to t9cloud, poll,
 * correct, analyse with Gemini, and persist the result to SQLite.
 *
 * Talks to the Go daemon over loopback HTTP. The daemon must be running; if it
 * is not, the caller gets a readable error rather than a crash.
 *
 * Stage order is not arbitrary: transcribe → autocorrect → analyse. The
 * analyser judges what was *said*, and phonetically broken text ("javas cript")
 * makes that judgement worse, so the spelling is fixed before Gemini sees it.
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

async function pollJob(
  id: string,
  onProgress?: (p: TranscribeProgress) => void,
  label = "working",
  timeoutMs = 10 * 60 * 1000,
): Promise<CloudJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJson<CloudJob>(`/v1/jobs/${id}`);
    if (job.state === "done" || job.state === "partial" || job.state === "failed") {
      if (job.state === "failed") throw new Error(job.error || "job failed");
      return job;
    }
    // Report live progress (completed/total) so the UI can show a real %.
    onProgress?.({ stage: label, completed: job.completed, total: job.total });
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
    // No prompt: a descriptive prompt biases Whisper to hallucinate its words
    // (e.g. "Apna College") into silent/unclear passages. An empty prompt keeps
    // the transcript faithful to the actual audio. The spelling is fixed after
    // the fact by the autocorrect pass, which is a far safer place to inject
    // domain vocabulary than the decoder itself.
    prompt: "",
  });
  const tDone = await pollJob(tJob.id, onProgress, "transcribing");
  const transcript = tDone.transcript ?? [];

  // Hinglish transcription is phonetically correct and orthographically
  // wrong: "javas cript", "funk shun", "phy ton". A text model maps those back
  // reliably where a second Whisper pass would not, so this is a real quality
  // step rather than a cosmetic one.
  //
  // Best-effort by design. The daemon keeps Whisper's spelling for any batch
  // that fails, so the worst case here is a transcript that looks exactly like
  // the one we had before — never a lost one.
  let segments: CloudSegment[] = transcript;
  if (transcript.length > 0) {
    try {
      onProgress?.({ stage: "correcting", completed: 0, total: 1 });
      const cJob = await postJson<CloudJob>("/v1/correct", {
        source_path: sourcePath,
        segments: transcript,
      });
      const cDone = await pollJob(cJob.id, onProgress, "correcting");
      segments = cDone.corrected ?? transcript;
    } catch (correctErr) {
      console.warn("autocorrect skipped, using raw transcript:", correctErr);
      segments = transcript;
    }
  }

  if (segments.length > 0) {
    // Tone analysis is a best-effort enhancement, not a requirement for
    // editing. If Gemini is unconfigured or its key is rejected (e.g. a 401),
    // we keep the raw transcript — every line defaults to keep=true / flag
    // "none" — so the user can still cut. Losing a whole transcript to a
    // failed analysis would be far worse than an unflagged one.
    try {
      onProgress?.({ stage: "analysing", completed: 0, total: segments.length });
      const aJob = await postJson<CloudJob>("/v1/analyze", {
        source_path: sourcePath,
        segments,
        tone_profile: "Informal Hinglish coding tutorial, Apna College / Coder Army style",
        creator_handle: "@EngrTarunDilwal",
      });
      const aDone = await pollJob(aJob.id, onProgress, "analysing");
      segments = aDone.analysis ?? aDone.transcript ?? segments;
    } catch (analysisErr) {
      // The corrected transcript survives a failed analysis untouched, so
      // there is nothing to restore here.
      console.warn("tone analysis skipped, keeping uncorrected flags:", analysisErr);
    }
  }

  const lines: TranscriptLine[] = segments.map((s) => ({
    id: s.id,
    startSecs: s.start_secs,
    endSecs: s.end_secs,
    text: s.text,
    keep: s.keep,
    flag: s.flag,
    originalText: s.original_text,
  }));

  onProgress?.({ stage: "saving" });
  const dbPath = await defaultDbPath();
  await saveTranscript(dbPath, sourcePath, lines);
  return lines;
}
