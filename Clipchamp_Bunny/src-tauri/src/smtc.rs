//! Windows media flyout (SMTC) for the in-built browser.
//!
//! Chromium normally owns one media session per page. In a WebView2 child
//! that session belongs to `msedgewebview2.exe`, so the flyout said "Unknown
//! app", the earbud's next/previous buttons went to a session the app could
//! not see, and two sessions fought over the hardware media keys.
//!
//! This module owns exactly one session for the whole app instead:
//!
//!   page shim ──`{ t9: 'media', … }`──▶ `smtc::update` ──▶ SMTC metadata,
//!   icon, transport buttons, timeline
//!
//!   earbud / media key / flyout button ──▶ SMTC `ButtonPressed`
//!        ──▶ `window.__t9MediaAction('next')` in the owning page
//!
//! The identity is the process AUMID (set in `lib.rs`, matched by the
//! Start-menu shortcut), so Windows shows "T9 Editor LIT" and the brand icon
//! instead of a webview process with no name. Chromium's own session is
//! switched off per tab webview with `--disable-features=MediaSessionService`
//! in `browser.rs`; this is the only session left, which is also why the
//! earbud buttons are fast: there is no second owner to arbitrate with.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::Runtime;

/// What a page's shim reports about its media element. Every field is
/// optional on the wire so a page that only knows `state` never fails to
/// deserialize, and `serde` ignores the `t9` marker the shim also sends.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct MediaReport {
    /// `playing`, `paused`, or `none` (no media element / it was emptied).
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    /// Artwork URL from `navigator.mediaSession.metadata`; unused by the
    /// Windows flyout (the brand icon is the app identity), kept so the UI
    /// can show it without another IPC round-trip.
    #[serde(default)]
    pub artwork: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub rate: f64,
    /// The page registered `nexttrack` / `previoustrack`, so the flyout's
    /// arrows would do something. Buttons that do nothing are worse than
    /// buttons that are not there.
    #[serde(default)]
    pub next: bool,
    #[serde(default)]
    pub prev: bool,
}

/// A transport button the user pressed (flyout, keyboard media key, or the
/// earbud). The frontend may show a toast; the page acts on it either way.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaButtonPayload {
    pub action: String,
}

/// Create the session for the main window. Called once from `setup`; a
/// failure degrades to "no flyout session", never to a broken launch.
pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "windows")]
    win::install(app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// A page reported its media state. The tab id comes from the webview
/// closure, never from the payload.
pub fn update<R: Runtime>(app: &tauri::AppHandle<R>, id: &str, report: MediaReport) {
    #[cfg(target_os = "windows")]
    win::update(app, id, report);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, id, report);
}

/// A tab's webview is gone (tab closed, or unpinned while in the background).
/// If it was the media owner the flyout must not keep claiming it is playing.
pub fn tab_closed<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    #[cfg(target_os = "windows")]
    win::tab_closed(app, id);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, id);
}

/// The browser view unmounted. Pinned tabs keep their webviews (that is the
/// point of pinning: listen while editing), so only a non-pinned owner is
/// dropped. Every other webview was destroyed by the sweep.
pub fn tabs_swept<R: Runtime>(app: &tauri::AppHandle<R>, pinned: &HashSet<String>) {
    #[cfg(target_os = "windows")]
    win::tabs_swept(app, pinned);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, pinned);
}

#[cfg(target_os = "windows")]
mod win {
    use super::{MediaButtonPayload, MediaReport};
    use crate::browser::diag;

    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    use tauri::{Emitter, Manager, Runtime};

    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
        SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::Streams::{
        DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference,
    };
    use windows::Win32::System::WinRT::{
        ISystemMediaTransportControlsInterop, RoGetActivationFactory,
    };
    use windows::core::HSTRING;

    /// The one session for the app, plus the page that currently feeds it.
    /// `SystemMediaTransportControls` is a COM object and is `Send`; the
    /// mutex makes the state `Sync` for Tauri's managed-state table.
    #[derive(Default)]
    pub(super) struct SmtcState {
        controls: Mutex<Option<SystemMediaTransportControls>>,
        /// Tab id whose page is on the flyout. `None` means nothing is open,
        /// so a media key press is a no-op instead of going to a dead tab.
        owner: Mutex<Option<String>>,
        /// Latest report per tab. Ownership must not follow heartbeats: a
        /// pinned YouTube tab playing in the background reports every 1.5 s
        /// and would steal the flyout back from the tab the user just
        /// started. The map also lets a closed tab hand the session to a
        /// surviving page without waiting for its next report.
        reports: Mutex<HashMap<String, MediaReport>>,
        /// Last painted report, used to skip metadata calls on position-only
        /// heartbeats (re-setting the title every 1.5 s makes the flyout
        /// flicker).
        last: Mutex<MediaReport>,
        /// The brand icon as a WinRT stream reference. Created once; a
        /// `RandomAccessStreamReference` is immutable and cheap to clone.
        thumb: Mutex<Option<RandomAccessStreamReference>>,
    }

