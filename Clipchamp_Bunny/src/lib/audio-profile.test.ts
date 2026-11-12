import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_SILENCE_THRESHOLD_DB,
  describeProfile,
  looksLikeMusic,
  silenceThresholdDb,
  voiceIsBuried,
  type AudioProfile
} from './audio-profile.ts';

function profile(over: Partial<AudioProfile> = {}): AudioProfile {
  return {
    duration_secs: 600,
    audible_secs: 300,
    speech_ratio: 0.5,
    noise_floor_db: -28,
    speech_db: -6,
    snr_db: 22,
    peak_db: -3,
    threshold_db: -16,
    margin_db: 9,
    sensitivity: 'balanced',
    silence_threshold_db: -16,
    chunks: 2,
    measured: 2,
    ...over
  };
}

// The whole point of the measurement: the threshold is the file's own, not a
// number somebody typed once.
test('the cut map uses the measured threshold', () => {
  assert.equal(silenceThresholdDb(profile({ silence_threshold_db: -16 })), -16);
});

// The daemon being down must not stop the editor from working.
test('without a profile the old fixed threshold is used', () => {
  assert.equal(silenceThresholdDb(null), LEGACY_SILENCE_THRESHOLD_DB);
  assert.equal(
    silenceThresholdDb(profile({ silence_threshold_db: NaN })),
    LEGACY_SILENCE_THRESHOLD_DB
  );
});

// The voice under a music bed is a different problem from a quiet recording.
test('a buried voice is called out, a quiet clean recording is not', () => {
  assert.equal(voiceIsBuried(profile({ snr_db: 5 })), true);
  assert.equal(voiceIsBuried(profile({ snr_db: 22 })), false);
});

// Music is loud, so loudness alone cannot tell it apart from speech.
test('a loud file with no separation looks like music', () => {
  assert.equal(looksLikeMusic(profile({ speech_ratio: 0.9, snr_db: 3 })), true);
  // A talking video that is loud and clear is not music.
  assert.equal(looksLikeMusic(profile({ speech_ratio: 0.9, snr_db: 25 })), false);
  // A quiet file is not music either.
  assert.equal(looksLikeMusic(profile({ speech_ratio: 0.1, snr_db: 3 })), false);
});

// The description has to carry the numbers a fixed threshold cannot produce.
test('the profile line names the floor, the voice and the separation', () => {
  const text = describeProfile(profile());
  assert.match(text, /floor -28 dB/);
  assert.match(text, /voice -6 dB/);
  assert.match(text, /SNR 22 dB/);
  assert.match(text, /50% audible/);
});
