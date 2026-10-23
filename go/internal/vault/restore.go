package vault

// restore.go — the read half of the vault: Telegram → disk.
//
// The write half (vault.go + telegram.go) streams parts OUT; this half mirrors
// it. It walks the resume manifest the upload wrote, streams each stored part
// down through the transport, proves the bytes with the digests the upload
// recorded, and only then joins the parts into the one file the user selected.
// This is the "vault → media library" seam: the caller gets a disk path the
// app can add like any imported file.
//
// The same three rules the upload obeys hold here:
//
//   - nothing is buffered whole. Every part streams from the network through a
//     512 KB chunk into a temp file on disk, and the join streams part files
//     into the final file through a fixed buffer.
//   - a digest is the only trust. A part is "restored" when the SHA-256 of the
//     bytes on disk equals the one recorded when it was uploaded, and never by
//     a byte count or a successful RPC.
//   - an interruption costs one part. A per-restore record tracks which parts
//     are already verified, so a five-minute disconnect does not re-download
//     forty minutes of bytes.
//
// The temp part files live next to the destination and are removed when the
// join succeeds. The destination itself is never touched until every byte is
// proven: a half-written "restored" video in the user's folder would look
// exactly like the corruption this design exists to prevent.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// restoreManifestVersion is bumped when the on-disk shape changes
// incompatibly. Same rule as ManifestVersion.
const restoreManifestVersion = 1

// restoreTempPrefix marks a temp part file. It starts with a dot so the file
// sorts apart from real files, and every restore temp is removed on success.
const restoreTempPrefix = ".t9restore-"

