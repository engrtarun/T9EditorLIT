//! "Edit with T9 Editor LIT" — the File Explorer right-click verb.
//!
//! Registered under `HKCU\Software\Classes\<ext>\shell\...` for the video
//! extensions only. That is the classic (Win32) verb mechanism: no COM DLL,
//! no sparse package, no admin rights — `HKCU` belongs to the user, so the
//! keys can be written by the app itself. On Windows 11 the entry shows under
//! "Show more options"; the modern top-level menu needs an `IExplorerCommand`
//! COM server, which means a C++ DLL — banned by AGENTS.md §2. This is the
//! same trade Notepad++ and WinRAR offer.
//!
//! The registry writes happen through `reg.exe` **child processes**, which are
//! spawned, awaited and reaped — no bytes of any file ever land in this
//! process's heap, and the module carries no new crate dependency.
//!
//! The verb is written **once per install path** (a marker file in the app's
//! cache root remembers the exe path that was registered), so a normal app
//! launch costs one small file read, not fifty `reg.exe` spawns.

use std::fs;
use std::path::Path;
use std::process::Command;

/// The verb's registry name — stable, never localized. `MUIVerb` carries the
/// label the user actually reads.
pub const VERB: &str = "T9EditorLit";

/// The label shown in the context menu.
pub const LABEL: &str = "Edit with T9 Editor LIT";

/// Every file type the verb is offered for. **Videos only** — a transcript
/// editor has no business claiming `.txt`.
pub const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "mpg", "mpeg", "m2ts", "mts", "flv", "3gp",
    "ts",
];

/// True when a command-line argument looks like a video path this app should
/// open — the filter that keeps `--some-flag` out of the "open this file" path.
pub fn looks_like_video(path: &str) -> bool {
    let p = path.trim().trim_matches('"');
    match Path::new(p).extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext = ext.to_ascii_lowercase();
            VIDEO_EXTS.contains(&ext.as_str())
        }
        None => false,
    }
}

/// `HKCU` key that carries the verb for one extension.
fn verb_key(ext: &str) -> String {
    format!(r"HKCU\Software\Classes\.\{ext}\shell\{VERB}")
}

