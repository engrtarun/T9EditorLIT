import type { LineFlag } from './types';

/**
 * The small, pure half of the daemon contract: what a job's state means and
 * what its flag vocabulary is called here.
 *
 * Kept apart from `pipeline.ts` on purpose — that file talks to the network
 * and imports the IPC layer, so a unit test could not load it. These rules are
 * the ones that actually broke (a nine-minute "timeout" for a healthy job, a
 * flag the editor did not know), so they are the ones worth testing.
 */

/** How long a job may go without the daemon touching it before it is stuck. */
export const STALL_MS = 5 * 60_000;
/** Absolute ceiling for one stage — a four-hour source still has to finish. */
export const JOB_CAP_MS = 2 * 60 * 60_000;

/**
 * Has the job stopped making sense to wait for?
 *
 * Two failure modes, kept apart from "slow": the daemon stopped touching the
 * job (stalled), or it has been running longer than any real job (expired).
 * A job that keeps updating is never either, however long it takes — the old
 * `waitJob` counted to 600 and called that a timeout, which killed long videos
 * that were working fine.
 */
export function jobWatchdog(
  now: number,
  started: number,
  lastChange: number
): 'stalled' | 'expired' | null {
  if (now - lastChange > STALL_MS) return 'stalled';
  if (now - started > JOB_CAP_MS) return 'expired';
  return null;
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

/**
 * The chunk subdirectory name for one source, as **we** compute it.
 *
 * Chunks used to pile up in one shared temp folder: every video mixed into
 * `chunk_000.wav` collisions and the files were never deleted. Now each source
 * gets its own subdirectory named after a hash of its path, and the same value
 * is handed to `extract_audio_chunks` (to create it) and `clean_chunk_dir` (to
 * wipe it after Whisper is done) — both sides must agree on the name, so it is
 * pinned here as pure code instead of being an accident of two implementations.
 *
 * FNV-1a 32-bit: a handful of lines in TS and JS-safe integer maths, and the
 * hex form only ever contains `[0-9a-f]`, which the Rust-side sanitizer lets
 * through untouched.
 */
export function chunkSourceKey(sourcePath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sourcePath.length; i++) {
    h ^= sourcePath.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
