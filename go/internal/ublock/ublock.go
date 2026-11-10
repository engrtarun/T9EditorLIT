// Package ublock keeps the in-built browser's ad blocker current.
//
// The extension WebView2 loads is the **official release build of uBlock
// Origin Lite** (`uBlockOrigin/uBOL-home`). Lite is the Manifest V3 build:
// upstream uBlock Origin is Manifest V2, and Chromium 139 removed MV2
// entirely - the old extension still reported "loaded" while filtering
// nothing, which is exactly why YouTube ads came back. uBOL is the same
// filter lists in the only manifest the browser still runs.
//
// The daemon, not the webview, owns the download: the archive is fetched from
// the GitHub release, its SHA-256 is checked against the digest GitHub
// publishes, and only then is it unpacked. A tampered or truncated archive
// never reaches the extensions folder.
//
// The check runs at daemon start and every few hours after that, so a new
// release needs no user action. `Status` is the honest view the UI shows:
// which version is installed, which is latest, and why an update failed.
package ublock

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// ExtensionFolder is the name WebView2 sees. Wry iterates every entry in
	// the extensions path, so the parent holds exactly one folder.
	ExtensionFolder = "uBOLite.chromium"

	// ExtensionsFolder is a NEW folder, not the MV2 one. Pointing WebView2 at
	// a fresh path is what keeps a leftover MV2 uBlock (which the runtime now
	// refuses) from being scanned at all.
	ExtensionsFolder = "extensions-mv3"

	// legacyFolder is the dead MV2 extension. Best-effort deleted on start.
	legacyFolder = "uBlock0.chromium"

	// markerFile remembers which release is unpacked. It is written after the
	// folder swap, so "marker says vX" always means "vX is on disk".
	markerFile = "version.json"

	// maxZipBytes / maxUnzippedBytes bound a malformed or hostile archive.
	// The real uBOL asset is ~9 MB packed and ~30 MB unpacked.
	maxZipBytes      = 48 << 20
	maxUnzippedBytes = 96 << 20
	maxZipEntries    = 8000
)

// Var (not const) so tests can point at an httptest server.
var (
	apiURL     = "https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest"
	checkEvery = 6 * time.Hour
	// allowInsecure lets tests use http://127.0.0.1. Production stays https:
	// the digest protects the bytes, not the channel that named them.
	allowInsecure = false
)

// Status is the JSON the UI reads. Camel-case tags match the rest of the app.
type Status struct {
	// Enabled is the shipped default: the browser asks WebView2 for the
	// extension whenever the folder is present.
	Enabled bool `json:"enabled"`
	// Installed means the unpacked manifest is on disk and can be loaded.
	Installed bool `json:"installed"`
	// Version is the installed release tag ("1.76.0"), empty when absent.
	Version string `json:"version"`
	// LatestVersion is the newest GitHub release we saw.
	LatestVersion string `json:"latestVersion,omitempty"`
	// Path is the folder handed to WebView2; ExtensionDir is the unpacked
	// extension itself.
	Path         string `json:"path"`
	ExtensionDir string `json:"extensionDir"`
	// Updating is true while a check/download is in flight.
	Updating bool `json:"updating"`
	// AutoUpdate is always true: the check is built in, not a setting.
	AutoUpdate bool `json:"autoUpdate"`
	// CheckedAt is the last successful (or attempted) GitHub check.
	CheckedAt string `json:"checkedAt,omitempty"`
	// Error is the last failure, already turned into a sentence the user can
	// act on. It is cleared by the next success.
	Error string `json:"error,omitempty"`
}

type marker struct {
	Version     string `json:"version"`
	InstalledAt string `json:"installedAt"`
	Source      string `json:"source"`
	SHA256      string `json:"sha256"`
}

type asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
	URL    string `json:"browser_download_url"`
}

type release struct {
	TagName string  `json:"tag_name"`
	Assets  []asset `json:"assets"`
}

// Updater owns the on-disk extension. One per daemon.
type Updater struct {
	dir    string
	client *http.Client
	log    *slog.Logger

	mu sync.Mutex
	st Status
}