/// The `.reg`-style command line the verb runs.
fn command_value(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

/// Build the full `reg.exe` argument list that registers the verb for every
/// video extension. Pure — unit-tested without touching the registry.
pub fn reg_commands(exe: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for ext in VIDEO_EXTS {
        let key = verb_key(ext);
        // The menu label.
        out.push(vec![
            "add".into(),
            key.clone(),
            "/ve".into(),
            "/d".into(),
            LABEL.into(),
            "/f".into(),
        ]);
        // The icon — the app's own exe, so the menu row carries the brand.
        out.push(vec![
            "add".into(),
            key.clone(),
            "/v".into(),
            "Icon".into(),
            "/d".into(),
            format!("{exe},0"),
            "/f".into(),
        ]);
        // What it runs: the exe with the selected file as `%1`.
        out.push(vec![
            "add".into(),
            format!("{key}\\command"),
            "/ve".into(),
            "/d".into(),
            command_value(exe),
            "/f".into(),
        ]);
    }
    out
}

/// The inverse — one `reg delete` per extension, silent about keys that were
/// never there.
pub fn removal_commands() -> Vec<Vec<String>> {
    VIDEO_EXTS
        .iter()
        .map(|ext| {
            vec![
                "delete".into(),
                verb_key(ext),
                "/f".into(),
            ]
        })
        .collect()
}

/// Run every argument list as one `reg.exe` child process, awaiting and
/// reaping it. Any failure is reported with the first stderr line, which is
/// what reg.exe puts the real reason in.
pub fn run_all(commands: &[Vec<String>]) -> Result<(), String> {
    let mut last_err: Option<String> = None;
    for args in commands {
        let out = Command::new("reg")
            .args(args)
            .output()
            .map_err(|e| format!("reg.exe could not be started: {e}"))?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr);
            last_err = Some(msg.trim().to_string());
        }
    }
    match last_err {
        Some(e) if e.is_empty() => Err("reg.exe failed".into()),
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Write the marker that remembers which exe the verb currently points at.
fn write_marker(dir: &Path, exe: &str) {
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(dir.join("shell-menu.path"), exe);
}

/// Read the marker, if it exists and is readable.
fn read_marker(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("shell-menu.path"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Register the verb for the running exe — unless it was already registered
/// for this exact path. Called at start-up (in the background) and after an
/// update swap, so the verb always points at the installed binary.
pub fn ensure_registered(cache_dir: &Path, exe: &str) -> Result<bool, String> {
    if read_marker(cache_dir).as_deref() == Some(exe) {
        return Ok(false); // already current — nothing to do
    }
    run_all(&reg_commands(exe))?;
    write_marker(cache_dir, exe);
    Ok(true)
}

/// Remove every verb key and forget the marker.
pub fn unregister(cache_dir: &Path) -> Result<(), String> {
    run_all(&removal_commands())?;
    let _ = fs::remove_file(cache_dir.join("shell-menu.path"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\pocot\AppData\Local\Programs\T9EditorLIT\t9-editor-lit.exe";

    #[test]
    fn video_extensions_are_lowercase_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for ext in VIDEO_EXTS {
            assert_eq!(ext, &ext.to_ascii_lowercase());
            assert!(seen.insert(ext), "duplicate extension: {ext}");
        }
    }

    #[test]
    fn only_video_paths_look_like_videos() {
        assert!(looks_like_video(r"D:\clips\lecture 1.mp4"));
        assert!(looks_like_video(r"D:\clips\lecture 1.MP4"));
        assert!(looks_like_video("\"D:\\clips\\file.mkv\""));
        assert!(!looks_like_video(r"D:\notes\todo.txt"));
        assert!(!looks_like_video(r"D:\setup.exe"));
        assert!(!looks_like_video("--enable-foo"));
        assert!(!looks_like_video(r"D:\folder\with.noext"));
    }

    /// Three keys per extension: label, icon, command.
    #[test]
    fn three_reg_commands_per_extension() {
        let cmds = reg_commands(EXE);
        assert_eq!(cmds.len(), VIDEO_EXTS.len() * 3);
    }

    /// The command value must quote **both** the exe and `%1` — the install
    /// path contains "T9 Editor LIT"-style spaces in every real install, and
    /// an unquoted path would launch a broken command.
    #[test]
    fn the_command_value_quotes_the_exe_and_the_file() {
        let cmds = reg_commands(EXE);
        let joined: Vec<String> = cmds
            .iter()
            .map(|c| c.join(" "))
            .filter(|c| c.contains(r"\command "))
            .collect();
        assert_eq!(joined.len(), VIDEO_EXTS.len());
        for c in joined {
            assert!(
                c.contains(&format!("\"{EXE}\" \"%1\"")),
                "unquoted command value: {c}"
            );
        }
    }

    #[test]
    fn the_label_is_the_readable_one() {
        let cmds = reg_commands(EXE);
        assert!(
            cmds.iter()
                .any(|c| c.contains(&LABEL.to_string()) && c.contains(&"/ve".to_string()))
        );
    }

    /// The verb name is part of the key, so it must never contain a backslash
    /// or the key layout silently changes.
    #[test]
    fn the_verb_name_is_a_single_token() {
        assert!(!VERB.contains('\\') && !VERB.contains(' '));
    }

    #[test]
    fn removal_deletes_the_whole_verb_key() {
        let cmds = removal_commands();
        assert_eq!(cmds.len(), VIDEO_EXTS.len());
        assert!(cmds
            .iter()
            .all(|c| c[0] == "delete" && c[1].ends_with(r"\shell\T9EditorLit")));
    }

    /// The marker round-trips and refuses to read an empty file.
    #[test]
    fn the_marker_round_trips() {
        let dir = std::env::temp_dir().join(format!("t9-shell-menu-{}", std::process::id()));
        let _ = std::fs::remove_file(dir.join("shell-menu.path"));

        assert_eq!(read_marker(&dir), None);
        write_marker(&dir, EXE);
        assert_eq!(read_marker(&dir).as_deref(), Some(EXE));

        // An empty marker counts as absent — an install interrupted mid-write
        // must not pin the verb to a path nobody registered.
        std::fs::write(dir.join("shell-menu.path"), "  ").unwrap();
        assert_eq!(read_marker(&dir), None);

        let _ = std::fs::remove_file(dir.join("shell-menu.path"));
    }

    /// `ensure_registered` skips the registry entirely when the marker already
    /// names this exe — the steady state of every launch after the first.
    #[test]
    fn ensure_registered_is_a_no_op_when_the_marker_matches() {
        let dir = std::env::temp_dir().join(format!("t9-shell-menu-keep-{}", std::process::id()));
        write_marker(&dir, EXE);
        // A bogus exe that must never reach reg.exe: if the marker check
        // failed, this test would attempt a real registry write and fail.
        assert_eq!(ensure_registered(&dir, EXE).unwrap(), false);
        let _ = std::fs::remove_file(dir.join("shell-menu.path"));
    }
}
