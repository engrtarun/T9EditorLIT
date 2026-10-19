//! On-disk cache locations for derived media data (Chunk 3).
//!
//! Waveform peaks and thumbnail frames are expensive to recompute and cheap to
//! store, so each source gets a content-addressed directory under the app data
//! folder. The key folds in the file's size and mtime, so replacing a source
//! invalidates its cache automatically — no stale waveform for a new recording.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Stable 64-bit FNV-1a hash rendered as lowercase hex.
///
/// We deliberately avoid `std::collections::hash_map::DefaultHasher`: its
/// output is not part of the stable API and may change between toolchains,
/// which would orphan every cached entry on a Rust upgrade. FNV-1a is tiny,
/// deterministic, and more than good enough for cache keys.
pub fn hash_hex(parts: &[&[u8]]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &b in *part {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// Cache key for a source file: canonical path + size + mtime.
///
/// `meta` is passed in by the caller so both the waveform and thumbnail paths
/// share one `stat` instead of racing the filesystem twice.
pub fn source_key(source: &Path, meta: &fs::Metadata) -> Result<String, String> {
    let canonical = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());

    let mut owned: Vec<Vec<u8>> = vec![canonical.to_string_lossy().into_owned().into_bytes()];
    owned.push(meta.len().to_le_bytes().to_vec());
    if let Ok(mtime) = meta.modified()
        && let Ok(d) = mtime.duration_since(UNIX_EPOCH)
    {
        owned.push(d.as_secs().to_le_bytes().to_vec());
        owned.push(d.subsec_nanos().to_le_bytes().to_vec());
    }

    let refs: Vec<&[u8]> = owned.iter().map(|v| v.as_slice()).collect();
    Ok(hash_hex(&refs))
}

/// Create (if needed) and return `<root>/<name>`.
pub fn dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let d = root.join(name);
    fs::create_dir_all(&d)
        .map_err(|e| format!("could not create cache dir {}: {e}", d.display()))?;
    Ok(d)
}

/// `<root>/thumbs/<key>/` — the caller creates it (see `thumbnail::extract`).
pub fn thumbs_dir(root: &Path, key: &str) -> PathBuf {
    root.join("thumbs").join(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_input_sensitive() {
        assert_eq!(hash_hex(&[b"a", b"b"]), hash_hex(&[b"a", b"b"]));
        assert_ne!(hash_hex(&[b"a"]), hash_hex(&[b"b"]));
        assert_ne!(hash_hex(&[b"a", b"b"]), hash_hex(&[b"a", b"c"]));
    }

    #[test]
    fn dir_creates_and_returns_the_named_subdirectory() {
        let root = std::env::temp_dir().join("t9editorlit-cache-dir-test");
        let d = dir(&root, "waveform").unwrap();
        assert!(d.starts_with(&root));
        assert!(d.ends_with("waveform"));
        assert!(d.is_dir());
    }

    #[test]
    fn thumbs_dir_lives_under_the_cache_root() {
        let root = Path::new("/tmp/cache");
        let t = thumbs_dir(root, "deadbeef");
        assert!(t.starts_with(root.join("thumbs")));
        assert!(t.ends_with("deadbeef"));
    }

    #[test]
    fn source_key_is_stable_for_an_existing_file() {
        let dir = std::env::temp_dir().join("t9editorlit-cache-test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("key-probe.bin");
        fs::write(&p, b"hello").unwrap();
        let meta = fs::metadata(&p).unwrap();
        assert_eq!(
            source_key(&p, &meta).unwrap(),
            source_key(&p, &meta).unwrap()
        );
    }
}
