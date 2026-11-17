// Package ublock — the T9 control bridge inside uBlock Origin Lite.
//
// uBOL's real controls (filtering-mode slider, zapper, element picker) live in
// its extension context: they are reached with chrome.runtime.sendMessage,
// chrome.tabs and chrome.scripting, none of which a web page may call. Opening
// the extension's own popup would mean a second WebView2 webview — tens of MB
// on an 8 GB box — for a popup that is open for two seconds.
//
// Instead we add ONE tiny content script plus a six-line case in uBOL's
// background service worker. WebView2 injects the content script into every
// tab alongside uBOL's own scripts. It is the only new code, it is a few KB,
// and it adds no webview and no long-lived process.
//
// Why a content script can reach uBOL's background at all: content scripts run
// in the extension's own context, so chrome.runtime.sendMessage goes to the
// extension that injected them (uBOL), and sender.tab/sender.frameId identify
// the exact tab/frame the request came from — better than the popup, which has
// to guess with tabs.query.
//
// Why a background patch is still needed: content scripts do NOT have
// chrome.scripting, and the zapper/picker are injected with it. uBOL's
// background does have it, and its onMessage already derives tabId/frameId
// from the sender. A single `t9ExecuteScripts` case lets the bridge ask the
// worker to inject the same five files the popup injects, in the same tab.
//
// The wire format is deliberate and versioned:
//
//	page (main world)  --postMessage({ __t9ublock: 1, id, msg })-->  bridge
//	bridge (isolated)  --chrome.runtime.sendMessage(msg)---------->  uBOL
//	bridge             --postMessage({ __t9ublock: 1, id, response })--> page
//	page shim          --chrome.webview.postMessage({t9:'ublock',...})--> Rust
//	Rust               --emit('browser:ublock', response)-------------> Svelte
//
// Both sides use window.postMessage, which crosses the main/isolated world
// boundary. The bridge never touches chrome.webview (not available in an
// isolated world); the page shim owns that hop.
package ublock

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// BridgeFile is the content script we add under the extension folder.
const BridgeFile = "t9-bridge.js"

// bridgeMarker records that the content-script patch was applied, so a
// re-unpack can check and a future version can replace it if the wire format
// changes.
const bridgeMarker = "t9-bridge-version"

// bridgeVersion must change only when the page/Rust side must change too.
const bridgeVersion = "1"

// backgroundAnchor is the exact uBOL line the worker patch is inserted before.
// It sits inside onMessage's first switch — the block that runs BEFORE the
// trusted-origin gate — so a content-script sender is allowed through.
const backgroundAnchor = "    case 'startCustomFilters':"

// backgroundPatch is the only change inside uBOL's worker: inject a caller-
// supplied, allowlisted set of scripting files into the sender's tab. uBOL's
// own popup does exactly this with chrome.scripting plus tabs.query; using the
// sender's tabId is both smaller and race-free.
const backgroundPatch = `    case 't9ExecuteScripts': {
        if ( frameId === false ) { return; }
        return browser.scripting.executeScript({
            files: request.files,
            target: { tabId },
        }).catch(reason => {
            ubolLog('t9ExecuteScripts/' + reason);
        });
    }

`

// The bridge itself. Kept dependency-free: it runs before any page script and
// must never throw into the host page. Every sendMessage has a reply (uBOL's
// handlers answer, including on error), and an overdue request is answered
// with an error so the UI never spins forever.
const bridgeSource = `(() => {
  'use strict';
  if (window.__t9UbBridge) return;
  window.__t9UbBridge = true;

  const TAG = '__t9ublock';
  const VERSION = '__T9_BRIDGE_VERSION__';

  // Only these scripting files may be injected, and only by their exact uBOL
  // paths. A compromised or buggy page cannot turn the bridge into a generic
  // script runner.
  const SCRIPT_ALLOWLIST = [
    '/js/scripting/tool-overlay.js',
    '/js/scripting/zapper.js',
    '/js/scripting/css-procedural-api.js',
    '/js/scripting/picker.js',
    '/js/scripting/unpicker.js'
  ];

  // uBOL actions that its worker answers before the trusted-origin gate. A
  // content script's sender.origin is the page URL, so anything after that
  // gate (ruleset changes, config writes, ...) is deliberately NOT proxied.
  const FORWARDED = [
    'popupPanelData',
    'getFilteringMode',
    'setFilteringMode'
  ];

  // Content scripts live in an isolated world but share window with the
  // page. postMessage is the one primitive that crosses that boundary.
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d[TAG] !== 1 || d.dir !== 'req' || typeof d.id !== 'string') return;
    const reply = (ok, response) => {
      try {
        window.postMessage({ [TAG]: 1, dir: 'resp', id: d.id, ok, response }, '*');
      } catch (_) {}
    };
    try {
      const msg = d.msg || {};
      const what = String(msg.what || '');
      let result;
      if (what === 'ping') {
        result = { ok: true, version: VERSION };
      } else if (what === 't9RunFiles') {
        const files = Array.isArray(msg.files) ? msg.files.map(String) : [];
        if (files.length === 0) throw new Error('files khaali hai');
        for (const f of files) {
          if (SCRIPT_ALLOWLIST.includes(f) === false) throw new Error('file allowlist me nahi: ' + f);
        }
        result = await chrome.runtime.sendMessage({ what: 't9ExecuteScripts', files });
      } else if (FORWARDED.includes(what)) {
        const payload = { what };
        if (typeof msg.hostname === 'string') payload.hostname = msg.hostname;
        if (typeof msg.origin === 'string') payload.origin = msg.origin;
        if (typeof msg.level === 'number') payload.level = msg.level;
        result = await chrome.runtime.sendMessage(payload);
      } else {
        throw new Error('unknown action: ' + what);
      }
      reply(true, result === undefined ? null : result);
    } catch (err) {
      reply(false, String(err && err.message ? err.message : err));
    }
  });
})();
`

