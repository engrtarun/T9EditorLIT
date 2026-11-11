package cloud

import "testing"

// The bug: Groq's verbose_json reports `language` as a display name ("Hindi"),
// and the daemon used to send that value straight back as the request field.
// Groq wants ISO-639-1, answered 400 "unsupported language: Hindi" for every
// chunk after the first, and a 49-minute import ended at five minutes.
func TestNormalizeLanguageMapsWhisperDisplayNames(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Hindi", "hi"},
		{"hindi", "hi"},
		{"English", "en"},
		{"  HINDI  ", "hi"},
		{"Portuguese", "pt"},
		{"Brazilian Portuguese", "pt"},
		{"Mandarin", "zh"},
		{"Cantonese", "yue"},
		{"Filipino", "tl"},
	}
	for _, c := range cases {
		if got := NormalizeLanguage(c.in); got != c.want {
			t.Errorf("NormalizeLanguage(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A caller may already know the code, including a regional tag. Both are
// accepted; the region is not part of the API's field.
func TestNormalizeLanguageAcceptsCodes(t *testing.T) {
	cases := map[string]string{
		"hi":    "hi",
		"en":    "en",
		"en-US": "en",
		"pt_BR": "pt",
		"zh-CN": "zh",
	}
	for in, want := range cases {
		if got := NormalizeLanguage(in); got != want {
			t.Errorf("NormalizeLanguage(%q) = %q, want %q", in, got, want)
		}
	}
}

// Unmappable input must become "" - the caller then omits the field and lets
// Whisper auto-detect. Forwarding it would fail the chunk.
func TestNormalizeLanguageRefusesUnknownValues(t *testing.T) {
	for _, in := range []string{"", "   ", "klingon", "xx", "not a language", "123"} {
		if got := NormalizeLanguage(in); got != "" {
			t.Errorf("NormalizeLanguage(%q) = %q, want empty (omit the field)", in, got)
		}
	}
}
