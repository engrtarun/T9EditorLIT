// Draft sketch for PROPOSAL-20261021-OPENCODE-VAULT-UPLOAD-THROUGHPUT
// Non-production. Review before applying.

package vault

import (
    "crypto/sha256"
    "encoding/hex"
    "io"
    "os"
)

func streamHash(path string) (string, error) {
    f, err := os.Open(path)
    if err != nil {
        return "", err
    }
    defer f.Close()

    h := sha256.New()
    buf := make([]byte, 64*1024)
    for {
        n, err := f.Read(buf)
        if n > 0 {
            h.Write(buf[:n])
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            return "", err
        }
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}
```