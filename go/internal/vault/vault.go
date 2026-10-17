// Package vault is the Telegram backup seam.
//
// Scope note, deliberately narrow: this daemon exists because MTProto sessions
// are STATEFUL. A desktop app that gets closed loses its authorised session and
// has to make the user re-enter an OTP. A long-lived daemon keeps the session
// alive on disk, which is the one place Telegram genuinely needs its own
// process.
//
// Three layers, in dependency order:
//
//	vault.go    the split planner and the orchestration over an Uploader
//	telegram.go the live MTProto transport: connection pool, streaming send
//	login.go    authorisation by QR scan — no OTP, no phone number
//
// The planner is deliberately complete on its own, because getting a split
// wrong means silently uploading a corrupt file, and the user only finds out
// after the fact.
package vault

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
)

// ErrNotConfigured means the vault has no Telegram credentials yet. It is a
// normal, expected state before Chunk 5 — not a crash.
var ErrNotConfigured = errors.New("telegram vault is not configured")

// Telegram's MTProto file ceiling is 2 GB. Chunks are sized a little under it
// so a part can never be pushed over by a rounding error.
const (
	MaxTelegramFileBytes = 2_000_000_000
	DefaultPartBytes     = 1_900_000_000
)

// Part is one slice of a file destined for Telegram.
type Part struct {
	Index  int    `json:"index"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
	Name   string `json:"name"`
}

// Plan splits a file into upload parts.
//
// This is the piece that must be right before any transport exists: getting it
// wrong means silently uploading a corrupt file, and the user only finds out
// after the fact.
func Plan(path string, fileSize int64, partSize int64) ([]Part, error) {
	if fileSize <= 0 {
		return nil, fmt.Errorf("cannot plan upload for a %d byte file", fileSize)
	}
	if partSize <= 0 {
		partSize = DefaultPartBytes
	}
	if partSize > MaxTelegramFileBytes {
		return nil, fmt.Errorf("part size %d exceeds the Telegram limit of %d",
			partSize, MaxTelegramFileBytes)
	}

	name := baseName(path)
	total := (fileSize + partSize - 1) / partSize

	parts := make([]Part, 0, total)
	for i := int64(0); i < total; i++ {
		offset := i * partSize
		size := partSize
		if remaining := fileSize - offset; remaining < partSize {
			size = remaining
		}
		parts = append(parts, Part{
			Index:  int(i),
			Offset: offset,
			Size:   size,
			Name:   partName(name, int(i), int(total)),
		})
	}
	return parts, nil
}

// PlanFile resolves the size from disk and plans the split.
func PlanFile(path string, partSize int64) ([]Part, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, fmt.Errorf("stat %s: %w", path, err)
	}
	parts, err := Plan(path, info.Size(), partSize)
	if err != nil {
		return nil, 0, err
	}
	return parts, info.Size(), nil
}

// partName is `clip.mp4` + 2 parts → `clip.part1.mp4`, `clip.part2.mp4`.
func partName(base string, index, total int) string {
	if total <= 1 {
		return base
	}
	dot := len(base)
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '.' {
			dot = i
			break
		}
	}
	if dot == 0 {
		return fmt.Sprintf("%s.part%d", base, index+1)
	}
	return fmt.Sprintf("%s.part%d%s", base[:dot], index+1, base[dot:])
}

func baseName(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}

// Uploader sends parts to a chat.
type Uploader interface {
	// Send streams one part. Implementations must not buffer the part whole;
	// a 1.9 GB part in memory would defeat the entire design.
	Send(ctx context.Context, chatID, path string, offset, size int64) (messageID int, err error)
	// Authorise performs the interactive login once and persists the session.
	Authorise(ctx context.Context) error
	// Authorised reports whether a usable session exists on disk.
	Authorised() bool
}

// Batcher is an Uploader that can send several parts of one file at once.
//
// It exists because of the bandwidth-delay product: goroutines sharing a single
// MTProto connection share a single TCP window and cannot raise the rate, so a
// real transport has to spread parts across several connections. An Uploader
// that does not implement Batcher is driven sequentially, one part at a time.
type Batcher interface {
	UploadParts(
		ctx context.Context,
		chatID, path string,
		parts []Part,
		send []int,
		report func(Progress),
	) (messageIDs []int, err error)
}

// Progress is a snapshot of an upload run, safe to read at any time.
//
// The UI polls for one of these rather than holding a socket open to a daemon
// that may restart mid-transfer, which is exactly what happens when the app is
// closed for two hours and reopened.
type Progress struct {
	// Phase is "hashing", "uploading" or "done".
	Phase string `json:"phase"`
	// PartIndex is the part currently in flight, zero-based.
	PartIndex int `json:"part_index"`
	// PartCount is how many parts the file was split into.
	PartCount int `json:"part_count"`
	// PartsDone counts parts Telegram has confirmed.
	PartsDone int `json:"parts_done"`
	// BytesDone is bytes hashed or sent so far, monotonic within a run.
	BytesDone int64 `json:"bytes_done"`
	// BytesTotal is the size of the source file.
	BytesTotal int64 `json:"bytes_total"`
	// BytesPerSec is the observed rate, useful for "this is going to take 40
	// minutes" rather than a bare percentage.
	BytesPerSec float64 `json:"bytes_per_sec"`
	// ElapsedSec is how long the run has been going.
	ElapsedSec float64 `json:"elapsed_sec"`
	// Connections is the pool size in use, i.e. how many TCP sockets are
	// carrying the bytes at once.
	Connections int `json:"connections"`
	// Message is a short human-readable note for the UI.
	Message string `json:"message,omitempty"`
}

// Percent is 0–100 completion, or 0 when the total is not known yet.
func (p Progress) Percent() float64 {
	if p.BytesTotal <= 0 {
		return 0
	}
	return float64(p.BytesDone) / float64(p.BytesTotal) * 100
}

// Vault ties planning to an Uploader.
type Vault struct {
	Uploader  Uploader
	PartSize  int64
	ChatID    string
	SessionOn bool
	// SessionDir holds the resume manifests. It must be the same directory the
	// transport uses, since both read and write the same records.
	SessionDir string
	// OnProgress, when set, receives a snapshot after every event of an
	// upload run. Callers should copy the Vault and set this rather than
	// mutating a shared one: the daemon has several uploads in flight and each
	// job needs its own progress sink.
	OnProgress func(Progress)
}

// Unconfigured is the Vault returned when no Telegram credentials are set.
// It plans correctly and then refuses clearly, instead of failing obscurely
// at the point of upload.
func Unconfigured() *Vault {
	return &Vault{PartSize: DefaultPartBytes}
}

// Planned reports the split for a file without uploading anything.
func (v *Vault) Planned(path string) ([]Part, int64, error) {
	return PlanFile(path, v.PartSize)
}

func (v *Vault) report(p Progress) {
	if v.OnProgress != nil {
		v.OnProgress(p)
	}
}

// Upload sends every part of a file to the configured chat.
//
// Three things happen before the first byte leaves, and all three are cheap
// next to re-sending 5 GB:
//
//  1. The file is planned into parts.
//  2. Every part is hashed, streaming, so the manifest can prove later that the
//     bytes in Telegram are the bytes on disk.
//  3. Parts already in the chat are skipped — but only after their digest is
//     re-checked, so a resume can never attach to a file that changed.
//
// The send itself is parallel when the transport supports it. Whether it is
// depends on the transport, not on this function: parts of one file land in a
// deterministic order in the manifest regardless of which connection carried
// them.
func (v *Vault) Upload(ctx context.Context, path string) (parts []Part, ids []int, err error) {
	if v.Uploader == nil {
		return nil, nil, ErrNotConfigured
	}

	parts, size, err := v.Planned(path)
	if err != nil {
		return nil, nil, err
	}

	batcher, canBatch := v.Uploader.(Batcher)
	tracker := newProgressTracker(v.report, size, len(parts), connectionsOf(v.Uploader))

	// Hash every part before sending anything. This is a full read of the file
	// (a few minutes on a slow disk) and it is what makes both the resume and
	// a future restore verifiable.
	tracker.setPhase(PhaseHashing)
	digests, err := v.hashParts(path, parts, tracker)
	if err != nil {
		return parts, nil, err
	}

	// Decide what still has to be sent.
	send, skip := v.pending(path, parts, digests)

	if canBatch {
		// The transport reports the send itself, through the same callback:
		// it is the only thing that knows how its connections are doing, and a
		// second counter here would only fight with it.
		v.phase(PhaseUploading, len(skip), len(parts), 0, size)
		got, sendErr := batcher.UploadParts(ctx, v.ChatID, path, parts, send, v.report)
		if sendErr != nil {
			return parts, nil, sendErr
		}
		ids = mergeIDs(send, skip, got)
		v.phase(PhaseDone, len(parts), len(parts), size, size)
		return parts, ids, nil
	}

	tracker.setPhase(PhaseUploading)
	for _, i := range skip {
		tracker.partStored(parts[i])
	}
	if len(skip) == len(parts) {
		tracker.setPhase(PhaseDone)
		return parts, allMessageIDs(len(parts)), nil
	}

	for _, index := range send {
		select {
		case <-ctx.Done():
			return parts, ids, ctx.Err()
		default:
		}
		part := parts[index]
		id, sendErr := v.Uploader.Send(ctx, v.ChatID, path, part.Offset, part.Size)
		if sendErr != nil {
			// The ids already collected are real: those parts are in
			// Telegram. Reporting them is what lets a resume skip them.
			return parts, ids, fmt.Errorf("sending part %d/%d (%s): %w",
				part.Index+1, len(parts), part.Name, sendErr)
		}
		ids = append(ids, id)
		tracker.partStored(part)
	}

	tracker.setPhase(PhaseDone)
	return parts, mergeIDs(send, skip, ids), nil
}

// phase reports a whole-file milestone without a counter behind it.
//
// The terminal event is built from facts the planner already has — the file size
// and the part count — rather than from a tracker that only watched the hashing
// pass. Deriving it from the wrong counter is how a progress bar ends a
// successful 5 GB backup showing 0%.
func (v *Vault) phase(name string, partsDone, partCount int, done, total int64) {
	v.report(Progress{
		Phase:       name,
		PartsDone:   partsDone,
		PartCount:   partCount,
		BytesDone:   done,
		BytesTotal:  total,
		Connections: connectionsOf(v.Uploader),
	})
}

// hashParts returns the SHA-256 of every part, streaming and bounded.
//
// Hashing reads from disk, so it runs in parallel — but bounded. Four
// concurrent 512 KB reads are free; four hundred would thrash the i3 this
// project is designed to run on.
func (v *Vault) hashParts(path string, parts []Part, tracker *progressTracker) ([]string, error) {
	digests := make([]string, len(parts))
	if len(parts) == 0 {
		return digests, nil
	}

	workers := hashWorkers
	if workers > len(parts) {
		workers = len(parts)
	}

	jobs := make(chan int)
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		failed error
	)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				digest, err := HashPart(path, parts[index])

				mu.Lock()
				if err != nil {
					if failed == nil {
						failed = err
					}
					mu.Unlock()
					continue
				}
				digests[index] = digest
				mu.Unlock()
			}
		}()
	}

	for i := range parts {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	if failed != nil {
		return nil, failed
	}
	return digests, nil
}

// hashWorkers bounds concurrent hashing reads.
const hashWorkers = 4

// pending is the list of part indexes that still need sending, and those that
// are already in the chat.
func (v *Vault) pending(path string, parts []Part, digests []string) (send, skip []int) {
	all := func() ([]int, []int) {
		out := make([]int, len(parts))
		for i := range parts {
			out[i] = i
		}
		return out, nil
	}

	sessionDir := v.sessionDir()
	if sessionDir == "" {
		// No manifest location means no resume: send everything.
		return all()
	}

	store, err := openManifest(sessionDir, path, totalSize(parts), partSpan(parts), v.ChatID)
	if err != nil || store == nil {
		return all()
	}
	store.seed(parts, digests)
	// Persist before any bytes move: the digests computed here exist only in
	// this copy, and the transport is what writes the file afterwards.
	store.save()

	already := store.skipSet()
	for i, p := range parts {
		if already[p.Index] {
			skip = append(skip, i)
			continue
		}
		send = append(send, i)
	}
	return send, skip
}

// sessionDir is where the resume manifests live.
//
// An explicit field wins over the transport's own directory: the planner and
// the transport have to agree on one location, and the daemon is the only thing
// that knows both.
func (v *Vault) sessionDir() string {
	if v.SessionDir != "" {
		return v.SessionDir
	}
	if t, ok := v.Uploader.(*Telegram); ok {
		return t.opts.SessionDir
	}
	return ""
}

// LoginStarter is the stepped QR login, when the transport supports it.
//
// The daemon asks for this rather than requiring it: a Vault built on a
// different Uploader (or none at all) still plans correctly and refuses
// clearly, which is what the unconfigured case has always done.
func (v *Vault) LoginStarter() (LoginStarter, bool) {
	if v == nil {
		return nil, false
	}
	starter, ok := v.Uploader.(LoginStarter)
	return starter, ok
}

// mergeIDs rebuilds the message id list in part order, with skipped parts
// carrying no id because nothing was sent for them this run.
func mergeIDs(send, skip []int, got []int) []int {
	byIndex := make(map[int]int, len(got))
	for i, index := range send {
		if i < len(got) && got[i] != 0 {
			byIndex[index] = got[i]
		}
	}
	out := make([]int, 0, len(byIndex))
	for _, index := range send {
		if id, ok := byIndex[index]; ok {
			out = append(out, id)
		}
	}
	return out
}

func allMessageIDs(n int) []int { return make([]int, 0, n) }

// connectionsOf reports the transport's pool size, so progress can show how many
// sockets are carrying the bytes.
func connectionsOf(u Uploader) int {
	if t, ok := u.(*Telegram); ok {
		return t.Connections()
	}
	return 1
}
