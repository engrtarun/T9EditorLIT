package vault

// manifest.go — what has already been stored, so a crash costs one part.
//
// A 5 GB upload over a home uplink runs for tens of minutes. Anything that can
// interrupt it will: the laptop sleeps, Telegram rate-limits, the daemon
// restarts with the app. Without a durable record, every one of those events
// sends the whole 5 GB again.
//
// So the manifest is rewritten on disk after each stored part and holds the
// message id Telegram gave us. On the next run the parts that are already in
// the chat are skipped — but only after their digest is re-checked against the
// file, because a resume that trusts a stale record will happily send a part of
// a file that has since been re-exported, and the archive silently rots.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ManifestVersion is bumped when the on-disk shape changes incompatibly.
const ManifestVersion = 1

// ManifestPart is one slice and where it ended up.
type ManifestPart struct {
	Index  int    `json:"index"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
	Name   string `json:"name"`
	// SHA256 is the digest of the slice on disk at upload time. It is what a
	// restore verifies against, and what a resume re-checks before skipping.
	SHA256 string `json:"sha256"`
	// MessageID is the id of the message carrying this part in the chat.
	MessageID int `json:"message_id,omitempty"`
	// Link is the human-readable t.me URL, filled in when a public username
	// is known. Empty for a private chat, where no such link exists.
	Link string `json:"link,omitempty"`
}

// Stored reports whether this part is known to be in the chat.
func (p ManifestPart) Stored() bool { return p.MessageID != 0 }

// Manifest is the durable record of one file's upload.
type Manifest struct {
	Version int `json:"version"`
	// Source is the absolute path that was uploaded, recorded so a resume can
	// refuse to continue against a different file.
	Source     string `json:"source"`
	SourceSize int64  `json:"source_size"`
	PartSize   int64  `json:"part_size"`
	Chat       string `json:"chat"`
	// User is the @username of the destination chat when it has one, used
	// only to build t.me links.
	User string `json:"user,omitempty"`
	// Parts holds every part of the plan, stored or not.
	Parts []ManifestPart `json:"parts"`
	// Complete is set once every part has a message id.
	Complete bool  `json:"complete"`
	Created  int64 `json:"created_unix"`
	Updated  int64 `json:"updated_unix"`
	// Error records why the last run stopped, for the UI.
	Error string `json:"error,omitempty"`
}

// StoredCount is how many parts are already in the chat.
func (m *Manifest) StoredCount() int {
	n := 0
	for _, p := range m.Parts {
		if p.Stored() {
			n++
		}
	}
	return n
}

// manifestStore serialises one manifest file.
//
// Every write goes through the mutex because the upload workers record their
// parts concurrently, and a half-written JSON file would be read as "no
// manifest" on the next run — quietly turning a resume into a full re-send.
type manifestStore struct {
	mu   sync.Mutex
	path string
	m    *Manifest
}

// manifestDir is where resume state lives, inside the session directory so it
// disappears with the session and is never left behind in the user's videos.
func manifestDir(sessionDir string) string {
	return filepath.Join(sessionDir, "manifests")
}

// manifestPathFor derives a stable file name for a source.
//
// The path alone is not enough: the same file re-exported to a different length
// is a different upload, and mixing the two would resume a stale record onto
// new bytes. Size is mixed in, and the result is hashed so a long Windows path
// or a folder name with characters Windows dislikes cannot become a file name.
func manifestPathFor(sessionDir, source string, size int64) string {
	h := fnv64a(strings.ToLower(filepath.Clean(source)) + "|" + fmt.Sprint(size))
	return filepath.Join(manifestDir(sessionDir), fmt.Sprintf("upload-%016x.json", h))
}

// fnv64a is used only to pick a manifest file name. It is not a security
// boundary — it is 20 lines of arithmetic instead of a dependency.
func fnv64a(s string) uint64 {
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	h := uint64(offset64)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime64
	}
	return h
}

// openManifest loads the manifest for a source, or returns a fresh one.
//
// A corrupt or unreadable file is treated as "no manifest": re-uploading is
// wasteful but correct, and refusing to upload because a scratch file is
// malformed is not an acceptable failure mode.
func openManifest(sessionDir, source string, size, partSize int64, chat string) (*manifestStore, error) {
	dir := manifestDir(sessionDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating %s: %w", dir, err)
	}

	store := &manifestStore{path: manifestPathFor(sessionDir, source, size)}

	raw, err := os.ReadFile(store.path)
	switch {
	case err == nil:
		var m Manifest
		if json.Unmarshal(raw, &m) == nil && m.Version == ManifestVersion {
			if m.SourceSize == size && m.PartSize == partSize && strings.EqualFold(m.Source, filepath.Clean(source)) {
				store.m = &m
				return store, nil
			}
		}
	case !os.IsNotExist(err):
		return nil, fmt.Errorf("reading the resume file: %w", err)
	}

	store.m = &Manifest{
		Version:    ManifestVersion,
		Source:     filepath.Clean(source),
		SourceSize: size,
		PartSize:   partSize,
		Chat:       chat,
		Created:    time.Now().Unix(),
	}
	return store, nil
}

// seed fills the manifest's part list from the current plan, preserving the
// message ids of parts that are still identical on disk.
//
// A part is kept only when its offset, size and digest all match: that is the
// test that a resume cannot attach to a file that changed underneath it.
func (s *manifestStore) seed(parts []Part, digests []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	previous := make(map[int]ManifestPart, len(s.m.Parts))
	for _, p := range s.m.Parts {
		previous[p.Index] = p
	}

	next := make([]ManifestPart, 0, len(parts))
	changed := false
	for i, p := range parts {
		entry := ManifestPart{
			Index:  p.Index,
			Offset: p.Offset,
			Size:   p.Size,
			Name:   p.Name,
			SHA256: digests[i],
		}
		if old, ok := previous[p.Index]; ok && old.SHA256 == entry.SHA256 &&
			old.Offset == entry.Offset && old.Size == entry.Size && old.Stored() {
			entry.MessageID = old.MessageID
			entry.Link = old.Link
		} else if ok {
			changed = true
		}
		next = append(next, entry)
	}

	if len(next) != len(s.m.Parts) {
		changed = true
	}
	s.m.Parts = next
	s.m.Complete = false
	if changed {
		s.m.Error = ""
	}
}

// adopt fills the manifest's part list from the current plan, keeping the
// message ids of parts whose offset and size still match.
//
// It is the digest-free version of seed, used by the transport as it records
// results. The digest check has already happened by then — in seed, called by
// the planner, which is what decides whether a part is skipped at all — so by
// the time anything is written here the on-disk bytes are known to be the ones
// being uploaded.
func (s *manifestStore) adopt(parts []Part) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.m.Parts) == len(parts) {
		same := true
		for i, p := range parts {
			if s.m.Parts[i].Index != p.Index ||
				s.m.Parts[i].Offset != p.Offset ||
				s.m.Parts[i].Size != p.Size {
				same = false
				break
			}
		}
		if same {
			return
		}
	}

	previous := make(map[int]ManifestPart, len(s.m.Parts))
	for _, p := range s.m.Parts {
		previous[p.Index] = p
	}

	next := make([]ManifestPart, 0, len(parts))
	for _, p := range parts {
		entry := ManifestPart{
			Index:  p.Index,
			Offset: p.Offset,
			Size:   p.Size,
			Name:   p.Name,
			SHA256: previous[p.Index].SHA256,
		}
		if old, ok := previous[p.Index]; ok && old.Offset == entry.Offset && old.Size == entry.Size {
			entry.MessageID = old.MessageID
			entry.Link = old.Link
		}
		next = append(next, entry)
	}
	s.m.Parts = next
	s.m.Complete = false
}

// skipSet is the set of part indexes that are already in the chat.
func (s *manifestStore) skipSet() map[int]bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	skip := make(map[int]bool, len(s.m.Parts))
	for _, p := range s.m.Parts {
		if p.Stored() {
			skip[p.Index] = true
		}
	}
	return skip
}

// record stores a confirmed part and rewrites the file.
//
// Called after every part lands, which is what makes an interrupted run cost
// one part rather than the whole file.
func (s *manifestStore) record(index int, messageID int, link string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.m.Parts {
		if s.m.Parts[i].Index == index {
			s.m.Parts[i].MessageID = messageID
			s.m.Parts[i].Link = link
		}
	}
	s.m.Complete = s.m.StoredCount() == len(s.m.Parts) && len(s.m.Parts) > 0
	s.m.Updated = time.Now().Unix()
	s.m.Error = ""
	s.saveLocked()
}

// save persists the manifest as it stands.
//
// The planner calls this straight after seeding it, because the digests live
// only in that in-memory copy and the transport is what writes the file later.
// Without it, every stored part would reach disk with an empty digest, and the
// next run would reject its own record and re-send the whole file.
func (s *manifestStore) save() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m.Updated = time.Now().Unix()
	s.saveLocked()
}

// fail records why a run stopped. The stored parts stay recorded.
func (s *manifestStore) fail(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.m.Error = reason
	s.m.Updated = time.Now().Unix()
	s.saveLocked()
}

// setUser records the destination username, used to build t.me links.
func (s *manifestStore) setUser(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if user != "" && s.m.User != user {
		s.m.User = user
	}
}

// snapshot copies the manifest for reporting.
func (s *manifestStore) snapshot() Manifest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := *s.m
	out.Parts = append([]ManifestPart(nil), s.m.Parts...)
	return out
}

// saveLocked writes the manifest atomically.
//
// Temp file plus rename: a reader (the next run, or the UI) must never see a
// partially written file, and on Windows a rename over an existing file only
// succeeds if the target is replaced rather than truncated in place.
func (s *manifestStore) saveLocked() {
	raw, err := json.MarshalIndent(s.m, "", "  ")
	if err != nil {
		return
	}

	tmp, err := os.CreateTemp(filepath.Dir(s.path), "upload-*.tmp")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below succeeds

	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	_ = os.Chmod(tmpName, 0o600)
	if err := os.Rename(tmpName, s.path); err != nil {
		return
	}
}
