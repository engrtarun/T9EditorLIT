package api

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// faviconCacheTTL is how long a fetched icon is reused from disk before the
// proxy asks the site again. A week is what browsers used to use; sites
// change icons rarely and the fetch costs a round trip the tab strip does
// not need.
const faviconCacheTTL = 7 * 24 * time.Hour

// faviconMaxBytes caps how much of an "icon" is worth reading. Some sites
// answer the favicon URL with a full-resolution PNG (or, worse, an HTML
// error page): 256 KiB is generous for a 16×16 mark and refuses the rest.
const faviconMaxBytes = 256 << 10

// handleFavicon fetches a site's icon once, caches it on disk and serves it
// from the loopback origin the webview's CSP already allows.
//
// The webview cannot load `https://site/icon.png` directly — the CSP's
// img-src is pinned to the daemon and bundled assets (a page that may run
// arbitrary script must not be able to make the shell fetch arbitrary
// origins). Routing every icon through this proxy keeps the CSP tight and
// turns repeated tab-strip repaints into disk reads.
func (s *Server) handleFavicon(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "an absolute http(s) url is required",
		})
		return
	}

	// A bare origin (`https://site.com`) is the common caller — the tab strip
	// and speed dial only know the host. Try the conventional `/favicon.ico`
	// before giving up; a real icon URL (any path) is fetched as-is.
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/favicon.ico"
		raw = parsed.String()
	}

	cache := s.faviconPath(parsed.Host)
	if info, err := os.Stat(cache); err == nil && time.Since(info.ModTime()) < faviconCacheTTL {
		serveFaviconFile(w, r, cache)
		return
	}

	// The daemon is the only part of the app allowed to reach the network,
	// and this is a plain GET of a public asset: a short deadline keeps a
	// dead host from parking a tab-strip repaint.
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "icon nahi mil paayi"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("icon server said %d", resp.StatusCode),
		})
		return
	}
	ctype := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ctype, "image/") && ctype != "image/vnd.microsoft.icon" {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error": "that url is not an image",
		})
		return
	}

	// Read into a file directly — the icon never sits in a byte slice that
	// the JSON layer then copies again.
	if err := os.MkdirAll(filepath.Dir(cache), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	tmp := cache + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	n, copyErr := io.Copy(f, io.LimitReader(resp.Body, faviconMaxBytes))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || n == 0 {
		_ = os.Remove(tmp)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "icon padhi nahi ja saki"})
		return
	}
	if err := os.Rename(tmp, cache); err != nil {
		_ = os.Remove(tmp)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	serveFaviconFile(w, r, cache)
}

// faviconPath is the disk cache slot for a host: a hash of the host keeps
// the filesystem out of the URL's special characters, and the extension is
// cosmetic (the content type travels with every response anyway).
func (s *Server) faviconPath(host string) string {
	sum := sha1.Sum([]byte(strings.ToLower(host)))
	return filepath.Join(s.faviconDir, hex.EncodeToString(sum[:8])+".ico")
}

func serveFaviconFile(w http.ResponseWriter, r *http.Request, path string) {
	// A week of freshness matches the proxy's own TTL: the browser reuses
	// its copy while the daemon's cache is still the source of truth.
	w.Header().Set("Cache-Control", "public, max-age=604800")
	// The bytes were sniffed as an image on the way in; declare the type the
	// browser needs to paint it. Every modern browser sniffs the body too,
	// so one generic type for the cache is safe.
	w.Header().Set("Content-Type", "image/x-icon")
	http.ServeFile(w, r, path)
}
