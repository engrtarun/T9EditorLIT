//! Full machine snapshot for the top-bar meter's "PC details" popover.
//!
//! Everything here is a *read*: no file is opened, no process is scanned
//! beyond what `sysinfo` already tracks, and the whole thing is a single
//! syscall-cheap call so it can be polled once a second without showing up
//! in the CPU budget of an i3.

use serde::Serialize;
use sysinfo::{Disks, Pid, System};

const BYTES_PER_GB: f64 = 1_073_741_824.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    pub total_gb: f64,
    pub available_gb: f64,
    pub used_percent: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDetails {
    pub os_name: String,
    pub os_version: String,
    pub host_name: String,
    pub kernel: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub cpu_usage_percent: f32,
    pub cpu_frequency_mhz: u64,
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub ram_available_gb: f64,
    pub app_memory_mb: u64,
    pub app_cpu_percent: f32,
    pub uptime_hours: f64,
    pub disks: Vec<DiskInfo>,
}

/// Take one snapshot. Refreshes CPU, memory and disk only.
pub fn collect() -> SystemDetails {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let disks = Disks::new_with_refreshed_list();

    let os_name = System::name().unwrap_or_else(|| "Windows".to_string());
    let os_version = System::os_version().unwrap_or_default();
    let host_name = System::host_name().unwrap_or_else(|| "PC".to_string());
    let kernel = System::kernel_version().unwrap_or_default();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "CPU".to_string());
    let cpu_threads = sys.cpus().len();
    let cpu_usage_percent = sys.global_cpu_usage();
    let cpu_frequency_mhz = sys
        .cpus()
        .first()
        .map(|c| c.frequency())
        .unwrap_or(0);

    let pid = Pid::from_u32(std::process::id());
    let app = sys.process(pid);
    let app_memory_mb = app.map(|p| p.memory() / (1024 * 1024)).unwrap_or(0);
    let app_cpu_percent = app.map(|p| p.cpu_usage()).unwrap_or(0.0) as f32;

    let disks = disks
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space() as f64;
            let avail = d.available_space() as f64;
            let used_pct = if total > 0.0 {
                (((total - avail) / total) * 100.0) as f32
            } else {
                0.0
            };
            DiskInfo {
                name: d.name().to_string_lossy().into_owned(),
                mount_point: d.mount_point().to_string_lossy().into_owned(),
                total_gb: (total / BYTES_PER_GB * 100.0).round() / 100.0,
                available_gb: (avail / BYTES_PER_GB * 100.0).round() / 100.0,
                used_percent: (used_pct * 10.0).round() / 10.0,
            }
        })
        .collect();

    SystemDetails {
        os_name,
        os_version,
        host_name,
        kernel,
        cpu_brand,
        cpu_cores: cpu_threads,
        cpu_threads,
        cpu_usage_percent: (cpu_usage_percent * 10.0).round() / 10.0,
        cpu_frequency_mhz,
        ram_total_gb: (sys.total_memory() as f64 / BYTES_PER_GB * 100.0).round() / 100.0,
        ram_used_gb: (sys.used_memory() as f64 / BYTES_PER_GB * 100.0).round() / 100.0,
        ram_available_gb: (sys.available_memory() as f64 / BYTES_PER_GB * 100.0).round() / 100.0,
        app_memory_mb,
        app_cpu_percent,
        uptime_hours: 0.0,
        disks,
    }
}
