package api

// Endpoint-level tests for the vault restore seam (api/vault_restore.go).
//
// The deep restore logic lives in vault/restore_test.go with a fake transport;
// here the contract is the HTTP face: the menu answers before Telegram exists,
// the download button refuses while the user is looking at it, and an accepted
// restore is a real job of kind "restore".

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// restoreServer is a test server whose vault carries a session directory the
// caller can fill with upload manifests.
func restoreServer(t *testing.T, up vault.Uploader) (*Server, string) {
	t.Helper()

	s, _ := newTestServer(t, baseConfig(), nil)
	sessionDir := t.TempDir()
	s.deps.Vault = &vault.Vault{
		Uploader:   up,
		PartSize:   vault.DefaultPartBytes,
		ChatID:     "@cloud",
		SessionDir: sessionDir,
	}
	return s, sessionDir
}

// prepareVaultSource writes a small file and records its upload manifest the
// way a finished backup leaves it — real digests, real message id, complete.
func prepareVaultSource(t *testing.T, sessionDir string) (string, vault.Manifest) {
	t.Helper()

	source := filepath.Join(t.TempDir(), "clip.mp4")
	buf := make([]byte, 70_000)
	for i := range buf {
		buf[i] = byte(i * 3)
	}
	if err := os.WriteFile(source, buf, 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := vault.PrepareManifest(sessionDir, source, "@cloud", []int{7001})
	if err != nil {
		t.Fatalf("PrepareManifest: %v", err)
	}
	return source, m
}

func TestVaultManifestsAnswerBeforeTelegramExists(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodGet, "/v1/vault/manifests", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with an empty menu", rec.Code)
	}
	var got struct {
		Manifests []vault.Manifest `json:"manifests"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Manifests) != 0 {
		t.Errorf("menu holds %d entries before any upload, want 0", len(got.Manifests))
	}
}

func TestVaultManifestsListPreparedUploads(t *testing.T) {
	s, sessionDir := restoreServer(t, &authorisedUploader{})
	source, _ := prepareVaultSource(t, sessionDir)

	rec := do(t, s, http.MethodGet, "/v1/vault/manifests", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		Manifests []vault.Manifest `json:"manifests"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Manifests) != 1 {
		t.Fatalf("menu holds %d entries, want 1", len(got.Manifests))
	}
	if !strings.EqualFold(got.Manifests[0].Source, source) {
		t.Errorf("source = %q, want %q", got.Manifests[0].Source, source)
	}
	if len(got.Manifests[0].Parts) != 1 {
		t.Errorf("parts = %d, want 1", len(got.Manifests[0].Parts))
	}
}

func TestVaultDownloadRequiresFields(t *testing.T) {
	s, sessionDir := restoreServer(t, &authorisedUploader{})
	source, _ := prepareVaultSource(t, sessionDir)

	rec := do(t, s, http.MethodPost, "/v1/vault/download",
		jsonBody(t, map[string]string{"source_path": source}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "dest_dir") {
		t.Errorf("error should name the missing field, got %s", rec.Body.String())
	}
}

func TestVaultDownloadRefusedWithoutAuthorisation(t *testing.T) {
	s, sessionDir := restoreServer(t, &stubUploader{})
	source, _ := prepareVaultSource(t, sessionDir)

	rec := do(t, s, http.MethodPost, "/v1/vault/download",
		jsonBody(t, map[string]string{"source_path": source, "dest_dir": t.TempDir()}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 before the login exists", rec.Code)
	}
}

func TestVaultDownloadUnknownSourceIs404(t *testing.T) {
	s, sessionDir := restoreServer(t, &authorisedUploader{})
	prepareVaultSource(t, sessionDir)

	rec := do(t, s, http.MethodPost, "/v1/vault/download",
		jsonBody(t, map[string]string{
			"source_path": `D:\never\uploaded.mp4`,
			"dest_dir":    t.TempDir(),
		}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for a path the vault never backed up", rec.Code)
	}
}

// An accepted restore is a real job of kind "restore". With a transport that
// cannot fetch, the job must fail with the capability sentence rather than
// hang or pretend success — the offline stand-in for a refusing transport.
func TestVaultDownloadQueuesRestoreJob(t *testing.T) {
	s, sessionDir := restoreServer(t, &authorisedUploader{})
	source, _ := prepareVaultSource(t, sessionDir)

	rec := do(t, s, http.MethodPost, "/v1/vault/download",
		jsonBody(t, map[string]string{"source_path": source, "dest_dir": t.TempDir()}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if job.Kind != model.JobRestore {
		t.Errorf("kind = %q, want %q", job.Kind, model.JobRestore)
	}
	if job.Total != 1 {
		t.Errorf("total parts = %d, want 1", job.Total)
	}

	final := waitForJob(t, s, job.ID)
	if final.State != model.StateFailed {
		t.Fatalf("state = %q, want failed for a transport with no capability", final.State)
	}
	if !strings.Contains(final.Error, "cannot fetch") {
		t.Errorf("error should carry the capability refusal, got %q", final.Error)
	}
}
