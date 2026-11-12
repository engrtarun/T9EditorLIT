package vad

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// testRate is the sample rate the Rust side extracts chunks at (mono, 16 kHz).
const testRate = 16000

// writeWAV builds a mono 16-bit PCM WAV — byte-for-byte the format the Rust
// side hands the daemon as `chunk_000.wav`.
func writeWAV(t *testing.T, samples []int16) string {
	t.Helper()

	dataSize := len(samples) * 2
	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:], 16)
	binary.LittleEndian.PutUint16(buf[20:], 1) // PCM
	binary.LittleEndian.PutUint16(buf[22:], 1) // mono
	binary.LittleEndian.PutUint32(buf[24:], testRate)
	binary.LittleEndian.PutUint32(buf[28:], testRate*2)
	binary.LittleEndian.PutUint16(buf[32:], 2)
	binary.LittleEndian.PutUint16(buf[34:], 16)
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:], uint32(dataSize))
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[44+i*2:], uint16(s))
	}

	path := filepath.Join(t.TempDir(), "chunk.wav")
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// duckMeme reproduces the file behind the bug report: "Duck Meme Hd
// Template.mp4" is 1.16 s long and its audio is digital silence except for a
// single 190 ms quack between 0.751 s and 0.943 s (measured with
// silencedetect: mean -25.2 dB, max -7.1 dB, everything else -inf).
func duckMeme(t *testing.T) string {
	t.Helper()

	const n = 18576 // 1.161 s at 16 kHz
	samples := make([]int16, n)
	for i := 12000; i < 15000; i++ {
		samples[i] = 8000
	}
	return writeWAV(t, samples)
}

// The bug: this clip was uploaded to Whisper, which confidently invented a
// line reading "What?" for a duck quack. The device can see there is barely
// any sound here at all, so the call must never happen.
func TestDuckMemeChunkIsNotWorthAnAPICall(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if d := s.DurationSecs(); d < 1.1 || d > 1.2 {
		t.Errorf("duration = %.3f s, want ~1.16 s", d)
	}
	if a := s.AudibleSecs(); a < 0.15 || a > 0.30 {
		t.Errorf("audible = %.3f s, want ~0.2 s (silence plus one quack)", a)
	}
	if s.WorthTranscribing() {
		t.Error("a 1.16 s meme with 0.2 s of sound must not be worth an API call")
	}
}

