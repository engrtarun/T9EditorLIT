// Package vault is the Telegram backup seam.
//
// Scope note, deliberately narrow: this daemon exists because MTProto sessions
// are STATEFUL. A desktop app that gets closed loses its authorised session and
// has to make the user re-enter an OTP. A long-lived daemon keeps the session
// alive on disk, which is the one place Telegram genuinely needs its own
// process.
//
// The split planner below is complete and tested — a 5 GB source exceeds the
// 2 GB MTProto file ceiling and must be sent as parts. The transport itself
// lands in Chunk 5, behind the Uploader interface, so the routing, chunking and
// retry behaviour can be finished and tested now.
package vault

import (
	"context"
	"errors"
	"fmt"
	"os"
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

// Uploader sends parts to a chat. Implemented for real in Chunk 5.
type Uploader interface {
	// Send streams one part. Implementations must not buffer the part whole;
	// a 1.9 GB part in memory would defeat the entire design.
	Send(ctx context.Context, chatID, path string, offset, size int64) (messageID int, err error)
	// Authorise performs the interactive login once and persists the session.
	Authorise(ctx context.Context) error
	// Authorised reports whether a usable session exists on disk.
	Authorised() bool
}

// Vault ties planning to an Uploader.
type Vault struct {
	Uploader  Uploader
	PartSize  int64
	ChatID    string
	SessionOn bool
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

// Upload sends every part in order.
//
// Sequential by design: parts of one file must land in order for a later
// reassembly to work, and parallel uploads would only compete for the same
// limited bandwidth while multiplying peak memory.
func (v *Vault) Upload(ctx context.Context, path string) (parts []Part, ids []int, err error) {
	if v.Uploader == nil {
		return nil, nil, ErrNotConfigured
	}

	parts, _, err = v.Planned(path)
	if err != nil {
		return nil, nil, err
	}

	for _, p := range parts {
		select {
		case <-ctx.Done():
			return parts, ids, ctx.Err()
		default:
		}

		id, err := v.Uploader.Send(ctx, v.ChatID, path, p.Offset, p.Size)
		if err != nil {
			return parts, ids, fmt.Errorf("sending part %d/%d (%s): %w",
				p.Index+1, len(parts), p.Name, err)
		}
		ids = append(ids, id)
	}

	return parts, ids, nil
}
