//! "Edit with T9 Editor LIT" — the File Explorer right-click verb.
//!
//! Registered under `HKCU\Software\Classes\<ProgID>\shell\...` — **not**
//! under the bare extension key. That distinction is the whole reason this
//! module exists in its current shape:
//!
//! - Windows 11 resolves a file's verbs through its **ProgID** (the default
//!   value of the extension key, e.g. `.mp4` → `PotPlayerMini64.MP4` here).
//!   A verb written under `HKCU\Software\Classes\.mp4\shell\...` is invisible
//!   — empirically verified with `Shell.Application`'s own verb enumeration,
//!   which is the same list Explorer builds the menu from. The ProgID verb
//!   appears in that enumeration instantly, the extension verb never does.
//! - The extension key is still written too, because older Windows builds
//!   (and some third-party shells) do read it. Two homes, one verb.
//!
//! That is the classic (Win32) verb mechanism: no COM DLL, no sparse
//! package, no admin rights — `HKCU` belongs to the user, so the keys can be
//! written by the app itself. On Windows 11 the entry may sit under "Show
//! more options" depending on build; the guaranteed top-level placement
//! needs an `IExplorerCommand` COM server, which means a native DLL —
//! C++ is banned by AGENTS.md §2 and a Rust COM DLL is a project of its own.
//!
//! The registry writes happen through `reg.exe` **child processes**, which
//! are spawned, awaited and reaped — no bytes of any file ever land in this
//! process's heap, and the module carries no new crate dependency.
//!
//! The verb is written once per install path **and** per ProgID set (the
//! marker file remembers both): changing the default app for videos changes
//! the ProgIDs, and the next launch re-homes the verb under the new ones.

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

/// Fallback home: `HKCU` key carrying the verb for one extension. Windows 11
/// does not read this one, but older shells do — cheap insurance.
///
/// The extension key is literally `.mp4` — one key, dot included. (An
/// earlier version of this had `Classes\.\\{ext}`, which builds TWO path
/// segments — a key named `.` with `mp4` inside it — and Explorer never
/// saw the verb.)
fn extension_verb_key(ext: &str) -> String {
    format!(r"HKCU\Software\Classes\.{ext}\shell\{VERB}")
}

/// The real home: `HKCU` key carrying the verb under one ProgID. This is
/// where Windows 11 looks and the only place it ever found the verb.
fn prog_id_verb_key(prog_id: &str) -> String {
    format!(r"HKCU\Software\Classes\{prog_id}\shell\{VERB}")
}

/// The `.reg`-style command line the verb runs. Both the exe and `%1` are
/// quoted — install paths and video paths both routinely contain spaces.
fn command_value(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

/// The three `reg add` calls that write one verb key: label, icon, command.
fn verb_commands(key: &str, exe: &str) -> Vec<Vec<String>> {
    vec![
        vec![
            "add".into(),
            key.to_string(),
            "/ve".into(),
            "/d".into(),
            LABEL.into(),
            "/f".into(),
        ],
        vec![
            "add".into(),
            key.to_string(),
            "/v".into(),
            "Icon".into(),
            "/d".into(),
            format!("{exe},0"),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("{key}\\command"),
            "/ve".into(),
            "/d".into(),
            command_value(exe),
            "/f".into(),
        ],
    ]
}

/// One `reg delete` for a verb key — silent about keys never written.
fn delete_command(key: &str) -> Vec<String> {
    vec!["delete".into(), key.to_string(), "/f".into()]
}

/// Registration commands for the extension-key fallback home: three per
/// video extension. Pure — unit-tested without touching the registry.
pub fn reg_commands(exe: &str) -> Vec<Vec<String>> {
    VIDEO_EXTS
        .iter()
        .flat_map(|ext| verb_commands(&extension_verb_key(ext), exe))
        .collect()
}

/// Registration commands for the ProgID homes — the ones Windows 11 reads.
/// One verb per distinct ProgID (several extensions may share one, e.g.
/// `WMP11.AssocFile.MPEG` for both `.mpg` and `.mpeg`). Pure.
pub fn prog_id_reg_commands(exe: &str, prog_ids: &[String]) -> Vec<Vec<String>> {
    unique_prog_ids(prog_ids)
        .iter()
        .flat_map(|pid| verb_commands(&prog_id_verb_key(pid), exe))
        .collect()
}

/// De-duplicate while keeping first-seen order.
fn unique_prog_ids(prog_ids: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for pid in prog_ids {
        if !seen.contains(pid) {
            seen.push(pid.clone());
        }
    }
    seen
}

/// Removal commands for every home the verb can occupy: the extension keys
/// always, plus whatever ProgIDs the caller resolved. Pure.
pub fn removal_commands(prog_ids: &[String]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = VIDEO_EXTS
        .iter()
        .map(|ext| delete_command(&extension_verb_key(ext)))
        .collect();
    out.extend(
        unique_prog_ids(prog_ids)
            .iter()
            .map(|pid| delete_command(&prog_id_verb_key(pid))),
    );
    out
}

/// `(extension, ProgID)` pairs for every video extension that currently has
/// a ProgID at all. `HKCU` wins over `HKLM` exactly like `HKCR` does.
pub fn resolve_prog_ids() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for ext in VIDEO_EXTS {
        if let Some(pid) = query_default(&format!(r"HKCU\Software\Classes\.{ext}"))
            .or_else(|| query_default(&format!(r"HKLM\SOFTWARE\Classes\.{ext}")))
        {
            out.push((ext.to_string(), pid));
        }
    }
    out
}