// New prepares the folder (but does not download anything yet).
func New(dir string, log *slog.Logger) *Updater {
	if log == nil {
		log = slog.Default()
	}
	ext := filepath.Join(dir, ExtensionsFolder)
	_ = os.MkdirAll(ext, 0o755)
	u := &Updater{
		dir: dir,
		client: &http.Client{
			Timeout: 90 * time.Second,
		},
		log: log,
	}
	u.st = u.readStatus()
	u.dropLegacy()
	return u
}

// dropLegacy removes the MV2 extension folder. Chromium 139+ refuses MV2, and
// leaving it behind is how "uBlock is loaded" and "YouTube still shows ads"
// were both true. Best-effort: an app still running may hold the folder open,
// in which case the next daemon start finishes the job.
func (u *Updater) dropLegacy() {
	legacy := filepath.Join(u.dir, "extensions", legacyFolder)
	if _, err := os.Stat(legacy); err != nil {
		return
	}
	if err := os.RemoveAll(legacy); err != nil {
		u.log.Info("legacy MV2 uBlock folder still in use", "path", legacy, "err", err)
		return
	}
	u.log.Info("legacy MV2 uBlock removed", "path", legacy)
}

// DefaultDir is `%LocalAppData%\T9EditorLIT\ublock` on Windows and the user
// cache elsewhere. The Rust side resolves the same folder independently, so
// neither process has to ask the other before creating a webview.
func DefaultDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "T9EditorLIT", "ublock")
}

// ExtensionsPath is what WebView2 is pointed at: a folder whose children are
// unpacked Chrome extensions.
func (u *Updater) ExtensionsPath() string { return filepath.Join(u.dir, ExtensionsFolder) }

// ExtensionDir is the unpacked uBlock itself.
func (u *Updater) ExtensionDir() string {
	return filepath.Join(u.ExtensionsPath(), ExtensionFolder)
}

// Status returns the current view without touching the network.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.st
}

// Start performs one check now and then on every `checkEvery` tick. A failure
// is recorded in Status and retried on the next tick; it never crashes the
// daemon and never blocks a download.
func (u *Updater) Start(ctx context.Context) {
	go func() {
		u.ensure(ctx)
		t := time.NewTicker(checkEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				u.ensure(ctx)
			}
		}
	}()
}

// UpdateNow starts a check in the background (the HTTP handler must not wait
// for GitHub). The UI polls Status for the result.
func (u *Updater) UpdateNow(ctx context.Context) Status {
	if u.claim() {
		// The HTTP response ends the moment this returns, which cancels the
		// request context - the goroutine would then see `context canceled`
		// before GitHub answered (that was the error the panel showed).
		// Detach from the request and give the job its own bound instead.
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
		go func() {
			defer cancel()
			u.run(bg)
		}()
	}
	return u.Status()
}

// claim marks a check as in flight. Returning false means one already is; the
// caller must not start a second GitHub call. The claim and the check are two
// steps because `run` is also reached from the ticker, and a boolean checked
// *after* setting it would make every manual update a no-op.
func (u *Updater) claim() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.st.Updating {
		return false
	}
	u.st.Updating = true
	return true
}

func (u *Updater) ensure(ctx context.Context) {
	if !u.claim() {
		return
	}
	u.run(ctx)
}

// run performs one check/install and always clears the in-flight flag, even on
// failure, so the UI's spinner can never stick.
func (u *Updater) run(ctx context.Context) {
	defer func() {
		u.mu.Lock()
		u.st.Updating = false
		u.mu.Unlock()
	}()

	if err := u.checkAndInstall(ctx); err != nil {
		u.log.Warn("uBlock update check failed", "err", err)
		u.mu.Lock()
		u.st.Error = err.Error()
		u.st.CheckedAt = time.Now().Format(time.RFC3339)
		st := u.readStatusLocked()
		st.Error = u.st.Error
		st.CheckedAt = u.st.CheckedAt
		st.Updating = false
		u.st = st
		u.mu.Unlock()
		return
	}
	u.mu.Lock()
	u.st = u.readStatusLocked()
	u.mu.Unlock()
}

