package cloud

import "strings"

// Whisper's verbose_json `language` field is an English *display name*
// ("hindi", "english"), while the OpenAI-compatible `language` request field
// expects an ISO-639-1 code ("hi", "en"). Feeding one back into the other is
// what broke a 49-minute import: chunk 0 replied `"language":"Hindi"`, the
// daemon pinned it, and chunks 001-009 all died with
//
//	groq returned 400: unsupported language: Hindi
//
// so the transcript stopped after the first five minutes.
//
// languageCodes is the bridge. Only names that map to a real code appear here;
// anything unknown returns "" and the caller sends no hint at all, letting
// Whisper auto-detect. A missing pin costs a little script consistency; a
// wrong pin costs the whole chunk.
var languageCodes = map[string]string{
	"afrikaans":            "af",
	"albanian":             "sq",
	"amharic":              "am",
	"arabic":               "ar",
	"armenian":             "hy",
	"assamese":             "as",
	"azerbaijani":          "az",
	"bashkir":              "ba",
	"basque":               "eu",
	"belarusian":           "be",
	"bengali":              "bn",
	"bosnian":              "bs",
	"breton":               "br",
	"bulgarian":            "bg",
	"burmese":              "my",
	"catalan":              "ca",
	"chinese":              "zh",
	"croatian":             "hr",
	"czech":                "cs",
	"danish":               "da",
	"dutch":                "nl",
	"english":              "en",
	"estonian":             "et",
	"faroese":              "fo",
	"finnish":              "fi",
	"french":               "fr",
	"galician":             "gl",
	"georgian":             "ka",
	"german":               "de",
	"greek":                "el",
	"gujarati":             "gu",
	"haitian creole":       "ht",
	"hausa":                "ha",
	"hawaiian":             "haw",
	"hebrew":               "he",
	"hindi":                "hi",
	"hungarian":            "hu",
	"icelandic":            "is",
	"indonesian":           "id",
	"italian":              "it",
	"japanese":             "ja",
	"javanese":             "jw",
	"kannada":              "kn",
	"kazakh":               "kk",
	"khmer":                "km",
	"korean":               "ko",
	"lao":                  "lo",
	"latin":                "la",
	"latvian":              "lv",
	"lithuanian":           "lt",
	"luxembourgish":        "lb",
	"macedonian":           "mk",
	"malagasy":             "mg",
	"malay":                "ms",
	"malayalam":            "ml",
	"maltese":              "mt",
	"maori":                "mi",
	"marathi":              "mr",
	"mongolian":            "mn",
	"nepali":               "ne",
	"norwegian":            "no",
	"occitan":              "oc",
	"pashto":               "ps",
	"persian":              "fa",
	"polish":               "pl",
	"portuguese":           "pt",
	"punjabi":              "pa",
	"romanian":             "ro",
	"russian":              "ru",
	"sanskrit":             "sa",
	"serbian":              "sr",
	"shona":                "sn",
	"sindhi":               "sd",
	"sinhala":              "si",
	"slovak":               "sk",
	"slovenian":            "sl",
	"somali":               "so",
	"spanish":              "es",
	"sundanese":            "su",
	"swahili":              "sw",
	"swedish":              "sv",
	"tagalog":              "tl",
	"tajik":                "tg",
	"tamil":                "ta",
	"tatar":                "tt",
	"telugu":               "te",
	"thai":                 "th",
	"turkish":              "tr",
	"turkmen":              "tk",
	"ukrainian":            "uk",
	"urdu":                 "ur",
	"uzbek":                "uz",
	"vietnamese":           "vi",
	"welsh":                "cy",
	"yiddish":              "yi",
	"yoruba":               "yo",
	"cantonese":            "yue",
	"filipino":             "tl",
	"flemish":              "nl",
	"mandarin":             "zh",
	"brazilian portuguese": "pt",
	"european portuguese":  "pt",
	"castilian":            "es",
	"farsi":                "fa",
	"haitian":              "ht",
	"burmese myanmar":      "my",
	"traditional chinese":  "zh",
	"simplified chinese":   "zh",
}

// isoCodes is the set of codes the table above produces. It is built once so a
// caller that already supplied a code ("hi", "en-US") is accepted without a
// second hand-maintained list, and a made-up two-letter string is not.
var isoCodes = func() map[string]struct{} {
	set := make(map[string]struct{}, len(languageCodes))
	for _, code := range languageCodes {
		set[code] = struct{}{}
	}
	return set
}()

// NormalizeLanguage turns a Whisper display name or a caller-supplied code into
// an ISO-639-1 code the provider accepts.
//
// An empty result means "no hint": the caller must omit the field rather than
// send something the API will reject. That is deliberately fail-open - a job
// with no language pin still produces a transcript, while a pinned display name
// produces nine failed chunks and a five-minute transcript.
func NormalizeLanguage(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	if code, ok := languageCodes[s]; ok {
		return code
	}
	// "en-US", "zh_CN", "pt-BR": the region is not part of the API field.
	if i := strings.IndexAny(s, "-_"); i > 0 {
		s = s[:i]
	}
	if _, ok := isoCodes[s]; ok {
		return s
	}
	return ""
}