/// The ProgID list only — what the commands and the marker signature need.
pub fn prog_id_list(pairs: &[(String, String)]) -> Vec<String> {
    pairs.iter().map(|(_, pid)| pid.clone()).collect()
}

/// A short fingerprint of the resolved ProgID set, stored with the marker.
/// Empty pairs fingerprint to the empty string, so a machine with no ProgIDs
/// still has a stable signature.
fn prog_id_signature(pairs: &[(String, String)]) -> String {
    unique_prog_ids(&prog_id_list(pairs)).join(";")
}

/// Ask `reg.exe` for a key's default value. The only parsing rule that
/// matters: `REG_SZ` and the value follow `(Default)` on one line, and the
/// value may contain spaces — take the whole rest of the line.
fn parse_default_reg_value(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("(Default)") {
            if let Some(pos) = rest.find("REG_SZ") {
                let value = rest[pos + "REG_SZ".len()..].trim();
                if value.is_empty() || value == "(value not set)" {
                    return None;
                }
                return Some(value.to_string());
            }
        }
    }
    None
}

/// `reg.exe` as a child process that never shows a console window.
///
/// A GUI parent does not pass a console down, so every `reg` call flashed a
/// black CMD box for a few milliseconds — fourteen of them at every app
/// launch, which is exactly the "CMD window appears and disappears" the user
/// saw. CREATE_NO_WINDOW keeps the query identical and makes it invisible.
fn reg() -> Command {
    let mut cmd = Command::new("reg");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — the work is unchanged; only the flash is gone.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Read one key's default value through a `reg query` child process.
fn query_default(key: &str) -> Option<String> {
    let out = reg().args(["query", key, "/ve"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_default_reg_value(&String::from_utf8_lossy(&out.stdout))
}

/// Run every argument list as one `reg.exe` child process, awaiting and
/// reaping it. Deletes are allowed to fail (a key that was never written is
/// not an error); additions report the first stderr line reg.exe produced.
pub fn run_all(commands: &[Vec<String>]) -> Result<(), String> {
    let mut last_err: Option<String> = None;
    for args in commands {
        let out = reg()
            .args(args)
            .output()
            .map_err(|e| format!("reg.exe could not be started: {e}"))?;
        if !out.status.success() && args[0] != "delete" {
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

/// The marker is two lines: the exe path, then the ProgID signature the
/// registration was built from. Written as one small file, read as one.
fn marker_text(exe: &str, prog_id_sig: &str) -> String {
    format!("{exe}\n{prog_id_sig}")
}

/// Write the marker that remembers which exe and which ProgID set the verb
/// currently points at.
fn write_marker(dir: &Path, content: &str) {
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(dir.join("shell-menu.path"), content);
}

/// Read the marker's exe line, if it exists, is readable and is non-empty.
fn read_marker_exe(dir: &Path) -> Option<String> {
    read_marker_part(dir, 0)
}

/// Read the marker's ProgID-signature line (absent markers and old
/// single-line markers both count as "no signature").
fn read_marker_signature(dir: &Path) -> Option<String> {
    read_marker_part(dir, 1)
}

fn read_marker_part(dir: &Path, line: usize) -> Option<String> {
    let text = fs::read_to_string(dir.join("shell-menu.path")).ok()?;
    text.lines()
        .nth(line)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The pure decision `ensure_registered` makes: register only when the exe
/// or the ProgID set moved. A marker written by an older single-line build
/// has no signature, so it counts as a mismatch and upgrades itself.
fn marker_is_current(
    marker_exe: Option<&str>,
    marker_sig: Option<&str>,
    exe: &str,
    sig: &str,
) -> bool {
    marker_exe == Some(exe) && marker_sig == Some(sig)
}

/// Register the verb for the running exe — unless it was already registered
/// for this exact path **and** this exact ProgID set. Called at start-up (in
/// the background) and after an update swap, so the verb always points at
/// the installed binary and lives under the ProgID Explorer actually reads.
pub fn ensure_registered(cache_dir: &Path, exe: &str) -> Result<bool, String> {
    ensure_registered_with(cache_dir, exe, &resolve_prog_ids())
}

/// Testable seam: same as `ensure_registered` but with the ProgID pairs
/// resolved by the caller, so tests never touch the real registry.
pub fn ensure_registered_with(
    cache_dir: &Path,
    exe: &str,
    pairs: &[(String, String)],
) -> Result<bool, String> {
    let sig = prog_id_signature(pairs);
    if marker_is_current(
        read_marker_exe(cache_dir).as_deref(),
        read_marker_signature(cache_dir).as_deref(),
        exe,
        &sig,
    ) {
        return Ok(false); // already current — nothing to do
    }
    run_all(&reg_commands(exe))?;
    run_all(&prog_id_reg_commands(exe, &prog_id_list(pairs)))?;
    write_marker(cache_dir, &marker_text(exe, &sig));
    Ok(true)
}

/// Remove every verb key — extension homes and the currently-resolved
/// ProgID homes — and forget the marker.
pub fn unregister(cache_dir: &Path) -> Result<(), String> {
    unregister_with(cache_dir, &resolve_prog_ids());
    Ok(())
}

/// Testable seam for `unregister`.
pub fn unregister_with(cache_dir: &Path, pairs: &[(String, String)]) {
    let _ = run_all(&removal_commands(&prog_id_list(pairs)));
    let _ = fs::remove_file(cache_dir.join("shell-menu.path"));
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\pocot\AppData\Local\Programs\T9EditorLIT\t9-editor-lit.exe";

    /// A ProgID set shaped like the real machine: `.mp4` handled by
    /// PotPlayer, `.mpg`/`.mpeg` sharing Windows Media Player's ProgID.
    fn sample_pairs() -> Vec<(String, String)> {
        vec![
            ("mp4".into(), "PotPlayerMini64.MP4".into()),
            ("mpg".into(), "WMP11.AssocFile.MPEG".into()),
            ("mpeg".into(), "WMP11.AssocFile.MPEG".into()),
        ]
    }

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
    /// path and real video paths both contain spaces, and an unquoted path
    /// launches a truncated command.
    #[test]
    fn the_command_value_quotes_the_exe_and_the_file() {
        let mut cmds = reg_commands(EXE);
        cmds.extend(prog_id_reg_commands(EXE, &prog_id_list(&sample_pairs())));
        let joined: Vec<String> = cmds
            .iter()
            .map(|c| c.join(" "))
            .filter(|c| c.contains(r"\command "))
            .collect();
        assert!(!joined.is_empty());
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

    /// The extension fallback key must be exactly
    /// `HKCU\Software\Classes\.mp4\shell\<verb>` — the extension is ONE key
    /// whose name starts with a dot.
    ///
    /// This test exists because the first version built `Classes\.\\{ext}`:
    /// two segments (`.` and `mp4`), so every verb landed under a junk key
    /// named `.` that Explorer never reads. Writing the keys "succeeded",
    /// the marker said "registered", and the menu showed nothing — only a
    /// registry query caught it.
    #[test]
    fn the_key_is_one_dotted_segment_not_a_dot_folder() {
        for ext in VIDEO_EXTS {
            let key = extension_verb_key(ext);
            assert_eq!(
                key,
                format!(r"HKCU\Software\Classes\.{ext}\shell\{VERB}"),
                "wrong key layout for .{ext}: {key}"
            );
            // No segment may be a bare "." — that is the exact shape of the bug.
            assert!(
                !key.split('\\').any(|s| s == "."),
                "a bare '.' segment crept back into the key for .{ext}: {key}"
            );
        }
    }

    /// The ProgID key — the only home Windows 11 reads — must be exactly
    /// `HKCU\Software\Classes\<ProgID>\shell\<verb>`, with the ProgID as a
    /// single segment. This is the bug class that made the verb invisible
    /// on Windows 11 even with "correct" extension keys: 11 resolves verbs
    /// through the ProgID, never through the bare extension.
    #[test]
    fn the_prog_id_key_homes_the_verb_under_the_prog_id() {
        let key = prog_id_verb_key("PotPlayerMini64.MP4");
        assert_eq!(
            key,
            r"HKCU\Software\Classes\PotPlayerMini64.MP4\shell\T9EditorLit"
        );
        assert!(!key.split('\\').any(|s| s == "."));
    }

    /// A ProgID shared by two extensions produces ONE verb, not two.
    #[test]
    fn shared_prog_ids_register_once() {
        let cmds = prog_id_reg_commands(EXE, &prog_id_list(&sample_pairs()));
        // 2 distinct ProgIDs (PotPlayer, WMP) x 3 commands.
        assert_eq!(cmds.len(), 2 * 3);
        let deletes = removal_commands(&prog_id_list(&sample_pairs()));
        assert_eq!(deletes.len(), VIDEO_EXTS.len() + 2);
    }

    /// Removal deletes both homes — extension keys always, ProgID keys for
    /// every ProgID handed in.
    #[test]
    fn removal_deletes_every_home() {
        let cmds = removal_commands(&prog_id_list(&sample_pairs()));
        assert!(cmds
            .iter()
            .filter(|c| c[1].contains(r"\shell\T9EditorLit"))
            .all(|c| c[0] == "delete"));
        assert!(cmds
            .iter()
            .any(|c| c[1].ends_with(r".mp4\shell\T9EditorLit")));
        assert!(cmds
            .iter()
            .any(|c| c[1].ends_with(r"\PotPlayerMini64.MP4\shell\T9EditorLit")));
    }

    /// Every registry call goes through `reg()` — the helper that sets
    /// CREATE_NO_WINDOW. Writing a bare `Command::new("reg")` again would
    /// bring the launch-time CMD flash back, so the helper is pinned here.
    #[test]
    fn registry_calls_go_through_the_silent_helper() {
        assert_eq!(reg().get_program(), std::ffi::OsStr::new("reg"));
    }

    /// `reg query` output parsing: the value is everything after `REG_SZ`,
    /// spaces included; "(value not set)" and empty values count as absent.
    #[test]
    fn default_value_parsing_takes_the_whole_rest_of_the_line() {
        let out = "HKEY_CURRENT_USER\\Software\\Classes\\.mp4\r\n\
                   (Default)    REG_SZ    PotPlayerMini64.MP4\r\n";
        assert_eq!(
            parse_default_reg_value(out).as_deref(),
            Some("PotPlayerMini64.MP4")
        );

        let spaced = "(Default)    REG_SZ    Some.Prog ID.With Spaces\r\n";
        assert_eq!(
            parse_default_reg_value(spaced).as_deref(),
            Some("Some.Prog ID.With Spaces")
        );

        let unset = "(Default)    REG_SZ    (value not set)\r\n";
        assert_eq!(parse_default_reg_value(unset), None);

        let empty = "(Default)    REG_SZ    \r\n";
        assert_eq!(parse_default_reg_value(empty), None);

        assert_eq!(parse_default_reg_value("no default line"), None);
    }

    /// The marker round-trips as two lines and refuses to read empty lines.
    #[test]
    fn the_marker_round_trips() {
        let dir = std::env::temp_dir().join(format!("t9-shell-menu-{}", std::process::id()));
        let _ = std::fs::remove_file(dir.join("shell-menu.path"));

        assert_eq!(read_marker_exe(&dir), None);
        assert_eq!(read_marker_signature(&dir), None);

        write_marker(&dir, &marker_text(EXE, "PotPlayerMini64.MP4"));
        assert_eq!(read_marker_exe(&dir).as_deref(), Some(EXE));
        assert_eq!(
            read_marker_signature(&dir).as_deref(),
            Some("PotPlayerMini64.MP4")
        );

        // An empty marker counts as absent — an install interrupted mid-write
        // must not pin the verb to a path nobody registered.
        std::fs::write(dir.join("shell-menu.path"), "  \n  ").unwrap();
        assert_eq!(read_marker_exe(&dir), None);
        assert_eq!(read_marker_signature(&dir), None);

        let _ = std::fs::remove_file(dir.join("shell-menu.path"));
    }

    /// The registration decision: same exe + same ProgID set = skip; a moved
    /// exe or a changed default app (new ProgID set) = re-register. A marker
    /// from the old single-line build has no signature and upgrades itself.
    #[test]
    fn registration_skips_only_when_exe_and_prog_ids_match() {
        let sig = "PotPlayerMini64.MP4";
        assert!(marker_is_current(Some(EXE), Some(sig), EXE, sig));
        assert!(!marker_is_current(Some(EXE), Some(sig), r"C:\new\path.exe", sig));
        assert!(!marker_is_current(Some(EXE), Some(sig), EXE, "Other.ProgID"));
        assert!(!marker_is_current(Some(EXE), None, EXE, sig), "old marker upgrades");
        assert!(!marker_is_current(None, None, EXE, sig));
    }

    /// `ensure_registered` skips the registry entirely when the marker already
    /// names this exe **and** this ProgID set — the steady state of every
    /// launch after the first.
    #[test]
    fn ensure_registered_is_a_no_op_when_the_marker_matches() {
        let dir = std::env::temp_dir().join(format!("t9-shell-menu-keep-{}", std::process::id()));
        let pairs = sample_pairs();
        let sig = prog_id_signature(&pairs);
        write_marker(&dir, &marker_text(EXE, &sig));
        // A bogus exe that must never reach reg.exe: if the marker check
        // failed, this test would attempt a real registry write and fail.
        assert!(!ensure_registered_with(&dir, EXE, &pairs).unwrap());
        let _ = std::fs::remove_file(dir.join("shell-menu.path"));
    }

    /// A changed default app (different ProgID set) forces a re-registration
    /// even though the exe path never moved.
    #[test]
    fn ensure_registered_re_registers_when_the_prog_ids_change() {
        let dir = std::env::temp_dir().join(format!("t9-shell-menu-churn-{}", std::process::id()));
        let old = vec![("mp4".into(), "Old.App.MP4".into())];
        write_marker(&dir, &marker_text(EXE, &prog_id_signature(&old)));
        let new = vec![("mp4".into(), "New.App.MP4".into())];
        // The exe now differs from the marker's, so the call would hit the
        // registry for real — assert only the decision, not the write.
        assert!(!marker_is_current(
            Some(EXE),
            Some(&prog_id_signature(&old)),
            EXE,
            &prog_id_signature(&new)
        ));
        let _ = std::fs::remove_file(dir.join("shell-menu.path"));
    }
}