    pub(super) fn install<R: Runtime>(app: &tauri::AppHandle<R>) {
        app.manage(SmtcState::default());

        let Some(window) = app.get_window("main") else {
            diag("smtc -> main window missing");
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            diag("smtc -> no hwnd");
            return;
        };

        // `SystemMediaTransportControls` is a Windows Runtime class; the
        // interop factory is the only way to bind it to a desktop HWND. The
        // generic RoGetActivationFactory casts straight to the interop
        // interface, so no `IInspectable` juggling is needed.
        let factory: ISystemMediaTransportControlsInterop = match unsafe {
            RoGetActivationFactory(&HSTRING::from("Windows.Media.SystemMediaTransportControls"))
        } {
            Ok(factory) => factory,
            Err(error) => {
                diag(&format!("smtc -> factory failed: {error}"));
                return;
            }
        };
        let controls: SystemMediaTransportControls = match unsafe { factory.GetForWindow(hwnd) } {
            Ok(controls) => controls,
            Err(error) => {
                diag(&format!("smtc -> GetForWindow failed: {error}"));
                return;
            }
        };

        // Transport surface: play/pause/stop and ±10 s are always useful;
        // next/previous turn on only when the page registered handlers (a
        // YouTube playlist does, an article does not).
        let _ = controls.SetIsEnabled(true);
        let _ = controls.SetIsPlayEnabled(true);
        let _ = controls.SetIsPauseEnabled(true);
        let _ = controls.SetIsStopEnabled(true);
        let _ = controls.SetIsFastForwardEnabled(true);
        let _ = controls.SetIsRewindEnabled(true);
        let _ = controls.SetIsNextEnabled(false);
        let _ = controls.SetIsPreviousEnabled(false);
        let _ = controls.SetIsRecordEnabled(false);
        let _ = controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);

