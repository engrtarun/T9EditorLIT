package vault

// digest.go — proving what actually left the machine.
//
// A split upload is only trustworthy if every part that arrives in Telegram is
// byte-identical to the slice on disk. Telegram does not checksum for us, and a
// re-encoded or truncated 1.9 GB part looks completely normal in the chat: the
// user only finds out when they try to edit it. So every part is hashed from
// the same file handle range the upload will read, and the digest goes into the
// manifest a restore reads back.
//
// Everything here streams. The buffer is a fixed 512 KB regardless of part
// size, so hashing a 1.9 GB part costs the same memory as hashing a 5 MB one —
// which is the only reason this project is allowed to touch video files at all.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// HashBufferBytes is the only buffer a digest pass allocates.
//
// 512 KB is the same figure the uploader uses for its RPC payload, so hashing
// and uploading share a comfortable memory ceiling. Nothing here scales with
// the size of the file.
const HashBufferBytes = 512 * 1024

// hashBufPool keeps one buffer alive across the parts of a file.
//
// A 5 GB source has three parts; allocating three 512 KB buffers and throwing
// them away is waste, but pooling a *large* buffer would be worse — the pool
// would pin memory forever. 512 KB is small enough to hold permanently.
var hashBufPool = make(chan []byte, 2)

func getHashBuf() []byte {
	select {
	case b := <-hashBufPool:
		return b
	default:
		return make([]byte, HashBufferBytes)
	}
}

func putHashBuf(b []byte) {
	if cap(b) < HashBufferBytes {
		return
	}
	select {
	case hashBufPool <- b[:HashBufferBytes]:
	default: // pool already full; let it go
	}
}

// HashRange returns the hex SHA-256 of [offset, offset+size) of a file.
//
// The range is read through a SectionReader over an independent file handle,
// never by seeking a shared one: the upload workers read other ranges of the
// same file concurrently, and one shared handle would interleave their seeks.
func HashRange(path string, offset, size int64) (string, error) {
	if offset < 0 || size < 0 {
		return "", fmt.Errorf("invalid range [%d,%d) for %s", offset, offset+size, filepath.Base(path))
	}

	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	h := sha256.New()
	buf := getHashBuf()
	defer putHashBuf(buf)

	if _, err := io.CopyBuffer(h, io.NewSectionReader(f, offset, size), buf); err != nil {
		return "", fmt.Errorf("hashing %d bytes at %d of %s: %w",
			size, offset, filepath.Base(path), err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashPart is HashRange over a planned part. It exists so callers do not have
// to remember which field is the offset.
func HashPart(path string, p Part) (string, error) {
	return HashRange(path, p.Offset, p.Size)
}

// mimeTypes covers the extensions this app actually produces.
//
// mime.TypeByExtension is consulted first, but on Windows it reads the registry
// and returns "" for plenty of perfectly normal extensions — and an empty
// MimeType makes Telegram guess, which for a 1.9 GB part means it may store it
// as something that will not stream. A small explicit table is cheaper and
// more predictable than depending on the host's registry.
var mimeTypes = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mkv":  "video/x-matroska",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".avi":  "video/x-msvideo",
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".wav":  "audio/wav",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".json": "application/json",
	".srt":  "application/x-subrip",
	".vtt":  "text/vtt",
	".txt":  "text/plain",
	".zip":  "application/zip",
}

// MimeFor returns the MIME type for a file name.
func MimeFor(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if m, ok := mimeTypes[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

// humanBytes renders a size for a caption or a log line.
func humanBytes(n int64) string {
	const unit = 1000 // decimal, because that is how vendors sell drives
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(n)/float64(div), "kMGTP"[exp])
}
