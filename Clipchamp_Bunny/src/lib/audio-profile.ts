import type { AudioChunk } from './types.ts';

/**
 * The local measurement of a source's audio.
 *
 * Mirrors the daemon's `model.AudioProfile` (snake_case over HTTP, exactly
 * like the other cloud contracts). Every number is measured on this machine
 * from the same 16 kHz mono chunks the transcription uses - nothing is
 * uploaded to find out how loud the room was.
 *
 * Why the app asks for it before the cut map: "silence" is relative. A fixed
 * -30 dB threshold finds no silence at all in a phone recording next to a
 * fan (room tone at -28 dB), and cuts a studio recording between every word
 * (room tone at -60 dB). One measurement, one threshold, and the editor and
 * the transcriber cannot disagree about the same silence.
 */
export interface AudioProfile {
  duration_secs: number;
  audible_secs: number;
  /** Share of the file that carries sound, 0..1. */
  speech_ratio: number;
  /** The measured room tone, in dBFS. */
  noise_floor_db: number;
  /** The measured speech level, in dBFS. */
  speech_db: number;
  /** speech_db - noise_floor_db. Under ~8 dB the voice is fighting the music bed. */
  snr_db: number;
  peak_db: number;
  /** The level a frame has to clear to count as sound. */
  threshold_db: number;
  /** How far above the noise floor that threshold sits. */
  margin_db: number;
  sensitivity: Sensitivity;
  /** What the cut map should use instead of a fixed -30 dB. */
  silence_threshold_db: number;
  chunks: number;
  /** How many chunks could actually be read. */
  measured: number;
}

/**
 * How eager the silence detector is to call a pause silence.
 *
 * `conservative` keeps quiet speech and cuts less dead air, `aggressive` cuts
 * more and is the one that can clip a whispered line. It is a margin above
 * the measured floor, not a fixed threshold, so the same choice works on a
 * studio recording and on a phone in a fan's breeze.
 */
export type Sensitivity = 'conservative' | 'balanced' | 'aggressive';

/** The threshold the app used before the measurement existed. */
export const LEGACY_SILENCE_THRESHOLD_DB = -30;

/** The sensitivity choices, in the order they are offered. */
export const SENSITIVITIES: Sensitivity[] = ['conservative', 'balanced', 'aggressive'];

/** A short label for the dial, for the UI. */
export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive'
};

/**
 * The threshold the cut map should use.
 *
 * Falls back to the old fixed -30 dB when there is no profile - the daemon
 * being down must not stop the editor from working.
 */
export function silenceThresholdDb(profile: AudioProfile | null): number {
  if (!profile || !Number.isFinite(profile.silence_threshold_db)) {
    return LEGACY_SILENCE_THRESHOLD_DB;
  }
  return profile.silence_threshold_db;
}

/**
 * One honest line about the recording's audio.
 *
 * The numbers that matter to the user are the ones a fixed threshold cannot
 * produce: how far the voice sits above the room tone, and how much of the
 * file is not dead air.
 */
export function describeProfile(profile: AudioProfile): string {
  const parts: string[] = [];
  parts.push(`floor ${profile.noise_floor_db.toFixed(0)} dB`);
  parts.push(`voice ${profile.speech_db.toFixed(0)} dB`);
  parts.push(`SNR ${profile.snr_db.toFixed(0)} dB`);
  parts.push(`${Math.round(profile.speech_ratio * 100)}% audible`);
  return parts.join(' · ');
}

/**
 * Is the voice fighting a music bed?
 *
 * Under about 8 dB of separation the speech is a whisper on top of a loud
 * background, and the transcript will be worse than the recording deserves.
 * The app says so instead of quietly returning a bad transcript.
 */
export function voiceIsBuried(profile: AudioProfile): boolean {
  return profile.snr_db < 8;
}

/**
 * Is this file a music bed rather than a talking person?
 *
 * The daemon decides this from the provider's own verdict, not from a level:
 * music is loud, so loudness alone cannot tell the two apart. This helper is
 * for the *hint* the UI can show before the transcript runs.
 */
export function looksLikeMusic(profile: AudioProfile): boolean {
  return profile.speech_ratio > 0.6 && profile.snr_db < 6;
}

/**
 * Ask the daemon to measure a source's audio.
 *
 * Returns null when the daemon is not reachable: the app then falls back to
 * the old fixed threshold, which is worse but never wrong in a way the user
 * cannot see.
 */
export async function fetchAudioProfile(
  chunks: AudioChunk[],
  sensitivity: Sensitivity = 'balanced'
): Promise<AudioProfile | null> {
  if (!chunks.length) return null;
  try {
    const res = await fetch('http://127.0.0.1:7878/v1/audio-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_path: '',
        sensitivity,
        chunks: chunks.map((c) => ({
          path: c.path,
          offset_secs: c.offsetSecs,
          index: c.index
        }))
      })
    });
    if (!res.ok) return null;
    return (await res.json()) as AudioProfile;
  } catch {
    return null;
  }
}
