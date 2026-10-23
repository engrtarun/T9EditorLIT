package api

// vault_restore.go — the read half of the vault at the HTTP seam.
//
// Upload turned a file into parts in a Telegram chat and left a manifest
// behind with digests and message ids. Restore is the other direction, and
// these two endpoints are its whole face:
//
//	GET  /v1/vault/manifests   the restore menu: what can come back
//	POST /v1/vault/download    stream one back onto disk as a job
//
// The download endpoint answers 202 with a job; the job drains into the same
// progress store uploads use (Phase, PartsDone, BytesPerSec), so the UI can
// render a restore like any other vault transfer.

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// handleVaultManifests lists the completed uploads the vault can restore.
//
// It answers even with no transport — an empty menu, not an error — because
// the UI shows this screen before Telegram is ever configured and there is
// nothing exceptional about not having backed anything up yet.
func (s *Server) handleVaultManifests(w http.ResponseWriter, r *http.Request) {
	if s.deps.Vault == nil || s.deps.Vault.Uploader == nil {
		writeJSON(w, http.StatusOK, map[string]any{"manifests": []vault.Manifest{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"manifests": s.deps.Vault.StoredBackups()})
}

// handleVaultDownload queues a restore job.
//
// Refusals happen before the job exists, for the same reason uploads refuse
// early: a restore that fails after forty minutes of downloading teaches the
// user nothing. The chat is taken from the manifest rather than the config —
// the parts live in the chat they were uploaded to, whatever
// TELEGRAM_TARGET_CHAT points at right now.
func (s *Server) handleVaultDownload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SourcePath string `json:"source_path"`
		DestDir    string `json:"dest_dir"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	switch {
	case req.SourcePath == "":
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "source_path is required — pick a source from /v1/vault/manifests",
		})
		return
	case req.DestDir == "":
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "dest_dir is required — choose where the restored file should land",
		})
		return
	}

	if s.deps.Vault == nil || s.deps.Vault.Uploader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": vault.ErrNotConfigured.Error(),
		})
		return
	}
	if !s.deps.Vault.Uploader.Authorised() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": vault.ErrNotAuthorised.Error(),
		})
		return
	}

	manifest, ok := s.findVaultManifest(req.SourcePath)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "no completed vault upload for " + req.SourcePath,
		})
		return
	}
	if manifest.Chat == "" && s.deps.Vault.ChatID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "the manifest and the daemon both name no Telegram chat to read the parts from",
		})
		return
	}

	job := s.store.create(model.JobRestore, len(manifest.Parts))

	// A per-job copy, exactly like uploads: the shared Vault must not carry
	// two jobs' progress streams at once.
	v := *s.deps.Vault
	v.OnProgress = func(p vault.Progress) {
		s.store.progressVault(job.ID, p)
	}

	// The restore outlives the HTTP request: a browser tab closing
	// mid-download must not abandon 1.9 GB that is already proven on disk.
	detached := context.WithoutCancel(r.Context())

	err := s.deps.Queue.Submit(r.Context(), queue.Task{
		ID: job.ID,
		Run: func(ctx context.Context) error {
			chat := manifest.Chat
			if chat == "" {
				chat = v.ChatID
			}
			dest, err := v.Restore(detached, manifest, req.DestDir)
			if err != nil {
				return err
			}
			s.store.finishRestore(job.ID, chat, manifest.SourceSize, dest, len(manifest.Parts))
			return nil
		},
	})
	if err != nil {
		s.store.fail(job.ID, err)
		writeQueueError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, job)
}

// findVaultManifest locates a completed upload manifest by its recorded
// source path, case- and separator-insensitively: the manifest holds an
// absolute Windows path and the app may send back a different casing than
// the drive reports.
func (s *Server) findVaultManifest(sourcePath string) (vault.Manifest, bool) {
	want := strings.ToLower(filepath.Clean(sourcePath))
	for _, m := range s.deps.Vault.StoredBackups() {
		if strings.ToLower(filepath.Clean(m.Source)) == want {
			return m, true
		}
	}
	return vault.Manifest{}, false
}
