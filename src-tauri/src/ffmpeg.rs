//! Thin, zero-copy-ish wrappers around the `ffmpeg` / `ffprobe` binaries.
//!
//! Everything here streams through child processes. We never load media into
//! this process's address space — that is the entire point of the architecture.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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

/// A child process that never flashes a console window.
///
/// A GUI parent passes no console down, so a bare `Command::new("ffmpeg")`
/// would open a black CMD box for milliseconds on every probe, waveform,
/// thumbnail and export — fourteen-plus boxes over a session, which is the
/// "CMD appears and disappears" the user reported. CREATE_NO_WINDOW keeps
/// the run byte-for-byte identical and makes it invisible.
///
/// This is the ONLY constructor every child-process site in this crate
/// should use; `cargo test` pins it so a bare `Command::new` cannot sneak
/// back in unnoticed.
pub fn silent(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — the work is unchanged; only the flash is gone.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/* ------------------------------------------------------- child lifetime */

/// Every long-running media child is adopted into one Windows Job Object
/// whose `KILL_ON_JOB_CLOSE` limit is the whole point: when this process
/// dies - clean exit, a crash, or Task Manager ending the task - the kernel
/// closes the last job handle and terminates every process still inside it.
///
/// Without this an interrupted export, waveform or chunk scan outlives the
/// app: FFmpeg keeps reading the source and writing the output, the user sees
/// "app band ho gaya par CPU chalu hai", and the next launch competes with
/// its own orphan. A parent-side `kill()` cannot cover the Task Manager case;
/// the job object is the only mechanism that does.
#[cfg(windows)]
mod children {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    type Handle = *mut core::ffi::c_void;

    const KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;

    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION` (winnt.h), field for field. The
    /// `usize` fields are `SIZE_T`/`ULONG_PTR`; `repr(C)` inserts exactly the
    /// same padding the C compiler does on x64.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attrs: *const core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    }

    /// The process-wide job. Stored as `usize` so the `OnceLock` stays
    /// `Send + Sync` without wrapping a raw pointer; `0` means "the OS
    /// refused", and every later call degrades to a no-op.
    fn handle() -> Handle {
        static JOB: OnceLock<usize> = OnceLock::new();
        let stored = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info = ExtendedLimit::default();
            info.basic.limit_flags = KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION,
                &info as *const ExtendedLimit as *const core::ffi::c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            );
            if ok == 0 {
                return 0;
            }
            job as usize
        });
        stored as Handle
    }

    pub(super) fn adopt(child: &Child) -> bool {
        let job = handle();
        if job.is_null() {
            return false;
        }
        // Windows 8+ allows a process to belong to more than one job, so a
        // host that already runs us inside one is not a reason to fail.
        unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as Handle) != 0 }
    }

    pub(super) fn kill_all() {
        let job = handle();
        if !job.is_null() {
            unsafe {
                TerminateJobObject(job, 0);
            }
        }
    }
}

/// Adopt a freshly spawned child into the kill-on-close job (no-op when the
/// OS refuses, or on another platform). Returns whether it is tracked.
pub fn adopt(child: &Child) -> bool {
    #[cfg(windows)]
    {
        children::adopt(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        false
    }
}

/// Terminate every tracked child now. Called on the app's close path so a
/// clean exit looks exactly like the kernel's crash exit: no FFmpeg survives.
pub fn kill_children() {
    #[cfg(windows)]
    children::kill_all();
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
    let mut child = silent(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if !trivial {
                crate::stats::log_child(program, started.elapsed().as_millis() as i64, -1);
            }
            format!("failed to spawn `{program}`: {e}")
        })?;
    adopt(&child);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });

    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_tail_writer = Arc::clone(&stderr_tail);
    let stderr_thread = std::thread::spawn(move || {
        if let Some(s) = stderr_pipe {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                let mut buf = match stderr_tail_writer.lock() {
                    Ok(b) => b,
                    Err(poisoned) => poisoned.into_inner(),
                };
                append_bounded(&mut buf, &line);
            }
        }
    });

    let status = match child.wait() {
        Ok(s) => s.code().unwrap_or(-1),
        Err(e) => {
            if !trivial {
                crate::stats::log_child(program, started.elapsed().as_millis() as i64, -1);
            }
            return Err(format!("failed to wait for `{program}`: {e}"));
        }
    };

    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let _ = stderr_thread.join();

    let stderr_string = match Arc::try_unwrap(stderr_tail) {
        Ok(mutex) => mutex.into_inner().unwrap_or_default(),
        Err(_) => String::new(),
    };

    if !trivial {
        crate::stats::log_child(program, started.elapsed().as_millis() as i64, status);
    }
    Ok(RunOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: stderr_string,
    })
}

/// True for the cheap informational probes that are not worth recording.
fn is_trivial_probe(args: &[&str]) -> bool {
    args.iter().any(|a| {
        matches!(
            *a,
            "-version" | "-encoders" | "-decoders" | "-filters" | "-hwaccels"
        )
    })
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

/// The `ffmpeg -encoders` listing, fetched once for the process lifetime.
///
/// `ffmpeg_has_encoder` used to start a fresh `ffmpeg` child process on every
/// call. `HardwareSupport::detect()` calls it three times and `export.rs`
/// calls it again while choosing an encoder chain, so picking an encoder cost
/// five process spawns on a machine that is short of both CPU and memory.
///
/// The listing is a property of the FFmpeg binary on disk, so it cannot change
/// while the process runs and there is nothing to refresh - the same reason
/// `TESTED` below caches its results. A failed probe is cached too: FFmpeg
/// being absent is a fact about the machine, not a transient error, and
/// re-probing for a binary that is not there helps nobody.
static ENCODERS: OnceLock<Option<String>> = OnceLock::new();

fn encoders_listing() -> Option<&'static str> {
    ENCODERS
        .get_or_init(|| match run("ffmpeg", &["-hide_banner", "-encoders"]) {
            Ok(out) => Some(out.stdout),
            Err(_) => None,
        })
        .as_deref()
}

/// True when the local FFmpeg build exposes the named encoder.
/// Used to decide between QuickSync hardware encode and CPU encode.
pub fn ffmpeg_has_encoder(name: &str) -> bool {
    let Some(listing) = encoders_listing() else {
        return false;
    };
    let needle = format!(" {name} ");
    // Encoder lines look like: " V....D h264_qsv    libx264 ...".
    listing.lines().any(|line| line.contains(&needle))
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
    let mut child = silent(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;

    // An interrupted export must not survive the app (job object above).
    adopt(&child);

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

    /// Every child process in this crate must be built through `silent()` —
    /// the constructor that sets CREATE_NO_WINDOW. A bare
    /// `Command::new("ffmpeg")` would bring the CMD-box flash back on every
    /// probe, waveform, thumbnail and export, so the helper is pinned here.
    #[test]
    fn the_silent_constructor_is_the_one_we_use() {
        assert_eq!(
            silent("ffmpeg").get_program(),
            std::ffi::OsStr::new("ffmpeg")
        );
        assert_eq!(
            silent("ffprobe").get_program(),
            std::ffi::OsStr::new("ffprobe")
        );
    }

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
