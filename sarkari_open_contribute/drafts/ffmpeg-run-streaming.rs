// Draft sketch for PROPOSAL-20261021-OPENCODE-FFMPEG-RUN-STREAMING
// Non-production. Review before applying.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

pub fn run_streamed(program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {program}: {e}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe {
            let _ = Read::read_to_end(&mut s, &mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_writer = Arc::clone(&stderr_tail);
    let stderr_thread = std::thread::spawn(move || {
        if let Some(s) = stderr_pipe {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                let mut buf = stderr_writer.lock().unwrap();
                if buf.len() > 8192 {
                    buf.clear();
                }
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?.code().unwrap_or(-1);
    let _ = stderr_thread.join();
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_tail.lock().map(|b| b.clone()).unwrap_or_default();

    Ok((status, stdout, stderr))
}
```