// checkAndInstall is the whole pipeline: ask GitHub, compare, download, verify,
// unpack, swap. Exported only to tests via the same package.
func (u *Updater) checkAndInstall(ctx context.Context) error {
	rel, err := u.latest(ctx)
	if err != nil {
		return err
	}
	version := strings.TrimPrefix(rel.TagName, "v")
	if version == "" {
		return errors.New("GitHub release ka version khaali hai")
	}

	asset, ok := pickAsset(rel)
	if !ok {
		return fmt.Errorf("uBlock Origin Lite %s me chromium zip nahi mila", version)
	}

	current := u.readMarker()
	if current.Version == version && manifestExists(u.ExtensionDir()) {
		u.mu.Lock()
		u.st.LatestVersion = version
		u.st.CheckedAt = time.Now().Format(time.RFC3339)
		u.st.Error = ""
		u.st.Path = u.ExtensionsPath()
		u.st.ExtensionDir = u.ExtensionDir()
		u.st.Installed = true
		u.st.Version = current.Version
		u.mu.Unlock()
		return nil
	}

	zipPath, sum, err := u.download(ctx, asset.URL, asset.Digest, asset.Size)
	if err != nil {
		return err
	}
	defer os.Remove(zipPath)

	tmp, err := os.MkdirTemp(u.dir, "unpack-*")
	if err != nil {
		return fmt.Errorf("temp folder: %w", err)
	}
	defer os.RemoveAll(tmp)

	target := filepath.Join(tmp, ExtensionFolder)
	if err := unzip(zipPath, target); err != nil {
		return err
	}
	if !manifestExists(target) {
		return errors.New("zip me manifest.json nahi hai - archive adhoora lagta hai")
	}
	if err := u.swap(target); err != nil {
		return err
	}
	if err := writeMarker(u.dir, marker{
		Version:     version,
		InstalledAt: time.Now().Format(time.RFC3339),
		Source:      asset.URL,
		SHA256:      sum,
	}); err != nil {
		return err
	}

	u.log.Info("uBlock Origin Lite installed", "version", version, "sha256", sum)
	u.dropLegacy()
	u.mu.Lock()
	u.st = u.readStatusLocked()
	u.mu.Unlock()
	return nil
}

func pickAsset(rel *release) (asset, bool) {
	for _, a := range rel.Assets {
		if strings.HasSuffix(a.Name, ".chromium.zip") {
			return a, true
		}
	}
	return asset{}, false
}

func (u *Updater) latest(ctx context.Context) (*release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "t9cloud-ublock")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := u.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub tak nahi pahuncha: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("GitHub ne %d diya: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var rel release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("GitHub ka jawab samajh nahi aaya: %w", err)
	}
	return &rel, nil
}

// download streams the asset to a temp file and returns its SHA-256. The
// digest GitHub publishes is the gate: a mismatch deletes the file and fails
// the update, so an intercepted or truncated download cannot be unpacked.
func (u *Updater) download(ctx context.Context, rawURL, digest string, size int64) (string, string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http")) {
		return "", "", fmt.Errorf("asset URL https nahi hai: %q", rawURL)
	}
	if size > maxZipBytes {
		return "", "", fmt.Errorf("asset bahut bada hai (%d bytes)", size)
	}
	want := strings.TrimPrefix(strings.TrimSpace(digest), "sha256:")
	if len(want) != 64 {
		return "", "", errors.New("GitHub ne asset ka SHA-256 nahi diya - verify nahi kar sakte")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "t9cloud-ublock")

	resp, err := u.client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("uBlock download fail: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("uBlock download ne %d diya", resp.StatusCode)
	}

	f, err := os.CreateTemp(u.dir, "ublock-*.zip")
	if err != nil {
		return "", "", err
	}
	path := f.Name()
	defer func() {
		if f != nil {
			f.Close()
		}
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxZipBytes+1))
	if err != nil {
		f.Close()
		f = nil
		os.Remove(path)
		return "", "", fmt.Errorf("uBlock download adhoora: %w", err)
	}
	if n > maxZipBytes {
		f.Close()
		f = nil
		os.Remove(path)
		return "", "", errors.New("uBlock archive allowed size se bada hai")
	}
	if err := f.Close(); err != nil {
		f = nil
		os.Remove(path)
		return "", "", err
	}
	f = nil

	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, want) {
		os.Remove(path)
		return "", "", fmt.Errorf("SHA-256 match nahi hua (milA %s, chahiye %s)", got, want)
	}
	return path, got, nil
}

