package api

// Import-gate and creator-vocabulary endpoints.
//
// These are deliberately synchronous and small: a probe is one ffprobe run, a
// layout pass is a dozen seeked frames, and the lexicon is a few hundred bytes
// of JSON. The one long operation - remux - is a job, because it is disk-bound
// on a 5 GB source and the UI already knows how to poll a job.

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/mediaprobe"
	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/postpass"
)

// handleMediaProbe answers "what is this file, really?" before editing starts.
func (s *Server) handleMediaProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source file not found"})
		return
	}

	rep, err := mediaprobe.Probe(r.Context(), path)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleMediaRemux starts a lossless repair copy (case 27).
//
// It returns a job, not a path: a stream copy of a 5 GB file is fast but not
// instant, and the UI already has a progress row for jobs. The result lives in
// the user cache so "repair" can never overwrite or move the imported file.
func (s *Server) handleMediaRemux(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source file not found"})
		return
	}

	job := s.store.create(model.JobRemux, 1)
	outDir := strings.TrimSpace(s.deps.CacheDir)
	log := s.deps.Log
	go func() {
		s.store.start(job.ID)
		out, err := mediaprobe.Remux(context.Background(), path, outDir)
		if err != nil {
			log.Error("remux failed", "job", job.ID, "path", path, "err", err)
			s.store.fail(job.ID, err)
			return
		}
		log.Info("remux finished", "job", job.ID, "source", path, "output", out)
		s.store.succeedRemux(job.ID, out)
	}()
	writeJSON(w, http.StatusAccepted, job)
}

// handleMediaLayout measures the static/busy regions of the picture.
//
// It is the same pass for case 37 (face-cam) and case 38 (watermark/banner):
// a static corner is a watermark-like overlay, a much busier corner is a
// face-cam-like overlay. The result is metadata for the UI - never a crop, a
// blur or a deletion.
func (s *Server) handleMediaLayout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path         string  `json:"path"`
		DurationSecs float64 `json:"duration_secs"`
		Samples      int     `json:"samples"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source file not found"})
		return
	}

	duration := req.DurationSecs
	if duration <= 0 {
		rep, err := mediaprobe.Probe(r.Context(), path)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		if rep.AudioOnly || rep.Video == nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "audio-only source has no picture to analyse"})
			return
		}
		duration = rep.DurationSecs
	}
	if duration <= 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "source duration is unknown"})
		return
	}

	// Twelve seeked keyframes, not a full decode. The timeout is generous for
	// a network drive and still bounded on a 50-minute 4K file.
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	grid, err := mediaprobe.SampleGrid(ctx, path, duration, req.Samples)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleLexiconList returns the creator vocabulary.
func (s *Server) handleLexiconList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"entries": s.lexiconEntries()})
}

// handleLexiconSave replaces the creator vocabulary.
func (s *Server) handleLexiconSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Entries []postpass.Entry `json:"entries"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if s.deps.Lexicon == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lexicon store is not available"})
		return
	}
	if err := s.deps.Lexicon.Replace(req.Entries); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": s.lexiconEntries()})
}

// lexiconEntries is nil-safe: a test server without a store simply has no
// vocabulary, and every pass treats that as "nothing to apply".
func (s *Server) lexiconEntries() []postpass.Entry {
	if s.deps.Lexicon == nil {
		return nil
	}
	return s.deps.Lexicon.List()
}
