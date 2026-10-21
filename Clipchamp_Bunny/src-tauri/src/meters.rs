//! Live system meters for the app's status bar.
//!
//! Everything the footer shows comes from **one** IPC call, once a second:
//!
//!   · RAM       — this app's own tree (host + WebView2 renderers) and the
//!                  machine's total, from the shared `memory::MemoryProbe`.
//!   · Disk      — the drive the app's data folder lives on, used / total.
//!   · App disk  — how many bytes the app itself keeps on disk (database,
//!                  waveform + thumbnail + poster cache, logs).
//!   · Network   — bytes up and down per second, straight from the OS
//!                  interface counters.
//!
//! Why the OS counters and not a speed test:
//!   · a download probe measures the *probe*, not the link — it costs traffic,
//!   · the OS counters are what Task Manager shows, cost nothing, and need no
//!     traffic at all,
//!   · and nothing here touches the Go daemon, which is the other agent's lane.
//!
//! Cost of one sample: a memory refresh, a process-table refresh, a disk list
//! and an interface list. No file is read, no buffer is grown, nothing is
//! cached in the heap — the numbers are the only thing that crosses the IPC.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::Networks;
use tauri::Manager;

use crate::sysinfo_ext;

/// RAM, in megabytes, plus the percentage the machine is using.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RamReading {
    /// This app's whole process tree, in MB.
    pub app_mb: u64,
    /// The machine's total RAM, in MB.
    pub total_mb: u64,
    /// The machine's used RAM, in MB.
    pub used_mb: u64,
    /// The machine's used RAM, in percent.
    pub used_percent: f32,
}

/// The drive the app's data folder lives on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveReading {
    /// Mount point, e.g. `C:\`.
    pub mount: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// Network throughput for the last second.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetReading {
    /// Bytes per second, down.
    pub down_bps: u64,
    /// Bytes per second, up.
    pub up_bps: u64,
    /// The interface the numbers came from.
    pub interface: String,
}

/// The machine's battery.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryReading {
    /// Charge left, 0..100.
    pub percent: u8,
    /// True while the machine is plugged in.
    pub charging: bool,
}

/// Everything the status bar needs, in one shot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub ram: RamReading,
    pub drive: DriveReading,
    /// Bytes the app itself keeps on disk.
    pub app_storage_bytes: u64,
    pub net: NetReading,
    /// `None` on a desktop that has no battery.
    pub battery: Option<BatteryReading>,
}

/* ----------------------------------------------------------------- battery */

/// Windows' `SYSTEM_POWER_STATUS` — the layout is fixed by the Win32 header.
///
/// The call is a single `kernel32` call, so reading the battery once a second
/// costs nothing: no process is spawned, no handle is opened.
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct SystemPowerStatus {
    /// 0 = offline, 1 = on mains, 2 = on backup.
    ac_line_status: u8,
    /// 1 high, 2 low, 4 critical, 8 charging, 128 no battery, 255 unknown.
    battery_flag: u8,
    /// 0..100, or 255 when it cannot be told.
    battery_life_percent: u8,
    _reserved: u8,
    battery_life_time: u32,
    battery_full_life_time: u32,
    battery_low_warn_time: u32,
    battery_low_warn_capacity: u32,
    battery_high_capacity: u32,
    system_status_flag: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
}

/// The battery's charge and whether it is charging.
///
/// `None` on a machine without a battery (a desktop) — there is nothing to
/// show there, and pretending there is would be a lie.
pub fn battery() -> Option<BatteryReading> {
    #[cfg(windows)]
    {
        let mut status = SystemPowerStatus::default();
        // A zero return means the call itself failed.
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return None;
        }
        // 255 = unknown, 128 = no system battery at all.
        if status.battery_life_percent == 255 || status.battery_flag == 128 {
            return None;
        }
        let charging = status.battery_flag & 8 != 0;
        let on_mains = status.ac_line_status == 1;
        Some(BatteryReading {
            percent: status.battery_life_percent.min(100),
            charging: charging || (on_mains && status.battery_life_percent < 100),
        })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/* ------------------------------------------------------------------ network */

/// Reads the OS interface counters once a second.
///
/// `sysinfo` already gives the **delta** since the last refresh, so there is
/// no counter arithmetic here and no wrap-around to get wrong. The elapsed
/// time is measured anyway, so the number stays correct even if the caller
/// polls at a different rhythm.
pub struct NetworkProbe {
    nets: Networks,
    last: Instant,
}

impl Default for NetworkProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkProbe {
    pub fn new() -> Self {
        Self {
            nets: Networks::new_with_refreshed_list(),
            last: Instant::now(),
        }
    }

    /// Take one reading: bytes per second, up and down.
    pub fn sample(&mut self) -> NetReading {
        self.nets.refresh(true);
        let elapsed = self.last.elapsed().as_secs_f64().max(0.001);
        self.last = Instant::now();

        // One interface, the busiest one. Summing every adapter would count a
        // VPN tunnel and the physical link twice for the same bytes.
        let mut best: Option<(u64, u64, String)> = None;
        for (name, data) in self.nets.iter() {
            if is_loopback(name) {
                continue;
            }
            let down = data.received();
            let up = data.transmitted();
            if down == 0 && up == 0 {
                continue;
            }
            let better = match &best {
                Some((bd, bu, _)) => down + up > bd + bu,
                None => true,
            };
            if better {
                best = Some((down, up, name.clone()));
            }
        }

        match best {
            Some((down, up, name)) => NetReading {
                down_bps: (down as f64 / elapsed) as u64,
                up_bps: (up as f64 / elapsed) as u64,
                interface: name,
            },
            None => NetReading {
                down_bps: 0,
                up_bps: 0,
                interface: String::new(),
            },
        }
    }
}

/// Loopback is the adapter the app talks to the daemon over — it is not the
/// internet link, so it never counts.
fn is_loopback(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("loopback") || lower == "lo"
}

/* -------------------------------------------------------------- app storage */

/// How much disk the **app itself** uses.
///
/// The walk is a streaming directory traversal: it adds up file lengths and
/// keeps nothing but a counter, so a cache with thousands of frames still
/// costs no memory. It is not walked every second — the answer is refreshed
/// at most every [`STORAGE_TTL`], and the cached value is what the UI shows.
pub struct AppStorageProbe {
    state: Mutex<StorageState>,
}

struct StorageState {
    bytes: u64,
    refreshed: Option<Instant>,
}

/// How long a cached size is trusted before the folder is walked again.
const STORAGE_TTL: Duration = Duration::from_secs(20);

impl Default for AppStorageProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl AppStorageProbe {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(StorageState {
                bytes: 0,
                refreshed: None,
            }),
        }
    }

    /// Bytes under `root`, refreshed at most every [`STORAGE_TTL`].
    pub fn sample(&self, root: &Path) -> u64 {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let due = state
            .refreshed
            .map(|t| t.elapsed() >= STORAGE_TTL)
            .unwrap_or(true);
        if due {
            state.bytes = dir_size(root);
            state.refreshed = Some(Instant::now());
        }
        state.bytes
    }
}