// unzip extracts exactly the files a Chrome extension needs, refusing any
// path that would escape `dest`. A release archive is trusted by digest, but
// the traversal check is cheap and means a future mirror cannot write outside
// the app's own folder.
func unzip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("zip khol nahi paya: %w", err)
	}
	defer r.Close()
	if len(r.File) > maxZipEntries {
		return fmt.Errorf("zip me bahut entries hain (%d)", len(r.File))
	}

	// Find the archive root: uBOL packs manifest.json at the top level, while
	// some release builds nest everything under one folder. Extracting
	// relative to the folder that holds manifest.json means the extension
	// always lands at dest/manifest.json, whichever shape shipped.
	prefix := ""
	rootManifest := false
	for _, f := range r.File {
		name := filepath.ToSlash(f.Name)
		if name == "manifest.json" {
			rootManifest = true
			break
		}
	}
	if !rootManifest {
		for _, f := range r.File {
			name := filepath.ToSlash(f.Name)
			if !strings.HasSuffix(name, "/manifest.json") {
				continue
			}
			dir := strings.TrimSuffix(name, "/manifest.json")
			if dir != "" && !strings.Contains(dir, "/") {
				prefix = dir + "/"
			}
			break
		}
		if prefix == "" {
			return errors.New("zip me manifest.json nahi hai - archive adhoora lagta hai")
		}
	}

	var total int64
	for _, f := range r.File {
		rel := strings.TrimPrefix(filepath.ToSlash(f.Name), prefix)
		if rel == "" || strings.HasSuffix(rel, "/") {
			continue
		}
		if strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) {
			return fmt.Errorf("zip me khatarnak path hai: %q", f.Name)
		}
		total += int64(f.UncompressedSize64)
		if total > maxUnzippedBytes {
			return errors.New("zip unpack hone par bahut bada hai")
		}

		out := filepath.Join(dest, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(w, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		closeErr := w.Close()
		rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// swap replaces the live extension with the freshly unpacked one. Windows
// cannot rename over a non-empty folder, so the old one steps aside first and
// is restored if the new one cannot take its place.
func (u *Updater) swap(staged string) error {
	live := u.ExtensionDir()
	old := live + ".old"
	_ = os.RemoveAll(old)
	if _, err := os.Stat(live); err == nil {
		if err := os.Rename(live, old); err != nil {
			return fmt.Errorf("purana uBlock hataya nahi gaya: %w", err)
		}
	}
	if err := os.Rename(staged, live); err != nil {
		_ = os.Rename(old, live)
		return fmt.Errorf("naya uBlock laga nahi paya: %w", err)
	}
	_ = os.RemoveAll(old)
	return nil
}

func manifestExists(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "manifest.json"))
	return err == nil && !st.IsDir()
}

func (u *Updater) readMarker() marker {
	b, err := os.ReadFile(filepath.Join(u.dir, markerFile))
	if err != nil {
		return marker{}
	}
	var m marker
	if json.Unmarshal(b, &m) != nil {
		return marker{}
	}
	return m
}

func writeMarker(dir string, m marker) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, markerFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, markerFile))
}

// readStatus computes the on-disk truth. Called with no lock.
func (u *Updater) readStatus() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.readStatusLocked()
}

func (u *Updater) readStatusLocked() Status {
	m := u.readMarker()
	st := u.st
	stdir := u.ExtensionDir()
	st.Enabled = true
	st.AutoUpdate = true
	st.Path = u.ExtensionsPath()
	st.ExtensionDir = stdir
	st.Installed = manifestExists(stdir)
	st.Version = m.Version
	if !st.Installed {
		st.Version = ""
	}
	return st
}