func TestChunkFullOfSoundIsWorthAnAPICall(t *testing.T) {
	samples := make([]int16, 2*testRate)
	for i := range samples {
		samples[i] = 5000
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !s.WorthTranscribing() {
		t.Errorf("audible %.2f s of %.2f s must be worth transcribing",
			s.AudibleSecs(), s.DurationSecs())
	}
}

func TestPureDigitalSilenceHasNoAudibleSeconds(t *testing.T) {
	s, err := Scan(writeWAV(t, make([]int16, 2*testRate)))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if a := s.AudibleSecs(); a != 0 {
		t.Errorf("audible = %.3f s, want 0 for digital silence", a)
	}
	if s.WorthTranscribing() {
		t.Error("silence must never be worth an API call")
	}
}

// A quiet recording must not be mistaken for silence: the scan also honours a
// peak-relative threshold, so a lecture recorded at -50 dBFS still counts.
func TestQuietRecordingIsNotSkippedAsSilence(t *testing.T) {
	samples := make([]int16, 3*testRate)
	for i := range samples {
		samples[i] = 150 // ≈ -47 dBFS peak — quiet, but real
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !s.WorthTranscribing() {
		t.Errorf("a quiet 3 s recording (audible %.2f s) must not be skipped as silence",
			s.AudibleSecs())
	}
}

// The hallucination guard: Whisper claimed "What?" spans 0 → 0.9 s, but the
// audio there is silent until 0.751 s. A word that sits where there is no
// sound did not happen.
func TestPhantomWordOverSilenceIsNotBackedByAudio(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if s.BacksSegment(0.0, 0.9) {
		t.Error("0→0.9 s contains 0.16 s of sound — that cannot back a word")
	}
}

func TestWordOverRealAudioIsBackedByAudio(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	// 0.75→0.94 s is exactly where the quack is: short, but fully real.
	if !s.BacksSegment(0.75, 0.94) {
		t.Error("the span holding the actual sound must be backed by audio")
	}
}

func TestAudibleWindowCountsOnlyFramesInsideIt(t *testing.T) {
	// Loud for 2 s, silent for 2 s.
	samples := make([]int16, 4*testRate)
	for i := 0; i < 2*testRate; i++ {
		samples[i] = 8000
	}
	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if got := s.AudibleIn(0, 2); got < 1.95 || got > 2.0 {
		t.Errorf("audible in loud half = %.2f s, want ~2.0", got)
	}
	if got := s.AudibleIn(2, 4); got != 0 {
		t.Errorf("audible in silent half = %.2f s, want 0", got)
	}
}

// The bug behind the missing middle of a 49-minute import: a 5-minute chunk
// carried 51.8 s of speech (17.3%) and the old fraction-only rule skipped the
// whole chunk as "no audible speech". Fifty-two seconds is not silence.
func TestSparseSpeechInLongChunkIsWorthTranscribing(t *testing.T) {
	const totalSecs = 300
	samples := make([]int16, totalSecs*testRate)
	// One spoken second every five, 60 bursts => ~60 s audible, 20%... but the
	// real file measured 17%, so use 52 bursts to sit under the old bar.
	for burst := 0; burst < 52; burst++ {
		from := burst * 5 * testRate
		for i := from; i < from+testRate; i++ {
			samples[i] = 6000
		}
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if frac := s.AudibleSecs() / s.DurationSecs(); frac >= minAudibleFraction {
		t.Fatalf("test setup: audible fraction %.3f should be under %.2f", frac, minAudibleFraction)
	}
	if !s.WorthTranscribing() {
		t.Errorf("%.1f s of speech in a %.0f s chunk must be worth transcribing",
			s.AudibleSecs(), s.DurationSecs())
	}
}

// A mostly-silent long chunk is still not worth a call: 2 s of sound in 5
// minutes is a door slam, not a sentence.
func TestLongChunkWithAlmostNoSoundIsStillSkipped(t *testing.T) {
	samples := make([]int16, 300*testRate)
	for i := 10 * testRate; i < 12*testRate; i++ {
		samples[i] = 6000
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if s.WorthTranscribing() {
		t.Errorf("%.1f s of sound in 300 s must not be sent to the API", s.AudibleSecs())
	}
}

// The other half of the same bug: Whisper stretched a real line from 0 s to
// 14.02 s while the words were spoken at the end, so only ~2 s of the span was
// audible (14%) and the gate dropped it. `dropping word with no audio behind
// it` on a line that clearly had audio is how transcript rows disappeared.
func TestLongLineWithTrailingPauseIsBackedByAudio(t *testing.T) {
	samples := make([]int16, 20*testRate)
	// Speech only in the last two seconds of a line Whisper claims starts at 0.
	for i := 16 * testRate; i < 18*testRate; i++ {
		samples[i] = 8000
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if frac := s.AudibleIn(0, 18.5) / 18.5; frac >= segmentAudibleFraction {
		t.Fatalf("test setup: %.3f of the span is audible, want under %.2f",
			frac, segmentAudibleFraction)
	}
	if !s.BacksSegment(0, 18.5) {
		t.Error("a 2 s real sentence inside an 18.5 s span must survive the gate")
	}
	silent := make([]int16, 20*testRate)
	silentScan, err := Scan(writeWAV(t, silent))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if silentScan.BacksSegment(0, 18.5) {
		t.Error("a long span over digital silence must still be dropped")
	}
}

// Fail open: anything this scanner cannot read is handed to the provider
// unchanged. A local scan must never be the reason a transcript is missing.
func TestUnreadableFileIsAnErrorNotASkip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-wav.m4a")
	if err := os.WriteFile(path, []byte("fake audio"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Scan(path); err == nil {
		t.Error("scanning a non-WAV file must return an error so callers fail open")
	}
}

// ── Adaptive threshold (edge cases 18, 19, 20) ────────────────────────────

// ampForDB is the sample value that reads as dB dBFS.
//
// The scan measures the *mean absolute* amplitude of a frame, so a constant
// sample of this value produces exactly this level in every frame — which is
// what makes a level-controlled test possible at all.
func ampForDB(db float64) int16 {
	return int16(32767 * math.Pow(10, db/20))
}

// roomToneWithSpeech builds a recording with a constant room tone and one
// loud stretch of speech on top of it.
func roomToneWithSpeech(t *testing.T, secs int, toneDB, speechDB float64, speechFrom, speechTo float64) string {
	t.Helper()

	samples := make([]int16, secs*testRate)
	tone := ampForDB(toneDB)
	speech := ampForDB(speechDB)
	for i := range samples {
		samples[i] = tone
	}
	from := int(speechFrom * testRate)
	to := int(speechTo * testRate)
	for i := from; i < to && i < len(samples); i++ {
		samples[i] = speech
	}
	return writeWAV(t, samples)
}

// Case 19, first half: a phone recording next to a fan. The room tone sits
// at -28 dBFS, which is *above* the old fixed -30 dB threshold, so a fixed
// threshold found no silence anywhere in the file and nothing was ever cut.
//
// The adaptive threshold measures the floor of this recording and puts the
// bar above it, so the dead air between the sentences is found.
func TestAdaptiveThresholdFindsSilenceUnderRoomTone(t *testing.T) {
	// 10 s of fan noise with 3 s of speech in the middle.
	path := roomToneWithSpeech(t, 10, -28, -6, 3.5, 6.5)

	s, err := Scan(path)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if floor := s.NoiseFloorDB(); floor < -31 || floor > -25 {
		t.Errorf("noise floor = %.1f dBFS, want about -28", floor)
	}
	if thr := s.ThresholdDB(); thr <= -28 {
		t.Errorf("threshold = %.1f dBFS, want above the -28 dBFS room tone", thr)
	}
	// The dead air is now silence: roughly 7 s of the 10 s file.
	ratio := s.SpeechRatio()
	if ratio > 0.45 || ratio < 0.25 {
		t.Errorf("speech ratio = %.2f, want ~0.3 (3 s of speech in 10 s)", ratio)
	}
	if !s.WorthTranscribing() {
		t.Error("3 s of speech must still be worth an API call")
	}
}

// Case 19, second half: a studio recording. The room tone is at -60 dBFS and
// the speech is quiet (-18 dBFS). A fixed -30 dB threshold called the quiet
// speech silence, and the video got chopped between every word.
//
// The adaptive threshold sits between the two measured levels, so the quiet
// speech survives and the dead air around it does not.
func TestAdaptiveThresholdKeepsQuietSpeechInAStudio(t *testing.T) {
	path := roomToneWithSpeech(t, 10, -60, -18, 3.5, 6.5)

	s, err := Scan(path)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if floor := s.NoiseFloorDB(); floor > -55 {
		t.Errorf("noise floor = %.1f dBFS, want about -60", floor)
	}
	if thr := s.ThresholdDB(); thr > -20 {
		t.Errorf("threshold = %.1f dBFS, want below the -18 dBFS speech", thr)
	}
	if !s.BacksSegment(3.5, 6.5) {
		t.Error("quiet studio speech must be backed by audio")
	}
	// The 3.5 s of dead air before the sentence is silence.
	if got := s.AudibleIn(0, 3.5); got > 0.05 {
		t.Errorf("audible in the leading silence = %.2f s, want ~0", got)
	}
}

// Case 20: a whispered recording. The whisper sits barely above the room
// tone, and both are below the absolute floor (-56 dBFS), so the old rule
// called the whole file silence and the clip was skipped.
//
// A whisper is real speech: it has to be measured, not guessed. The
// conservative sensitivity plus a lowered absolute floor is what the ASMR
// mode does.
func TestWhisperedSpeechSurvivesWithTheASMRFloor(t *testing.T) {
	// Room tone at -65 dBFS, whisper at -58 dBFS: both under the default
	// absolute floor of -56.
	path := roomToneWithSpeech(t, 10, -65, -58, 2.0, 8.0)

	// The default floor is above the whisper, so the default scan misses it.
	def, err := Scan(path)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if def.BacksSegment(2.0, 8.0) {
		t.Errorf("the default absolute floor (%.1f dBFS) must not be able to see a -58 dBFS whisper",
			def.ThresholdDB())
	}

	// ASMR mode: conservative margin, absolute floor lowered to -70 dBFS.
	floor := -70.0
	asmr, err := ScanWith(path, Options{
		Sensitivity:      SensitivityConservative,
		AbsFloorOverride: &floor,
	})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !asmr.BacksSegment(2.0, 8.0) {
		t.Errorf("a whisper must survive the ASMR mode (threshold %.1f dBFS)",
			asmr.ThresholdDB())
	}
}

// The sensitivity slider has to move the threshold, and it has to move it in
// the direction the names promise: conservative keeps more, aggressive cuts
// more.
func TestSensitivityMovesTheThresholdInTheRightOrder(t *testing.T) {
	path := roomToneWithSpeech(t, 10, -40, -14, 2.0, 8.0)

	conservative, err := ScanWith(path, Options{Sensitivity: SensitivityConservative})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	balanced, err := ScanWith(path, Options{Sensitivity: SensitivityBalanced})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	aggressive, err := ScanWith(path, Options{Sensitivity: SensitivityAggressive})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if !(conservative.ThresholdDB() < balanced.ThresholdDB()) {
		t.Errorf("conservative threshold %.1f must sit below balanced %.1f",
			conservative.ThresholdDB(), balanced.ThresholdDB())
	}
	if !(balanced.ThresholdDB() < aggressive.ThresholdDB()) {
		t.Errorf("balanced threshold %.1f must sit below aggressive %.1f",
			balanced.ThresholdDB(), aggressive.ThresholdDB())
	}
	// More of the file counts as sound when the bar is lower.
	if !(conservative.SpeechRatio() >= balanced.SpeechRatio()) {
		t.Errorf("conservative ratio %.2f must be at least balanced %.2f",
			conservative.SpeechRatio(), balanced.SpeechRatio())
	}
	if !(balanced.SpeechRatio() >= aggressive.SpeechRatio()) {
		t.Errorf("balanced ratio %.2f must be at least aggressive %.2f",
			balanced.SpeechRatio(), aggressive.SpeechRatio())
	}
}

// Case 18: the voice-to-background ratio is what decides whether the file
// needs a cleanup pass, and it has to come out of the same measurement.
func TestTheProfileCarriesTheLevelsTheUINeeds(t *testing.T) {
	path := roomToneWithSpeech(t, 10, -28, -6, 3.5, 6.5)

	s, err := Scan(path)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if snr := s.SNRDB(); snr < 18 || snr > 26 {
		t.Errorf("SNR = %.1f dB, want about 22 (-6 dBFS speech over a -28 dBFS floor)", snr)
	}
	if peak := s.PeakDB(); peak < -8 || peak > -4 {
		t.Errorf("peak = %.1f dBFS, want about -6", peak)
	}
	if speech := s.SpeechDB(); speech < -8 || speech > -4 {
		t.Errorf("speech level = %.1f dBFS, want about -6", speech)
	}
}

// The threshold may never sit above the speech it is supposed to detect.
// That was the bug the absolute floor was introduced for, and the adaptive
// rule must not reintroduce it.
func TestTheThresholdNeverSitsAboveTheSpeech(t *testing.T) {
	// A uniformly quiet recording: floor and speech are the same level.
	samples := make([]int16, 3*testRate)
	for i := range samples {
		samples[i] = ampForDB(-47)
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if s.ThresholdDB() >= s.SpeechDB() {
		t.Errorf("threshold %.1f must stay below the speech level %.1f",
			s.ThresholdDB(), s.SpeechDB())
	}
	if !s.WorthTranscribing() {
		t.Error("a quiet recording must never be mistaken for silence")
	}
}