/// Total size of everything under `root`.
///
/// Iterative on purpose: a deep cache must not blow the stack, and the only
/// thing kept while walking is the size counter.
fn dir_size(root: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/* ----------------------------------------------------------------- command */

/// One reading of every meter the status bar shows.
#[tauri::command]
pub fn system_snapshot(
    app: tauri::AppHandle,
    probe: tauri::State<'_, Mutex<crate::memory::MemoryProbe>>,
    net: tauri::State<'_, Mutex<NetworkProbe>>,
    storage: tauri::State<'_, AppStorageProbe>,
) -> Result<SystemSnapshot, String> {
    let ram = probe
        .lock()
        .map_err(|_| "memory probe lock poisoned".to_string())?
        .sample();
    let net = net
        .lock()
        .map_err(|_| "network probe lock poisoned".to_string())?
        .sample();

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app data folder: {e}"))?;

    let drive = match sysinfo_ext::drive_space(&dir) {
        Some(d) => DriveReading {
            mount: d.drive,
            total_bytes: d.total_bytes,
            free_bytes: d.free_bytes,
        },
        None => DriveReading {
            mount: String::new(),
            total_bytes: 0,
            free_bytes: 0,
        },
    };

    Ok(SystemSnapshot {
        ram: RamReading {
            app_mb: ram.app_mb,
            total_mb: ram.total_mb,
            used_mb: ram.used_mb,
            used_percent: ram.used_percent,
        },
        drive,
        app_storage_bytes: storage.sample(&dir),
        net,
        battery: battery(),
    })
}

/* ------------------------------------------------------------------- clock */

/// Set the machine's clock (and optionally its time zone).
///
/// Windows only lets a process with the right privilege move the system
/// clock, so this can and does fail — and when it does, the **real** error is
/// handed back so the UI can say "admin chahiye" instead of pretending.
///
/// The date is given in UTC (`Z`), so no timezone maths happens here: the
/// shell interprets it and converts.
#[tauri::command]
pub fn set_system_clock(time_zone: Option<String>, utc_iso: String) -> Result<String, String> {
    if utc_iso.trim().is_empty() {
        return Err("no time given".to_string());
    }

    let mut script = String::new();
    if let Some(tz) = time_zone
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // Single quotes are escaped so a zone name can never break out of the
        // quoted argument.
        script.push_str(&format!("Set-TimeZone -Id '{}'; ", tz.replace('\'', "''")));
    }
    script.push_str(&format!(
        "Set-Date -Date '{}'",
        utc_iso.trim().replace('\'', "''")
    ));

    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("could not run PowerShell: {e}"))?;

    if out.status.success() {
        return Ok("System clock updated".to_string());
    }

    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    if err.is_empty() {
        return Err("the system clock could not be changed".to_string());
    }
    // Windows says "Access denied" for a missing privilege; say so plainly.
    if err.to_ascii_lowercase().contains("access is denied")
        || err.to_ascii_lowercase().contains("access denied")
    {
        return Err("System clock change karne ke liye administrator chahiye hai".to_string());
    }
    Err(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_counts_a_tree() {
        let dir = std::env::temp_dir().join("t9-meters-dir-size");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("nested/b.bin"), vec![0u8; 250]).unwrap();

        let total = dir_size(&dir);
        assert!(total >= 350, "expected at least 350 bytes, got {total}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_size_of_a_missing_folder_is_zero() {
        assert_eq!(dir_size(Path::new("C:/definitely/not/here")), 0);
    }

    #[test]
    fn loopback_interfaces_are_never_counted() {
        assert!(is_loopback("Loopback Pseudo-Interface 1"));
        assert!(is_loopback("lo"));
        assert!(!is_loopback("Wi-Fi"));
        assert!(!is_loopback("Ethernet"));
    }

    /// A desktop has no battery, and a machine with one always reports a sane
    /// percentage. Either way the reading must not be nonsense.
    #[test]
    fn the_battery_reading_is_sane() {
        match battery() {
            None => { /* a desktop - nothing to show */ }
            Some(b) => {
                assert!(b.percent <= 100, "percent out of range: {}", b.percent);
            }
        }
    }
}
