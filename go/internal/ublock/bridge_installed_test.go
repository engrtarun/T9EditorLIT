package ublock

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestPatchRealInstalledExtension is a local-only compatibility check. It
// never touches the live extension: it copies it to a temp dir, applies our
// patches there and node --checks the result. On CI (no installed app) it
// skips. This is what catches an upstream uBOL change that keeps our anchor
// text but produces broken JavaScript.
func TestPatchRealInstalledExtension(t *testing.T) {
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		t.Skip("LOCALAPPDATA nahi hai - installed extension nahi mil sakta")
	}
	src := filepath.Join(root, "T9EditorLIT", "ublock", "extensions-mv3", "uBOLite.chromium")
	if _, err := os.Stat(filepath.Join(src, "manifest.json")); err != nil {
		t.Skipf("installed uBOL folder nahi mila: %v", err)
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node nahi hai - JS syntax check nahi ho sakta")
	}

	dst := t.TempDir()
	if err := copyDir(src, dst); err != nil {
		t.Fatalf("copy: %v", err)
	}
	if err := PatchBridge(dst); err != nil {
		t.Fatalf("PatchBridge: %v", err)
	}
	if err := PatchBackground(dst); err != nil {
		t.Fatalf("PatchBackground: %v", err)
	}

	for _, rel := range []string{BridgeFile, filepath.Join("js", "background.js")} {
		cmd := exec.Command("node", "--check", filepath.Join(dst, rel))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("node --check %s failed: %v\n%s", rel, err, out)
		}
	}
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