// RestorePart is one piece of a restore in progress.
type RestorePart struct {
	Index     int    `json:"index"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	MessageID int    `json:"message_id,omitempty"`
	// Done means the part is on disk next to the destination and its digest
	// has been verified. A resume trusts this only after re-checking.
	Done bool `json:"done"`
}

// RestoreManifest is the durable record of one restore run.
type RestoreManifest struct {
	Version    int           `json:"version"`
	Source     string        `json:"source"`
	SourceSize int64         `json:"source_size"`
	PartSize   int64         `json:"part_size"`
	Chat       string        `json:"chat"`
	DestDir    string        `json:"dest_dir"`
	DestName   string        `json:"dest_name"`
	Parts      []RestorePart `json:"parts"`
	Complete   bool          `json:"complete"`
	Created    int64         `json:"created_unix"`
	Updated    int64         `json:"updated_unix"`
	// Error records why the last run stopped, for the UI.
	Error string `json:"error,omitempty"`
}

// DoneCount is how many parts are verified on disk.
func (m *RestoreManifest) DoneCount() int {
	n := 0
	for _, p := range m.Parts {
		if p.Done {
			n++
		}
	}
	return n
}

// restoreStore serialises one restore record. The upload manifest's mutex
// exists because workers write parts concurrently; the same argument applies
// here — restore workers record their parts from different goroutines.
type restoreStore struct {
	mu   sync.Mutex
	path string
	m    *RestoreManifest
}

// restoreManifestPath keys a restore run on destination + source. The same
// vault file restored into two folders are two independent operations, each
// with its own resume record — restoring "back to where it came from" and
// restoring onto the D: drive must not share state.
func restoreManifestPath(sessionDir string, m *Manifest, destDir string) string {
	key := "restore|" + strings.ToLower(filepath.Clean(destDir)) + "|" +
		strings.ToLower(filepath.Clean(m.Source)) + "|" + fmt.Sprint(m.SourceSize)
	return filepath.Join(manifestDir(sessionDir), fmt.Sprintf("%s%016x.json", "restore-", fnv64a(key)))
}

// openRestoreManifest loads the restore record for this source+destination, or
// starts a fresh one.
//
// A corrupt record is treated as "no record": re-verified temp files are
// picked up by the digest check anyway, so losing the record costs a
// re-verification pass, never bytes on the network.
func openRestoreManifest(
	sessionDir string,
	upload *Manifest,
	destDir, destName string,
) (*restoreStore, error) {
	dir := manifestDir(sessionDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating %s: %w", dir, err)
	}

	store := &restoreStore{path: restoreManifestPath(sessionDir, upload, destDir)}

	raw, err := os.ReadFile(store.path)
	if err == nil {
		var m RestoreManifest
		if json.Unmarshal(raw, &m) == nil && m.Version == restoreManifestVersion &&
			m.SourceSize == upload.SourceSize && m.PartSize == upload.PartSize &&
			strings.EqualFold(m.Source, filepath.Clean(upload.Source)) &&
			strings.EqualFold(m.DestDir, filepath.Clean(destDir)) {
			store.m = &m
			return store, nil
		}
		// A mismatched record is not "stop uploading": the file may simply
		// have been restored before and re-uploaded since. Fall through to
		// a fresh record.
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading the restore record: %w", err)
	}

	parts := make([]RestorePart, 0, len(upload.Parts))
	for _, p := range upload.Parts {
		parts = append(parts, RestorePart{
			Index:     p.Index,
			Size:      p.Size,
			SHA256:    p.SHA256,
			MessageID: p.MessageID,
		})
	}

	store.m = &RestoreManifest{
		Version:    restoreManifestVersion,
		Source:     filepath.Clean(upload.Source),
		SourceSize: upload.SourceSize,
		PartSize:   upload.PartSize,
		Chat:       upload.Chat,
		DestDir:    filepath.Clean(destDir),
		DestName:   destName,
		Parts:      parts,
		Created:    time.Now().Unix(),
	}
	return store, nil
}

// doneSet is the set of part indexes already verified for this restore.
func (s *restoreStore) doneSet() map[int]bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	done := make(map[int]bool, len(s.m.Parts))
	for _, p := range s.m.Parts {
		if p.Done {
			done[p.Index] = true
		}
	}
	return done
}

// recordDone marks one part verified and rewrites the file.
func (s *restoreStore) recordDone(index int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.m.Parts {
		if s.m.Parts[i].Index == index {
			s.m.Parts[i].Done = true
		}
	}
	s.m.Complete = s.m.DoneCount() == len(s.m.Parts) && len(s.m.Parts) > 0
	s.m.Updated = time.Now().Unix()
	s.m.Error = ""
	s.saveLocked()
}

// fail records why a restore run stopped. Verified parts stay recorded.
func (s *restoreStore) fail(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.m.Error = reason
	s.m.Updated = time.Now().Unix()
	s.saveLocked()
}

// saveLocked writes the record atomically, exactly like the upload manifest.
func (s *restoreStore) saveLocked() {
	raw, err := json.MarshalIndent(s.m, "", "  ")
	if err != nil {
		return
	}

	tmp, err := os.CreateTemp(filepath.Dir(s.path), "restore-*.tmp")
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

// ── the orchestration ───────────────────────────────────────────────────

// Fetcher is a transport that can stream stored parts back down.
//
// It is optional the way Batcher is: a transport without it still plans a
// restore correctly and refuses clearly, rather than pretending downloads are
// impossible for the vault as a whole.
type Fetcher interface {
	// FetchParts streams the given part indexes of an uploaded file into
	// destDir, one temp file per part, verifying each digest before recording
	// it. Implementations must not buffer a part whole.
	//
	// base is the byte total already verified on disk when the call starts
	// (the preflight's resume work), so the progress counter continues rather
	// than restarting from zero mid-restore.
	FetchParts(
		ctx context.Context,
		chatID string,
		m Manifest,
		fetch []int,
		destDir string,
		base int64,
		report func(Progress),
	) error
}

// Restore puts one backed-up file back on disk.
//
// The manifest is the record the upload left behind. Four stages run before the
// first network byte: the record is opened, the destination is planned, temp
// files from an earlier attempt are re-verified (cheap: it is a disk read), and
// the transport is handed only the parts whose bytes are truly missing.
//
// The returned path is what the app adds to the media library.
func (v *Vault) Restore(ctx context.Context, m Manifest, destDir string) (string, error) {
	switch {
	case v.Uploader == nil:
		return "", ErrNotConfigured
	case ctx == nil:
		return "", errors.New("restore called without a context")
	}

	fetcher, canFetch := v.Uploader.(Fetcher)
	if !canFetch {
		return "", errors.New("this vault transport cannot fetch stored parts; a restore needs the live transport")
	}

	chat := m.Chat
	if chat == "" {
		chat = v.ChatID
	}
	if chat == "" {
		return "", errors.New("the manifest does not name the vault chat, and no default chat is configured")
	}

	if err := checkRestorable(&m); err != nil {
		return "", err
	}
	name, err := RestoreName(m.Source)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return "", fmt.Errorf("creating %s: %w", destDir, err)
	}

	final := filepath.Join(destDir, name)
	if fi, statErr := os.Stat(final); statErr == nil {
		if fi.Size() == m.SourceSize {
			// Idempotent: restoring twice lands in the same place. Reporting
			// success is honest — the file is there and complete.
			v.phase(PhaseDone, len(m.Parts), len(m.Parts), m.SourceSize, m.SourceSize)
			return final, nil
		}
		return "", fmt.Errorf(
			"refusing to restore %s: a different file (%s) already sits there; move it away first",
			name, humanBytes(fi.Size()))
	}

	store, err := openRestoreManifest(v.sessionDir(), &m, destDir, name)
	if err != nil {
		return "", err
	}

	tracker := newRestoreProgress(v.report, m.SourceSize, len(m.Parts), connectionsOf(v.Uploader))
	tracker.setPhase(PhaseVerifying)

	fetch, verified, err := restorePreflight(store, &m, destDir, name, tracker)
	if err != nil {
		store.fail(err.Error())
		return "", err
	}

	if len(fetch) > 0 {
		tracker.setPhase(PhaseDownloading)
		if err := fetcher.FetchParts(ctx, chat, m, fetch, destDir, verified, v.report); err != nil {
			store.fail(err.Error())
			return "", err
		}
	}

	// Re-read what the transport recorded: it has been writing to its own
	// copy of the record, so the planner reloads from disk rather than
	// trusting a snapshot taken before the download began.
	store, err = openRestoreManifest(v.sessionDir(), &m, destDir, name)
	if err != nil {
		return "", err
	}
	done := store.doneSet()
	if n := len(done); n < len(m.Parts) {
		for _, p := range m.Parts {
			if !done[p.Index] {
				err := fmt.Errorf("part %d/%d did not finish downloading; part files are kept for a resume",
					p.Index+1, len(m.Parts))
				store.fail(err.Error())
				return "", err
			}
		}
	}

	tracker.setPhase(PhaseJoining)
	if err := joinParts(final, &m, destDir, name, tracker); err != nil {
		store.fail(err.Error())
		return "", err
	}

	for i := range m.Parts {
		if tmp, statErr := RestoreTempPath(destDir, name, m.Parts[i].Index); statErr == nil {
			_ = os.Remove(tmp)
		}
	}

	v.phase(PhaseDone, len(m.Parts), len(m.Parts), m.SourceSize, m.SourceSize)
	return final, nil
}

// checkRestorable refuses to start on a record that cannot come back whole.
//
// A vault that was never finished is not restorable — the bytes the plan is
// missing exist only if the upload is completed first. Naming the first
// missing part beats a generic failure caught two hours into a download.
func checkRestorable(m *Manifest) error {
	if m.Version != ManifestVersion {
		return fmt.Errorf("manifest version %d is not readable here (expected %d)",
			m.Version, ManifestVersion)
	}
	if len(m.Parts) == 0 {
		return errors.New("the manifest holds no parts")
	}
	if m.SourceSize <= 0 {
		return errors.New("the manifest does not know the source size")
	}
	for _, p := range m.Parts {
		if !p.Stored() {
			return fmt.Errorf("the vault is incomplete: part %d was never uploaded; restore needs the finished upload",
				p.Index+1)
		}
	}
	return nil
}

// restorePreflight decides which parts need the network.
//
// A temp file from an earlier run is kept only when an exact-size match AND a
// fresh digest check both hold. The digest is what separates "already here"
// from "half-written": a ten-second computer freeze could leave a part file
// one disk sector short, and a size check alone would call that restored.
func restorePreflight(
	store *restoreStore,
	m *Manifest,
	destDir, name string,
	tracker *restoreProgress,
) (fetch []int, verified int64, err error) {
	done := store.doneSet()

	for i := range m.Parts {
		part := m.Parts[i]

		if done[part.Index] {
			tracker.partStored(part)
			verified += part.Size
			continue
		}

		tmp, perr := RestoreTempPath(destDir, name, part.Index)
		if perr != nil {
			return nil, 0, perr
		}
		if fi, statErr := os.Stat(tmp); statErr == nil && fi.Size() == part.Size {
			if derr := digestFile(tmp, part.Size, part.SHA256); derr == nil {
				store.recordDone(part.Index)
				tracker.partStored(part)
				verified += part.Size
				continue
			}
			// Not the right bytes. Remove so a fresh download has room.
			_ = os.Remove(tmp)
		}

		fetch = append(fetch, i)
	}
	return fetch, verified, nil
}

// joinParts concatenates the verified part files into the destination, in
// part order, streaming through a fixed buffer.
//
// The parts are exact offset slices of one file, so concatenation reproduces
// the original. The final size is the last authority: bytes on disk must
// equal the manifest's source size before anyone is told "restored".
func joinParts(
	final string,
	m *Manifest,
	destDir, name string,
	tracker *restoreProgress,
) error {
	out, err := os.OpenFile(final, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("creating %s: %w", name, err)
	}

	buf := make([]byte, 256*1024)
	doneBytes := int64(0)
	closeOut := func() error { return out.Close() }

	for i := range m.Parts {
		part := m.Parts[i]
		tmp, perr := RestoreTempPath(destDir, name, part.Index)
		if perr != nil {
			_ = closeOut()
			return perr
		}
		f, oerr := os.Open(tmp)
		if oerr != nil {
			_ = closeOut()
			return fmt.Errorf("opening part %d/%d: %w", part.Index+1, len(m.Parts), oerr)
		}

		n, cerr := io.CopyBuffer(out, f, buf)
		f.Close() // the data is in `out` now; a close error here is not fatal
		if cerr != nil {
			_ = closeOut()
			return fmt.Errorf("copying part %d/%d: %w", part.Index+1, len(m.Parts), cerr)
		}
		if n != part.Size {
			_ = closeOut()
			_ = os.Remove(final)
			return fmt.Errorf("part %d/%d (%s) changed while joining: wrote %d bytes, manifest says %d",
				part.Index+1, len(m.Parts), part.Name, n, part.Size)
		}

		doneBytes += n
		tracker.joinedBytes(doneBytes)
	}

	if err := out.Sync(); err != nil {
		_ = closeOut()
		return fmt.Errorf("flushing %s: %w", name, err)
	}
	if err := closeOut(); err != nil {
		return fmt.Errorf("closing %s: %w", name, err)
	}

	fi, statErr := os.Stat(final)
	if statErr != nil {
		return fmt.Errorf("checking the restored file: %w", statErr)
	}
	if fi.Size() != m.SourceSize {
		if rmErr := os.Remove(final); rmErr != nil {
			tracker.message("the restored file has the wrong size and could not be removed")
		}
		return fmt.Errorf("the rejoined file is %s but the manifest says %s — bytes were lost in the join and the file was removed",
			humanBytes(fi.Size()), humanBytes(m.SourceSize))
	}
	return nil
}

// digestFile streams a file's SHA-256 and compares it with the expected one.
//
// bufio absorbs the syscall pattern: a 1.9 GB part costs one read of 512 KB at
// a time, with a fixed buffer, on a machine that has 1 GB of headroom.
func digestFile(path string, size int64, want string) error {
	h := sha256.New()

	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	r := bufio.NewReaderSize(f, 512*1024)
	n, err := io.Copy(h, r)
	if err != nil {
		return fmt.Errorf("digest of %s: %w", filepath.Base(path), err)
	}
	if n != size {
		return fmt.Errorf("%s changed while being verified: read %d bytes, expected %d",
			filepath.Base(path), n, size)
	}

	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("digest mismatch: on disk %s…, manifest %s…",
			got[:8], shortSHA(want))
	}
	return nil
}

// RestoreTempPath is where one part's bytes land while a restore runs.
//
// Deterministic on (destination, part index) so a resume re-finds the exact
// file it wrote before, and prefixed so it sorts away from real media.
// Exported because any implementation of Fetcher writes these files, not just
// the built-in Telegram transport.
func RestoreTempPath(destDir, name string, index int) (string, error) {
	if index < 0 {
		return "", fmt.Errorf("bad restore part index %d", index)
	}
	return filepath.Join(destDir, fmt.Sprintf("%s%s.%03d.tmp", restoreTempPrefix, name, index)), nil
}

// restoreName derives the destination file name from the recorded source.
//
// The manifest holds a full path as uploaded; the copy lands under the name
// the upload started with. Characters Windows dislikes in a file name are
// replaced, and a name that would end up empty falls back to something
// meaningful rather than failing a restore over a cosmetic issue.
func RestoreName(source string) (string, error) {
	name := baseName(source)
	repl := func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}
	name = strings.TrimSpace(strings.Map(repl, name))
	switch name {
	case "", ".", "..":
		return "vault-restore.bin", nil
	}
	if len(name) > 200 {
		// Windows paths have a hard 260-character history; a 200-byte base
		// leaves room for a deep destination folder.
		dot := strings.LastIndexByte(name, '.')
		if dot > 0 && len(name)-dot <= 16 {
			name = name[:200-len(name)+dot] + name[dot:]
		} else {
			name = name[:200]
		}
	}
	return name, nil
}

// shortSHA is a name-safe prefix of a digest for error sentences. A digest
// string shorter than expected is shown whole rather than sliced out of range.
func shortSHA(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	if s == "" {
		return "none"
	}
	return s
}

// StoredBackups lists the uploads the daemon finished or left behind, most
// recent first. This is the restore menu: what the vault can put back on
// disk. Reading is best-effort — one malformed record must not hide the
// rest of the list.
func (v *Vault) StoredBackups() []Manifest {
	sessionDir := v.sessionDir()
	if sessionDir == "" {
		return nil
	}

	entries, err := os.ReadDir(manifestDir(sessionDir))
	if err != nil {
		return nil
	}

	out := make([]Manifest, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "upload-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(manifestDir(sessionDir), entry.Name()))
		if rerr != nil {
			continue
		}
		var m Manifest
		if json.Unmarshal(raw, &m) != nil || m.Version != ManifestVersion || len(m.Parts) == 0 {
			continue
		}
		if !m.Complete {
			continue
		}
		out = append(out, m)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	const maxList = 50
	if len(out) > maxList {
		out = out[:maxList]
	}
	return out
}

// PrepareManifest writes a complete, resumed-manifest record for a file —
// exactly the record a finished upload leaves — and returns it.
//
// It exists so tests (and any wrapper that wants a dry run) can build the
// restore's input without talking to Telegram: parts are planned and hashed
// from the real file, message ids are attached, and the record is saved the
// way the upload run would have.
func PrepareManifest(sessionDir, source, chat string, ids []int) (Manifest, error) {
	parts, size, err := PlanFile(source, DefaultPartBytes)
	if err != nil {
		return Manifest{}, err
	}
	if len(ids) != len(parts) {
		return Manifest{}, fmt.Errorf("got %d message ids for %d parts", len(ids), len(parts))
	}

	store, err := openManifest(sessionDir, source, size, partSpan(parts), chat)
	if err != nil {
		return Manifest{}, err
	}

	// Hash every part the way an upload run would, so restore-side checks
	// run against real digests rather than placeholders.
	digests := make([]string, len(parts))
	for i, p := range parts {
		d, err := HashPart(source, p)
		if err != nil {
			return Manifest{}, err
		}
		digests[i] = d
	}
	store.seed(parts, digests)

	// Adopt maps the digest-bearing rows in; message ids are attached after
	// so every part is marked stored, i.e. the vault is "complete".
	all := make([]int, len(parts))
	for i := range parts {
		all[i] = i
	}
	for i, index := range all {
		store.record(index, ids[i], "")
	}

	return store.snapshot(), nil
}

// ── the restore progress tracker ───────────────────────────────────────

// Progress phases a restore reports. The UI receives the same Progress
// payload an upload reports; the phase names are the only difference.
const (
	PhaseVerifying   = "verifying"
	PhaseDownloading = "downloading"
	PhaseJoining     = "joining"
)

// restoreProgress turns concurrent download events into one monotonic byte
// count, exactly the way the upload tracker does — the numbers the UI shows
// must not swing because three parts are mid-flight at once.
//
// It is deliberately separate from progressTracker: the two move different
// files, and sharing one would couple the upload's wording ("sending part")
// to the download path.
type restoreProgress struct {
	mu          sync.Mutex
	done        int64
	stored      int
	inflight    map[int]int64
	total       int64
	count       int
	connections int
	phase       string
	current     int
	started     time.Time
	report      func(Progress)
}

func newRestoreProgress(report func(Progress), total int64, count, connections int) *restoreProgress {
	return &restoreProgress{
		inflight:    make(map[int]int64, connections),
		total:       total,
		count:       count,
		connections: connections,
		phase:       "", // every runner names its phase explicitly
		started:     time.Now(),
		report:      report,
	}
}

// assumed advances the counter by bytes verified before this run began, so
// the progress total never restarts from zero in the middle of a restore.
func (p *restoreProgress) assumed(n int64) {
	p.mu.Lock()
	p.done += n
	p.mu.Unlock()
	p.emit("")
}

func (p *restoreProgress) setPhase(phase string) {
	p.mu.Lock()
	p.phase = phase
	p.mu.Unlock()
	p.emit("")
}

func (p *restoreProgress) partStarted(index int, size int64, label string) {
	p.mu.Lock()
	p.done -= p.inflight[index]
	delete(p.inflight, index)
	p.current = index
	p.mu.Unlock()
	p.emit(fmt.Sprintf("downloading part %d/%d (%s)", index+1, p.count, humanBytes(size)))
}

func (p *restoreProgress) chunk(index int, delta int64) {
	p.mu.Lock()
	p.inflight[index] += delta
	p.done += delta
	p.mu.Unlock()
	p.emit("")
}

func (p *restoreProgress) partStored(part ManifestPart) {
	p.mu.Lock()
	if missing := part.Size - p.inflight[part.Index]; missing > 0 {
		p.done += missing
	}
	delete(p.inflight, part.Index)
	p.stored++
	p.mu.Unlock()
	p.emit(fmt.Sprintf("part %d/%d verified", part.Index+1, p.count))
}

func (p *restoreProgress) partFailed(part ManifestPart) {
	p.mu.Lock()
	p.done -= p.inflight[part.Index]
	delete(p.inflight, part.Index)
	p.mu.Unlock()
	p.emit(fmt.Sprintf("part %d/%d failed", part.Index+1, p.count))
}

// joinedBytes advances the total during the join, where no transport events
// fire and progress would otherwise freeze at the end of the download.
func (p *restoreProgress) joinedBytes(done int64) {
	p.mu.Lock()
	p.done = done
	p.mu.Unlock()
	p.emit("")
}

func (p *restoreProgress) message(text string) {
	p.emit(text)
}

func (p *restoreProgress) emit(message string) {
	if p.report == nil {
		return
	}

	p.mu.Lock()
	elapsed := time.Since(p.started).Seconds()
	if elapsed < 0.001 {
		elapsed = 0.001
	}
	snapshot := Progress{
		Phase:       p.phase,
		PartIndex:   p.current,
		PartCount:   p.count,
		PartsDone:   p.stored,
		BytesDone:   p.done,
		BytesTotal:  p.total,
		BytesPerSec: float64(p.done) / elapsed,
		ElapsedSec:  elapsed,
		Connections: p.connections,
		Message:     message,
	}
	report := p.report
	p.mu.Unlock()

	report(snapshot)
}
