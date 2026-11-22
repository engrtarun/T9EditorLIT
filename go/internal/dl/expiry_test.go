package dl

import (
	"strings"
	"testing"
	"time"
)

// The real URL from the stuck 2.8 GB row: signed 2026-11-21T05:33:24Z for
// eight hours. This is the link that kept "resuming" at 104,215 bytes days
// after it had died, so it is the fixture the parser must get right.
const expiredR2URL = "https://cee4a5cf74935f8a680f710564b4282f.r2.cloudflarestorage.com/hub/f45759bd94cd106b8f11e41498d7b531" +
	"?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
	"&X-Amz-Credential=5452c5f4fbff4e8ca3dfc5058fc64dd7%2F20261121%2Fauto%2Fs3%2Faws4_request" +
	"&X-Amz-Date=20261121T053324Z&X-Amz-Expires=28800&X-Amz-SignedHeaders=host" +
	"&X-Amz-Signature=7a389a5e0bf830170b1a7501bda817c3418d1f1fd7ea1b5efa1ae3faccddf49c"

func TestSignedURLExpiry(t *testing.T) {
	exp, ok := signedURLExpiry(expiredR2URL)
	if !ok {
		t.Fatal("R2/S3 v4 URL must report an expiry")
	}
	want := time.Date(2026, 11, 21, 13, 33, 24, 0, time.UTC)
	if !exp.Equal(want) {
		t.Fatalf("expiry = %s, want %s", exp, want)
	}

	// CloudFront / S3 v2 style.
	exp, ok = signedURLExpiry("https://cdn.example.com/a.mkv?Expires=1700000000&Signature=x")
	if !ok || !exp.Equal(time.Unix(1700000000, 0)) {
		t.Fatalf("unix Expires: got %s ok=%v", exp, ok)
	}

	// A plain link has nothing to enforce - it must stay resumable forever.
	if _, ok := signedURLExpiry("https://example.com/file.mp4"); ok {
		t.Fatal("unsigned URL reported an expiry")
	}
	// A malformed date is "unknown", never "expired at year 1".
	if _, ok := signedURLExpiry("https://example.com/a?X-Amz-Date=nope&X-Amz-Expires=60"); ok {
		t.Fatal("malformed X-Amz-Date reported an expiry")
	}
}

// resume() is the exact moment the user asks "why is this stuck?". An expired
// signature must answer that, and must not open a socket to a dead link.
func TestResumeRefusesExpiredLink(t *testing.T) {
	d := &download{
		id:       "expired-row",
		url:      expiredR2URL,
		status:   StatusPaused,
		partPath: t.TempDir() + "/file.mkv.part",
		sidePath: t.TempDir() + "/file.mkv.part.json",
	}
	err := d.resume()
	if err == nil {
		t.Fatal("resume on an expired link must fail")
	}
	if !strings.Contains(err.Error(), "expire") {
		t.Fatalf("error should say the link expired, got: %v", err)
	}
	if d.status != StatusError {
		t.Fatalf("status = %s, want error", d.status)
	}
	if !strings.Contains(d.errText, "expire") {
		t.Fatalf("errText = %q, want the expiry sentence", d.errText)
	}
}
