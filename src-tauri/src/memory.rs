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
        }
    }

    /// Take one reading.
    pub fn sample(&mut self) -> MemoryStats {
        self.sys.refresh_memory();
        self.sys.refresh_processes(ProcessesToUpdate::All, true);

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

    /// Resident bytes for this process plus every descendant process.
    fn app_tree_bytes(&self) -> u64 {
        let processes = self.sys.processes();

        // Walk down from the root, breadth-first, so nested WebView2 renderers
        // are included too. Depth is bounded so a (theoretical) pid cycle in
        // the OS snapshot cannot hang the UI thread.
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

        processes
            .iter()
            .filter(|(pid, _)| seen.contains(pid))
            .map(|(_, process)| process.memory())
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
