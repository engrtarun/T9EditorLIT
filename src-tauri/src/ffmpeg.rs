//! Thin, zero-copy-ish wrappers around the `ffmpeg` / `ffprobe` binaries.
//!
//! Everything here streams through child processes. We never load media into
//! this process's address space — that is the entire point of the architecture.

use std::path::Path;
use std::process::{Command, Stdio};

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
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;

    Ok(RunOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
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