        let button_handle = app.clone();
        let button = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_sender, args| {
            if let Some(args) = args.as_ref()
                && let Ok(button) = args.Button()
            {
                let action = match button {
                    SystemMediaTransportControlsButton::Play => Some("play"),
                    SystemMediaTransportControlsButton::Pause => Some("pause"),
                    SystemMediaTransportControlsButton::Stop => Some("stop"),
                    SystemMediaTransportControlsButton::Next => Some("next"),
                    SystemMediaTransportControlsButton::Previous => Some("prev"),
                    SystemMediaTransportControlsButton::FastForward => Some("forward"),
                    SystemMediaTransportControlsButton::Rewind => Some("rewind"),
                    _ => None,
                };
                if let Some(action) = action {
                    act(&button_handle, action, None);
                }
            }
            Ok(())
        });
        if let Err(error) = controls.ButtonPressed(&button) {
            diag(&format!("smtc -> button handler failed: {error}"));
        }

        // The flyout's seek bar. Windows raises this when the user drags it;
        // forwarding it as a `seek` action keeps the bar honest instead of
        // letting Windows paint a position the page never adopted.
        let seek_handle = app.clone();
        let seek = TypedEventHandler::<
            SystemMediaTransportControls,
            PlaybackPositionChangeRequestedEventArgs,
        >::new(move |_sender, args| {
            if let Some(args) = args.as_ref()
                && let Ok(position) = args.RequestedPlaybackPosition()
            {
                let seconds = position.Duration.max(0) as f64 / 10_000_000.0;
                act(&seek_handle, "seek", Some(seconds));
            }
            Ok(())
        });
        if let Err(error) = controls.PlaybackPositionChangeRequested(&seek) {
            diag(&format!("smtc -> seek handler failed: {error}"));
        }

        let state = app.state::<SmtcState>();
        if let Ok(mut slot) = state.controls.lock() {
            *slot = Some(controls);
        }
        if let Ok(mut slot) = state.thumb.lock()
            && let Some(thumb) = thumbnail()
        {
            *slot = Some(thumb);
        }
        diag("smtc -> enabled");
    }

    pub(super) fn update<R: Runtime>(app: &tauri::AppHandle<R>, id: &str, report: MediaReport) {
        let state = app.state::<SmtcState>();
        let Some(controls) = state.controls.lock().ok().and_then(|slot| slot.clone()) else {
            return;
        };

        let kind = report.state.as_str();
        let live = kind == "playing" || kind == "paused";

        // Remember this tab's report (and whether it *started* playing).
        // Only a fresh play takes the flyout over; heartbeats from the tab
        // that already owns it change nothing.
        let started = state
            .reports
            .lock()
            .map(|mut reports| {
                let was_playing = reports
                    .get(id)
                    .map(|last| last.state == "playing")
                    .unwrap_or(false);
                reports.insert(id.to_string(), report.clone());
                kind == "playing" && !was_playing
            })
            .unwrap_or(false);

        // One owner. Rules, in order:
        //   1. the current owner keeps it while it is live (paused included:
        //      the flyout must show the item so play/pause can resume it),
        //   2. a tab that just started playing takes it over,
        //   3. with no owner, a playing tab wins; a paused one is shown only
        //      when nothing else has media (a just-loaded YouTube page).
        // A tab that is not the owner returns here, so a background pinned
        // video can never overwrite the active page's title or timeline.
        let owner = {
            let mut slot = match state.owner.lock() {
                Ok(slot) => slot,
                Err(_) => return,
            };
            let current = slot.clone();
            if current.as_deref() == Some(id) {
                if kind == "none" {
                    *slot = None;
                }
            } else if kind == "playing" && (current.is_none() || started) {
                *slot = Some(id.to_string());
            } else if kind != "none" && current.is_none() {
                *slot = Some(id.to_string());
            }
            slot.clone()
        };
        if owner.as_deref() != Some(id) {
            return;
        }

        // Metadata only when something visible changed. Position arrives
        // every ~1.5 s while playing and must not repaint the flyout.
        let changed = match state.last.lock() {
            Ok(mut last) => {
                let changed = last.state != report.state
                    || last.title != report.title
                    || last.artist != report.artist
                    || last.artwork != report.artwork
                    || last.next != report.next
                    || last.prev != report.prev
                    || (last.duration - report.duration).abs() > 1.0;
                *last = report.clone();
                changed
            }
            Err(_) => false,
        };

        if !live {
            // The owner stopped. Hand the flyout to another live page
            // immediately instead of leaving a dead title on screen; only
            // when nothing else has media does the session close.
            if promote(app, id) {
                diag(&format!("media {id} -> none, handed over"));
                return;
            }
            if changed {
                close(&controls);
                diag(&format!("media {id} -> none"));
            }
            return;
        }

        if changed {
            if let Ok(updater) = controls.DisplayUpdater() {
                // Music, not Video: the flyout's compact card shows
                // title/artist on one line pair, which is what a YouTube
                // video ("channel" under the title) actually is.
                let _ = updater.SetType(MediaPlaybackType::Music);
                if let Ok(props) = updater.MusicProperties() {
                    let _ = props.SetTitle(&HSTRING::from(report.title.as_str()));
                    let _ = props.SetArtist(&HSTRING::from(report.artist.as_str()));
                    let _ = props.SetAlbumTitle(&HSTRING::from(report.album.as_str()));
                }
                if let Some(thumb) = state.thumb.lock().ok().and_then(|slot| slot.clone()) {
                    let _ = updater.SetThumbnail(&thumb);
                }
                let _ = updater.Update();
            }
            let _ = controls.SetIsNextEnabled(report.next);
            let _ = controls.SetIsPreviousEnabled(report.prev);
            diag(&format!(
                "media {id} -> {kind} {:?} by {:?}",
                report.title, report.artist
            ));
        }

        let status = if kind == "playing" {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        };
        let _ = controls.SetPlaybackStatus(status);
        if report.rate.is_finite() && report.rate > 0.0 {
            let _ = controls.SetPlaybackRate(report.rate.clamp(0.25, 4.0));
        }

        if report.duration.is_finite() && report.duration > 0.0 {
            let ticks = |seconds: f64| TimeSpan {
                Duration: (seconds.max(0.0) * 10_000_000.0) as i64,
            };
            if let Ok(timeline) = SystemMediaTransportControlsTimelineProperties::new() {
                let _ = timeline.SetStartTime(TimeSpan { Duration: 0 });
                let _ = timeline.SetMinSeekTime(TimeSpan { Duration: 0 });
                let _ = timeline.SetMaxSeekTime(ticks(report.duration));
                let _ = timeline.SetEndTime(ticks(report.duration));
                let _ = timeline.SetPosition(ticks(report.position));
                let _ = controls.UpdateTimelineProperties(&timeline);
            }
        }
    }

    /// Give the session to the best surviving page (a playing one first).
    /// Used when the owner pauses/stops or its tab closes; it calls `update`
    /// with that page's last report so the flyout repaints at once instead of
    /// waiting for the next 1.5 s heartbeat.
    fn promote<R: Runtime>(app: &tauri::AppHandle<R>, exclude: &str) -> bool {
        let next = {
            let state = app.state::<SmtcState>();
            let Ok(reports) = state.reports.lock() else {
                return false;
            };
            reports
                .iter()
                .filter(|(tab, report)| tab.as_str() != exclude && report.state != "none")
                .max_by_key(|(_, report)| report.state == "playing")
                .map(|(tab, report)| (tab.clone(), report.clone()))
        };
        if let Some((tab, report)) = next {
            super::update(app, &tab, report);
            true
        } else {
            false
        }
    }

    pub(super) fn tab_closed<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
        let state = app.state::<SmtcState>();
        if let Ok(mut reports) = state.reports.lock() {
            reports.remove(id);
        }
        let was_owner = state
            .owner
            .lock()
            .map(|mut owner| {
                let matches = owner.as_deref() == Some(id);
                if matches {
                    *owner = None;
                }
                matches
            })
            .unwrap_or(false);
        if !was_owner {
            return;
        }
        if promote(app, id) {
            diag(&format!("media {id} -> closed tab, handed over"));
            return;
        }
        if let Some(controls) = state.controls.lock().ok().and_then(|slot| slot.clone()) {
            close(&controls);
            if let Ok(mut last) = state.last.lock() {
                *last = MediaReport::default();
            }
            diag(&format!("media {id} -> closed tab"));
        }
    }

    pub(super) fn tabs_swept<R: Runtime>(app: &tauri::AppHandle<R>, pinned: &HashSet<String>) {
        let state = app.state::<SmtcState>();
        if let Ok(mut reports) = state.reports.lock() {
            // Every non-pinned webview was just destroyed; their reports are
            // stale and must not be promoted back onto the flyout.
            reports.retain(|tab, _| pinned.contains(tab));
        }
        let owner = state.owner.lock().ok().and_then(|owner| owner.clone());
        if let Some(id) = owner
            && !pinned.contains(&id)
        {
            tab_closed(app, &id);
        }
    }

    /// Forward one transport action into the owning page. The page's own
    /// `navigator.mediaSession` handlers are the target: they know about ads,
    /// playlists and the SPA player, which a bare `<video>` does not.
    fn act<R: Runtime>(app: &tauri::AppHandle<R>, action: &str, value: Option<f64>) {
        let Some(id) = app
            .state::<SmtcState>()
            .owner
            .lock()
            .ok()
            .and_then(|owner| owner.clone())
        else {
            return;
        };
        let _ = app.emit(
            "browser:media-button",
            MediaButtonPayload {
                action: action.to_string(),
            },
        );
        let Some(webview) = app.get_webview(&crate::browser::label_for(&id)) else {
            return;
        };
        let script = match value {
            Some(value) if value.is_finite() => {
                format!("window.__t9MediaAction&&window.__t9MediaAction({action:?},{value});")
            }
            _ => format!("window.__t9MediaAction&&window.__t9MediaAction({action:?});"),
        };
        let _ = webview.eval(&script);
        diag(&format!("media button {action} -> {id}"));
    }

    fn close(controls: &SystemMediaTransportControls) {
        let _ = controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        let _ = controls.SetIsNextEnabled(false);
        let _ = controls.SetIsPreviousEnabled(false);
        if let Ok(updater) = controls.DisplayUpdater() {
            let _ = updater.ClearAll();
            let _ = updater.Update();
        }
    }

    /// The brand icon (the same PNG the exe's icon set is generated from) as
    /// a WinRT stream. Windows shows it as the media artwork, so the flyout
    /// is "T9 Editor LIT" with the real mark even before a page sends art.
    fn thumbnail() -> Option<RandomAccessStreamReference> {
        let bytes = include_bytes!("../icons/128x128.png");
        let stream = InMemoryRandomAccessStream::new().ok()?;
        let writer = DataWriter::CreateDataWriter(&stream).ok()?;
        writer.WriteBytes(bytes).ok()?;
        writer.StoreAsync().ok()?.join().ok()?;
        stream.Seek(0).ok()?;
        RandomAccessStreamReference::CreateFromStream(&stream).ok()
    }
}
