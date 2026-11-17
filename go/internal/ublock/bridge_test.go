package ublock

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPatchBridgeAddsContentScriptOnce(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"manifest_version":3,"name":"uBO Lite","action":{"default_popup":"popup.html"}}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := PatchBridge(dir); err != nil {
		t.Fatalf("PatchBridge: %v", err)
	}

	// The bridge file exists and carries the wire tag.
	script, err := os.ReadFile(filepath.Join(dir, BridgeFile))
	if err != nil {
		t.Fatalf("bridge file missing: %v", err)
	}
	if !strings.Contains(string(script), "__t9ublock") || !strings.Contains(string(script), "setFilteringMode") {
		t.Fatalf("bridge script lacks the wire protocol")
	}

	// The manifest now declares it exactly once.
	raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	var m struct {
		ContentScripts []struct {
			JS []string `json:"js"`
		} `json:"content_scripts"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("manifest broke: %v", err)
	}
	count := 0
	for _, cs := range m.ContentScripts {
		for _, f := range cs.JS {
			if f == BridgeFile {
				count++
			}
		}
	}
	if count != 1 {
		t.Fatalf("bridge declared %d times, want 1", count)
	}
}

func TestPatchBridgeIsIdempotentAndRewritesOnVersionChange(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"manifest_version":3}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PatchBridge(dir); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))

	// Second call with the same version must not duplicate the entry.
	if err := PatchBridge(dir); err != nil {
		t.Fatalf("second PatchBridge: %v", err)
	}
	second, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if string(first) != string(second) {
		t.Fatalf("idempotent patch changed the manifest")
	}

	// A different required version rewrites the marker (future-proofing).
	if err := os.WriteFile(filepath.Join(dir, bridgeMarker), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PatchBridge(dir); err != nil {
		t.Fatalf("version bump patch: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, bridgeMarker))
	if strings.TrimSpace(string(b)) != bridgeVersion {
		t.Fatalf("marker = %q, want %q", b, bridgeVersion)
	}
}

func TestPatchBridgeRejectsMissingManifest(t *testing.T) {
	if err := PatchBridge(t.TempDir()); err == nil {
		t.Fatal("expected an error when manifest.json is absent")
	}
}

// The worker patch is what gives zapper/picker a path: a content script has no
// chrome.scripting, the worker does, and the sender already carries tabId.
func TestPatchBackgroundAddsExecuteScriptsCaseOnce(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := "async function onMessage(request, sender) {\n" +
		"    switch ( request.what ) {\n" +
		"    case 'startCustomFilters':\n" +
		"        return startCustomFilters(tabId, frameId);\n" +
		"    }\n}\n"
	path := filepath.Join(dir, "js", "background.js")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := PatchBackground(dir); err != nil {
		t.Fatalf("PatchBackground: %v", err)
	}
	first, _ := os.ReadFile(path)
	if !strings.Contains(string(first), "case 't9ExecuteScripts'") {
		t.Fatal("t9ExecuteScripts case missing")
	}
	if !strings.Contains(string(first), "browser.scripting.executeScript") {
		t.Fatal("injection call missing")
	}
	// Order: our case must come before the anchor it is inserted in front of.
	ourAt := strings.Index(string(first), "case 't9ExecuteScripts'")
	anchorAt := strings.Index(string(first), backgroundAnchor)
	if ourAt < 0 || anchorAt < 0 || ourAt > anchorAt {
		t.Fatal("case inserted after the anchor, not before it")
	}

	// Running it again must not duplicate the case.
	if err := PatchBackground(dir); err != nil {
		t.Fatalf("second PatchBackground: %v", err)
	}
	second, _ := os.ReadFile(path)
	if strings.Count(string(second), "case 't9ExecuteScripts'") != 1 {
		t.Fatal("worker patch applied more than once")
	}
	if string(first) != string(second) {
		t.Fatal("idempotent worker patch changed the file")
	}
}

func TestPatchBackgroundReportsMissingAnchor(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "js", "background.js"), []byte("// different upstream\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PatchBackground(dir); err == nil {
		t.Fatal("expected an error when the anchor is gone")
	}
}

func TestBridgeScriptCarriesOnlyAllowlistedInjection(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"manifest_version":3}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PatchBridge(dir); err != nil {
		t.Fatal(err)
	}
	script, _ := os.ReadFile(filepath.Join(dir, BridgeFile))
	s := string(script)
	for _, want := range []string{"SCRIPT_ALLOWLIST", "/js/scripting/zapper.js", "/js/scripting/picker.js", "t9RunFiles"} {
		if !strings.Contains(s, want) {
			t.Fatalf("bridge lacks %q", want)
		}
	}
	// The bridge must not proxy privileged actions from a page sender.
	if strings.Contains(s, "applyRulesets") {
		t.Fatal("bridge must not forward trusted-origin-only actions")
	}
}
