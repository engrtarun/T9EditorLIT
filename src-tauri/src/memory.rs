//! Live memory accounting for the top-bar RAM meter.
//!
//! This is the honesty feature of the app: on an 8 GB machine that is already
//! ~80% occupied, "how much is this app costing me right now" must be visible
//! at all times, not guessed at.
//!
//! The app figure sums this process **and all of its descendants** — on Windows
//! a Tauri app is really the Rust host plus several `msedgewebview2.exe`
//! renderers, and reporting only the host PID would badly understate it.

use serde::Serialize;
use std::collections::HashSet;
use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

const BYTES_PER_MB: u64 = 1024 * 1024;

/// Reusable probe. Hold one in Tauri's managed state and call `sample()` —
/// re-creating `System` each time would re-enumerate every process on the box.
pub struct MemoryProbe {
    sys: System,
    root: Pid,
    known_tree: HashSet<Pid>,
    sample_count: u32,
}

impl Default for MemoryProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryProbe {
    pub fn new() -> Self {
        // Refresh ONLY ram + per-process memory. No CPU, disk, network or user
        // lookups — every one of those costs time we do not have on an i3.
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_memory(MemoryRefreshKind::nothing().with_ram())
                .with_processes(ProcessRefreshKind::nothing().with_memory()),
        );

        Self {
            sys,
            root: Pid::from_u32(std::process::id()),
            known_tree: HashSet::new(),
            sample_count: 0,
        }
    }

    /// Take one reading.
    pub fn sample(&mut self) -> MemoryStats {
        self.sys.refresh_memory();
        self.sample_count = self.sample_count.wrapping_add(1);

        // Discover newly spawned children (WebView2 renderers appear in bursts)
        // with a full scan; on every other sample refresh ONLY the processes in
        // our app's tree. Walking 250+ foreign OS processes is the expensive
        // part — ~50 ms of CPU on an i3 plus a realloc of sysinfo's process
        // table — so the cadence below is warm, then steady.
        if self.known_tree.is_empty() || self.scan_due() {
            self.sys.refresh_processes(ProcessesToUpdate::All, true);
            self.update_app_tree();
        } else {
            let pids: Vec<Pid> = self.known_tree.iter().copied().collect();
            self.sys
                .refresh_processes(ProcessesToUpdate::Some(&pids), true);
        }

        let total = self.sys.total_memory();
        let available = self.sys.available_memory();
        let used = self.sys.used_memory();

        let app_bytes = self.app_tree_bytes();
        let app_mb = app_bytes / BYTES_PER_MB;

        let used_percent = if total > 0 {
            (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0) as f32
        } else {
            0.0
        };

        MemoryStats {
            total_mb: total / BYTES_PER_MB,
            used_mb: used / BYTES_PER_MB,
            available_mb: available / BYTES_PER_MB,
            app_mb,
            used_percent,
        }
    }

    /// Whether this sample should walk the whole process table.
    ///
    /// Children arrive in bursts — WebView2 spawns renderers over the first few
    /// seconds, and again when a dialog opens — so the first samples scan often
    /// and then the cadence backs off to about once a minute.
    ///
    /// The back-off is the point: `refresh_processes(All)` walks 250+ foreign
    /// processes, which is ~50 ms of CPU on an i3 plus a reallocation of
    /// sysinfo's process table. At one hit every 8 samples (12 s) that was a
    /// hitch the user could feel while dragging a timeline, for no new
    /// information most of the time.
    fn scan_due(&self) -> bool {
        const WARMUP_SAMPLES: u32 = 16; // first ~24 s of the app's life
        const WARMUP_EVERY: u32 = 4; // …then a full scan every ~6 s
        const STEADY_EVERY: u32 = 40; // …and every ~60 s once settled

        if self.sample_count <= WARMUP_SAMPLES {
            self.sample_count % WARMUP_EVERY == 0
        } else {
            self.sample_count % STEADY_EVERY == 0
        }
    }

    fn update_app_tree(&mut self) {
        let processes = self.sys.processes();
        let mut seen: HashSet<Pid> = HashSet::new();
        seen.insert(self.root);
        let mut frontier = vec![self.root];

        for _ in 0..8 {
            let mut next = Vec::new();
            for (pid, process) in processes {
                if seen.contains(pid) {
                    continue;
                }
                if let Some(parent) = process.parent()
                    && frontier.contains(&parent)
                {
                    seen.insert(*pid);
                    next.push(*pid);
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        self.known_tree = seen;
    }

    /// Resident bytes for this process plus every descendant process.
    fn app_tree_bytes(&self) -> u64 {
        self.known_tree
            .iter()
            .filter_map(|pid| self.sys.process(*pid))
            .map(|process| process.memory())
            .sum()
    }
}

/// One reading, in megabytes, ready for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_mb: u64,
    pub used_mb: u64,
    pub available_mb: u64,
    pub app_mb: u64,
    pub used_percent: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_reports_sane_totals() {
        let mut probe = MemoryProbe::new();
        let stats = probe.sample();

        // Any machine running the test suite has at least 128 MB of RAM.
        assert!(stats.total_mb > 0, "total_memory should be non-zero");
        assert!(stats.used_mb <= stats.total_mb);
        assert!(stats.available_mb <= stats.total_mb);
        assert!((0.0..=100.0).contains(&stats.used_percent));
    }

    #[test]
    fn app_tree_includes_this_process() {
        let mut probe = MemoryProbe::new();
        let stats = probe.sample();
        assert!(
            stats.app_mb > 0,
            "our own process is definitely resident, app_mb should be > 0"
        );
    }
}
