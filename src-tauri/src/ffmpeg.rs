//! Thin, zero-copy-ish wrappers around the `ffmpeg` / `ffprobe` binaries.
//!
//! Everything here streams through child processes. We never load media into
//! this process's address space — that is the entire point of the architecture.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A completed child-process run.
pub struct RunOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl RunOutput {
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

/// Run a binary to completion, capturing both streams.
///
/// FFmpeg is chatty on stderr even on success (stream sizes, speed, etc.), so
/// both streams are always collected.
pub fn run(program: &str, args: &[&str]) -> Result<RunOutput, String> {
    // Version/encoder/filter listings run dozens of times a session and hold
    // no real workload — they would only add noise to the child metrics.
    let trivial = is_trivial_probe(args);
    let started = Instant::now();
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if !trivial {
                crate::stats::log_child(program, started.elapsed().as_millis() as i64, -1);
            }
            format!("failed to spawn `{program}`: {e}")
        })?;

    let status = output.status.code().unwrap_or(-1);
    if !trivial {
        crate::stats::log_child(program, started.elapsed().as_millis() as i64, status);
    }
    Ok(RunOutput {
        status,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// True for the cheap informational probes that are not worth recording.
fn is_trivial_probe(args: &[&str]) -> bool {
    args.iter()
        .any(|a| matches!(*a, "-version" | "-encoders" | "-decoders" | "-filters" | "-hwaccels"))
}

/// Probe a media file, returning raw ffprobe JSON.
pub fn ffprobe_json(path: &Path) -> Result<String, String> {
    let p = path.to_string_lossy().into_owned();
    let out = run(
        "ffprobe",
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &p,
        ],
    )?;

    if !out.success() {
        return Err(format!(
            "ffprobe failed ({}): {}",
            out.status,
            out.stderr.trim()
        ));
    }
    Ok(out.stdout)
}

/// True when the local FFmpeg build exposes the named encoder.
/// Used to decide between QuickSync hardware encode and CPU encode.
pub fn ffmpeg_has_encoder(name: &str) -> bool {
    match run("ffmpeg", &["-hide_banner", "-encoders"]) {
        Ok(out) => {
            let needle = format!(" {name} ");
            // Encoder lines look like: " V....D h264_qsv    libx264 ...".
            out.stdout.lines().any(|line| line.contains(&needle))
        }
        Err(_) => false,
    }
}

/// Snapshot of the hardware encoders this machine can actually use.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HardwareSupport {
    pub qsv: bool,
    pub nvenc: bool,
    pub amf: bool,
}

impl HardwareSupport {
    pub fn detect() -> Self {
        Self {
            qsv: ffmpeg_has_encoder("h264_qsv"),
            nvenc: ffmpeg_has_encoder("h264_nvenc"),
            amf: ffmpeg_has_encoder("h264_amf"),
        }
    }

    /// Best available encoder chain, most preferred first.
    pub fn preferred_chain(&self) -> Vec<&'static str> {
        let mut chain = Vec::new();
        if self.qsv {
            chain.push("h264_qsv");
        }
        if self.nvenc {
            chain.push("h264_nvenc");
        }
        if self.amf {
            chain.push("h264_amf");
        }
        chain
    }
}

/// Result of a streamed run.
#[derive(Debug)]
pub struct StreamOutput {
    pub status: i32,
    /// Last few kilobytes of stderr — enough to explain a failure, bounded so
    /// a chatty child can never inflate this process's heap.
    pub stderr_tail: String,
    /// True when the run was stopped through its cancel flag.
    pub cancelled: bool,
}

impl StreamOutput {
    pub fn success(&self) -> bool {
        self.status == 0 && !self.cancelled
    }
}

/// How much of the child's stderr we keep: the tail of this window is all an
/// error message needs, and it is a hard ceiling on resident memory.
const STDERR_TAIL_MAX: usize = 8 * 1024;
const STDERR_TAIL_KEEP: usize = 4 * 1024;

