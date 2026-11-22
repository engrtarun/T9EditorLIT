//! Keep the machine awake while an export runs (EXPORT.md B1-6).
//!
//! A raw `kernel32` declaration is deliberate: the `windows` crate is not a
//! dependency of the root engine crate, and `SetThreadExecutionState` is a
//! single function in a DLL Windows already links. No new crate, no new CI
//! compile time.
//!
//! `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` keeps the *system* awake — the display
//! is allowed to switch off, which is what a laptop user expects.

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

#[cfg(windows)]
const ES_CONTINUOUS: u32 = 0x8000_0000;
#[cfg(windows)]
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

/// Hold this for the duration of a render. The `Drop` impl clears the request
/// on every normal exit path, including `?` and cancellation.
///
/// `panic = "abort"` in the shipping profile means a panic kills the process
/// before `Drop` runs — which is fine, because there is no process left to
/// keep awake.
pub struct SleepGuard {
    #[cfg(windows)]
    held: bool,
}

impl SleepGuard {
    pub fn acquire() -> Self {
        #[cfg(windows)]
        {
            let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            Self { held: previous != 0 }
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }
}

impl Drop for SleepGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.held {
            let _ = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}