var manifestBridgeEntry = map[string]any{
	"matches":    []string{"http://*/*", "https://*/*"},
	"js":         []string{BridgeFile},
	"run_at":     "document_start",
	"all_frames": false,
}

// PatchBridge adds the bridge content script to an unpacked uBOL folder. It is
// idempotent: a second call with the same version is a no-op, and a different
// version rewrites the script + manifest entry. Called after every unzip/swap
// and once at daemon start, so a uBOL auto-update cannot silently drop it.
func PatchBridge(dir string) error {
	if dir == "" {
		return errors.New("extension folder khaali hai")
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("manifest padha nahi gaya: %w", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return fmt.Errorf("manifest JSON nahi hai: %w", err)
	}

	// Idempotent by marker file. Keep the script in step with bridgeVersion.
	markerPath := filepath.Join(dir, bridgeMarker)
	if b, err := os.ReadFile(markerPath); err == nil && strings.TrimSpace(string(b)) == bridgeVersion {
		if _, err := os.Stat(filepath.Join(dir, BridgeFile)); err == nil {
			return nil
		}
	}

	script := strings.ReplaceAll(bridgeSource, "__T9_BRIDGE_VERSION__", bridgeVersion)
	if err := os.WriteFile(filepath.Join(dir, BridgeFile), []byte(script), 0o644); err != nil {
		return fmt.Errorf("bridge likha nahi gaya: %w", err)
	}

	scripts, _ := manifest["content_scripts"].([]any)
	found := false
	for _, item := range scripts {
		obj, _ := item.(map[string]any)
		if obj == nil {
			continue
		}
		js, _ := obj["js"].([]any)
		for _, f := range js {
			if s, _ := f.(string); s == BridgeFile {
				found = true
				break
			}
		}
		if found {
			break
		}
	}
	if !found {
		manifest["content_scripts"] = append(scripts, manifestBridgeEntry)
		out, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			return fmt.Errorf("manifest likha nahi gaya: %w", err)
		}
		tmp := manifestPath + ".t9tmp"
		if err := os.WriteFile(tmp, out, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, manifestPath); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	return os.WriteFile(markerPath, []byte(bridgeVersion), 0o644)
}

// PatchBackground teaches uBOL's worker one action, `t9ExecuteScripts`, so the
// content script (which has no chrome.scripting) can ask for the zapper and
// picker to be injected into its own tab. Idempotent; called wherever
// PatchBridge is called. A missing anchor means uBOL changed shape upstream —
// that is reported, never guessed at.
func PatchBackground(dir string) error {
	if dir == "" {
		return errors.New("extension folder khaali hai")
	}
	path := filepath.Join(dir, "js", "background.js")
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("background.js padha nahi gaya: %w", err)
	}
	src := string(raw)
	if strings.Contains(src, "case 't9ExecuteScripts'") {
		return nil
	}
	if !strings.Contains(src, backgroundAnchor) {
		return errors.New("background.js me patch anchor nahi mila — uBOL ka shape badal gaya")
	}
	// Insert after the anchor's line, i.e. the new case must come BEFORE the
	// existing case so it is reached first (order does not matter for distinct
	// labels, but keeping it adjacent makes the diff obvious).
	patched := strings.Replace(src, backgroundAnchor, backgroundPatch+backgroundAnchor, 1)
	tmp := path + ".t9tmp"
	if err := os.WriteFile(tmp, []byte(patched), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