/// Run a program, handing every line of stdout to `on_line` as it arrives.
///
/// Nothing is ever buffered whole: the keyframe scan of a 5 GB source streams
/// through here line by line, and `-progress pipe:1` reports land on the UI the
/// moment they are written. Passing a cancel flag arms a watcher thread that
/// hard-kills the child the instant the flag flips, which is how the export
/// Cancel button reclaims the CPU immediately.
pub fn run_streaming<A: AsRef<std::ffi::OsStr>>(
    program: &str,
    args: &[A],
    cancel: Option<Arc<AtomicBool>>,
    mut on_line: impl FnMut(&str),
) -> Result<StreamOutput, String> {
    let started = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Drain stderr on its own thread so the child can never block on a full
    // pipe, keeping only a bounded tail.
    let tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let drain = {
        let tail = Arc::clone(&tail);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut buf = match tail.lock() {
                    Ok(b) => b,
                    Err(poisoned) => poisoned.into_inner(),
                };
                append_bounded(&mut buf, &line);
            }
        })
    };

    // Own the handle in a mutex so the watcher can kill while we read.
    let child = Arc::new(Mutex::new(child));
    let watcher = cancel.as_ref().map(|flag| {
        let flag = Arc::clone(flag);
        let handle = Arc::clone(&child);
        thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                let exited = match handle.lock() {
                    Ok(mut c) => matches!(c.try_wait(), Ok(Some(_))),
                    Err(_) => return,
                };
                if exited {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if let Ok(mut c) = handle.lock() {
                let _ = c.kill();
            }
        })
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(&line);
    }

    let status = match child.lock() {
        Ok(mut c) => c
            .wait()
            .map_err(|e| format!("failed to wait for `{program}`: {e}"))?
            .code()
            .unwrap_or(-1),
        Err(_) => -1,
    };
    if let Some(w) = watcher {
        let _ = w.join();
    }
    let _ = drain.join();

    let cancelled = cancel.as_ref().map_or(false, |f| f.load(Ordering::Relaxed));
    let stderr_tail = match Arc::try_unwrap(tail) {
        Ok(mutex) => mutex.into_inner().unwrap_or_default(),
        Err(_) => String::new(),
    };

    // Streaming runs are real workloads (export pieces, chunk extraction) —
    // always worth one telemetry row.
    crate::stats::log_child(program, started.elapsed().as_millis() as i64, status);

    Ok(StreamOutput {
        status,
        stderr_tail,
        cancelled,
    })
}

/// Hard upper bound on how many encoders we probe, so a bad `name` cannot be
/// used to spawn unbounded child processes.
const ENCODER_PROBE_MAX: usize = 32;

/// True when the named encoder can actually produce frames on this machine.
///
/// `ffmpeg -encoders` only lists what the *build* knows about — h264_qsv shows
/// up on every machine with a full build whether or not an Intel iGPU is
/// attached. A 5-frame synthetic encode answers the question that matters at
/// export time: will this encoder work when we hand it a real GOP?
///
/// Each name is probed at most once per process; the answer cannot change
/// mid-run.
pub fn ffmpeg_encoder_usable(name: &str) -> bool {
    static TESTED: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

    let mut tested = match TESTED.lock() {
        Ok(t) => t,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(cache) = tested.as_ref() {
        if let Some(answer) = cache.get(name) {
            return *answer;
        }
    }

    let ok = run(
        "ffmpeg",
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=30",
            "-frames:v",
            "5",
            "-c:v",
            name,
            "-f",
            "null",
            "-",
        ],
    )
    .map(|out| out.success())
    .unwrap_or(false);

    let cache = tested.get_or_insert_with(HashMap::new);
    if cache.len() < ENCODER_PROBE_MAX {
        cache.insert(name.to_string(), ok);
    }
    ok
}

/// Append one line to a stderr tail buffer, trimming back to
/// [`STDERR_TAIL_KEEP`] bytes at a line boundary once it exceeds
/// [`STDERR_TAIL_MAX`]. The buffer never grows past the ceiling.
fn append_bounded(buf: &mut String, line: &str) {
    buf.push_str(line);
    buf.push('\n');
    if buf.len() > STDERR_TAIL_MAX {
        let keep_from = buf.len() - STDERR_TAIL_KEEP;
        let cut = buf[keep_from..]
            .find('\n')
            .map(|i| keep_from + i + 1)
            .unwrap_or(keep_from);
        buf.drain(..cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_tail_stays_bounded_and_keeps_recent_lines() {
        let mut buf = String::new();
        for i in 0..5000 {
            append_bounded(&mut buf, &format!("error line {i:05}"));
        }
        assert!(
            buf.len() <= STDERR_TAIL_MAX,
            "tail grew to {} bytes",
            buf.len()
        );
        assert!(buf.contains("error line 04999"), "newest line survived");
        assert!(!buf.contains("error line 00000"), "oldest line trimmed");
        // Trimming lands on a line boundary: no half-written line at the front.
        assert!(buf.starts_with("error line"));
    }

    #[test]
    fn stderr_tail_keeps_short_output_verbatim() {
        let mut buf = String::new();
        append_bounded(&mut buf, "first");
        append_bounded(&mut buf, "second");
        assert_eq!(buf, "first\nsecond\n");
    }

    #[test]
    fn hardware_support_chain_prefers_qsv_then_nvenc_then_amf() {
        let all = HardwareSupport {
            qsv: true,
            nvenc: true,
            amf: true,
        };
        assert_eq!(
            all.preferred_chain(),
            vec!["h264_qsv", "h264_nvenc", "h264_amf"]
        );
        let cpu_only = HardwareSupport {
            qsv: false,
            nvenc: false,
            amf: false,
        };
        assert!(cpu_only.preferred_chain().is_empty());
    }
}
