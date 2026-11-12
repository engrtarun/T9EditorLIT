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
//!
//! The flyout also takes the page's own artwork (`mediaSession.metadata`
//! artwork) as its thumbnail, so a YouTube video shows its thumbnail instead
//! of a generic icon; the brand mark stays the fallback and the app identity
//! never changes.
//!
//! Windows' flyout has no room for `02:22 / 18:11` and its seek bar is not
//! draggable on every build, so every accepted report is also emitted to the
//! frontend as `browser:media`. That is what the OSD flyout
//! (`media_flyout.rs` / `MediaFlyout.svelte`) draws — thumbnail, clock,
//! draggable seek — and what its slider drives through
//! `browser_media_action`. It keeps working even if the SMTC session itself
//! failed to create.

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

/// What the OSD flyout needs: the owning tab, the page's metadata, and the
/// position/duration pair that makes the timeline. Sent as `browser:media`;
/// `state: "none"` is the explicit "nothing is playing, take the card away"
/// signal.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    pub tab: String,
    pub state: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: String,
    pub position: f64,
    pub duration: f64,
    pub rate: f64,
    pub next: bool,
    pub prev: bool,
}

impl MediaSnapshot {
    fn cleared() -> Self {
        Self {
            state: "none".to_string(),
            ..Self::default()
        }
    }
}

fn snapshot_of(id: &str, report: &MediaReport) -> MediaSnapshot {
    MediaSnapshot {
        tab: id.to_string(),
        state: report.state.clone(),
        title: report.title.clone(),
        artist: report.artist.clone(),
        album: report.album.clone(),
        artwork: report.artwork.clone(),
        position: report.position,
        duration: report.duration,
        rate: report.rate,
        next: report.next,
        prev: report.prev,
    }
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

/// What the OSD flyout should show right now. `None` when nothing owns
/// the session. The frontend calls this once on mount so a paused video that
/// stopped heartbeating still paints the card after the window re-opens.
pub fn snapshot<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<MediaSnapshot> {
    #[cfg(target_os = "windows")]
    {
        win::snapshot(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

/// Forward one transport action from the OSD flyout. Same target as the
/// Win+A card and the earbud: `window.__t9MediaAction(...)` in the owning
/// page.
pub fn action<R: Runtime>(app: &tauri::AppHandle<R>, action: &str, value: Option<f64>) {
    #[cfg(target_os = "windows")]
    win::act(app, action, value);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, action, value);
}

#[cfg(target_os = "windows")]
mod win {
    use super::{MediaButtonPayload, MediaReport, MediaSnapshot, snapshot_of};
    use crate::browser::diag;

    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    use tauri::{Emitter, Manager, Runtime};

    use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
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
        /// The page's artwork, cached by URL. Windows downloads the URI
        /// itself the first time the flyout asks for it; recreating the
        /// reference on every heartbeat would flash the old thumbnail.
        art: Mutex<Option<(String, RandomAccessStreamReference)>>,
        /// Whether the Win+A card / the OSD flyout currently show a live item.
        /// A repeated `state: "none"` from a page that never owned anything
        /// must not emit endless clear events.
        shown: Mutex<bool>,
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

        // Start **disabled**. An SMTC session that is enabled with no media
        // is exactly the ghost card the user saw in Win+A: "T9 Editor LIT"
        // with no title, no thumbnail, nothing playing. A session appears
        // only when a page reports real playback (`update` enables it) and
        // disappears when the last page stops (`close` disables it).
        let _ = controls.SetIsEnabled(false);
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

        // The Win+A card's seek bar. Windows raises this when the user drags
        // it; forwarding it as a `seek` action keeps the timeline honest
        // instead of letting Windows paint a position the page never adopted.
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
        // The brand thumb is the guaranteed fallback: without it a page with
        // no artwork (or a Windows that cannot fetch one) leaves the flyout
        // with no image at all, which is what "no artwork" looked like.
        let brand_ready = state
            .thumb
            .lock()
            .ok()
            .map(|mut slot| {
                if slot.is_none()
                    && let Some(thumb) = thumbnail()
                {
                    *slot = Some(thumb);
                }
                slot.is_some()
            })
            .unwrap_or(false);
        diag(if brand_ready {
            "smtc -> armed (disabled until a page plays, brand thumb ok)"
        } else {
            "smtc -> armed (disabled until a page plays, brand thumb FAILED)"
        });
    }

    pub(super) fn update<R: Runtime>(app: &tauri::AppHandle<R>, id: &str, report: MediaReport) {
        let state = app.state::<SmtcState>();
        // The bar is independent of the SMTC session: if `install` failed to
        // get the interop factory, the page can still own media and the
        // timeline must still appear. Only the flyout calls below are skipped.
        let controls = state.controls.lock().ok().and_then(|slot| slot.clone());

        let kind = report.state.as_str();
        // A live item must have a title. A paused `<video>` that never played
        // (preload, hover preview) reports no metadata at all; showing it is
        // exactly the empty "T9 Editor LIT" card the user complained about.
        let live = (kind == "playing" || kind == "paused") && !report.title.trim().is_empty();

        // Remember this tab's report — and whether this report is a
        // *transition*: a fresh play (`started`, which is also what takes
        // the Win+A card over) or play→pause (`paused_fresh`). Transitions
        // are what may re-show the OSD flyout; position heartbeats must
        // never do that, or the card would sit on screen for the whole
        // video instead of five seconds per interaction.
        let (started, paused_fresh) = state
            .reports
            .lock()
            .map(|mut reports| {
                let previous = reports.get(id).map(|last| last.state.clone());
                reports.insert(id.to_string(), report.clone());
                (
                    kind == "playing" && previous.as_deref() != Some("playing"),
                    kind == "paused" && previous.as_deref() == Some("playing"),
                )
            })
            .unwrap_or((false, false));

        // One owner. Rules, in order:
        //   1. the current owner keeps it while it is live (paused included:
        //      the flyout must show the item so play/pause can resume it),
        //   2. a tab that just started playing takes it over,
        //   3. with no owner, a playing tab wins; a paused one is shown only
        //      when nothing else has media (a just-loaded YouTube page).
        // A tab that is not the owner returns here, so a background pinned
        // video can never overwrite the active page's title or timeline.
        let (owner, took_over) = {
            let mut slot = match state.owner.lock() {
                Ok(slot) => slot,
                Err(_) => return,
            };
            let was_owner = slot.as_deref() == Some(id);
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
            (slot.clone(), !was_owner && slot.as_deref() == Some(id))
        };

        // Nothing owns the session any more: clear the Win+A card and the
        // OSD flyout so neither keeps showing the last video after it stopped.
        if owner.is_none() {
            clear(app, &state);
            return;
        }
        if owner.as_deref() != Some(id) {
            return;
        }

        if !live {
            // The owner stopped. Hand the flyout to another live page
            // immediately instead of leaving a dead title on screen; only
            // when nothing else has media does the session close.
            if promote(app, id) {
                diag(&format!("media {id} -> none, handed over"));
                return;
            }
            clear(app, &state);
            diag(&format!("media {id} -> none"));
            return;
        }

        // A live owner is what the OSD flyout draws. Emitted on every
        // heartbeat because the position is what makes the timeline move;
        // the payload is small and the card only re-renders its clock.
        let _ = app.emit("browser:media", snapshot_of(id, &report));
        if let Ok(mut shown) = state.shown.lock() {
            *shown = true;
        }
        // Play / pause / a fresh owner put the OSD flyout on screen.
        // Position-only heartbeats deliberately stay out of here.
        if started || paused_fresh || took_over {
            crate::media_flyout::ping(app);
        }

        let Some(controls) = controls else {
            return;
        };
        // First honest playback (or a resumed one): now the card may exist.
        let _ = controls.SetIsEnabled(true);

        // Metadata only when something visible changed. Position arrives
        // every ~1.5 s while playing and must not repaint the flyout.
        let changed = match state.last.lock() {
            Ok(mut last) => {
                let changed = took_over
                    || last.state != report.state
                    || last.title != report.title
                    || last.artist != report.artist
                    || last.artwork != report.artwork
                    || last.next != report.next
                    || last.prev != report.prev
                    || (last.duration - report.duration).abs() > 1.0;
                *last = report.clone();
                changed
            }
            Err(_) => took_over,
        };

        if changed {
            // Which artwork the Win+A card is being given, and the URL the
            // page actually published — logged before the display update so
            // `browser-diag.log` alone answers "why is there no thumbnail":
            // `[thumb brand: ]` means the page never sent any (and the
            // og:image fallback in browser_shim.js had nothing either).
            let page_art = artwork(&state, &report.artwork);
            let source = if page_art.is_some() { "page" } else { "brand" };
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
                // The page's own artwork (a YouTube thumbnail) is what Edge
                // shows; the brand mark stays the fallback so a page with no
                // art cannot leave the flyout blank.
                let thumb = page_art.or_else(|| state.thumb.lock().ok().and_then(|slot| slot.clone()));
                if let Some(thumb) = thumb {
                    let _ = updater.SetThumbnail(&thumb);
                }
                let _ = updater.Update();
            }
            let _ = controls.SetIsNextEnabled(report.next);
            let _ = controls.SetIsPreviousEnabled(report.prev);
            diag(&format!(
                "media {id} -> {kind} {:?} by {:?} [thumb {source}: {}]",
                report.title, report.artist, report.artwork
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

    /// Take the Win+A card **and** the OSD flyout down. Called when the last live
    /// page stopped or its tab closed; idempotent, so repeated `none` reports
    /// do not spam the frontend with clear events.
    fn clear<R: Runtime>(app: &tauri::AppHandle<R>, state: &SmtcState) {
        // The OSD flyout leaves the moment the session does — waiting out
        // its idle timer over an empty card would look like a hang.
        crate::media_flyout::hide(app);
        let was = state
            .shown
            .lock()
            .map(|mut shown| {
                let was = *shown;
                *shown = false;
                was
            })
            .unwrap_or(false);
        if let Ok(mut last) = state.last.lock() {
            *last = MediaReport::default();
        }
        // Always close the session, not only when the OSD was on screen:
        // `shown` can be false while Windows still holds an enabled session
        // (the first report after launch), and that ghost card is the bug.
        if let Some(controls) = state.controls.lock().ok().and_then(|slot| slot.clone()) {
            close(&controls);
        }
        if !was {
            return;
        }
        let _ = app.emit("browser:media", MediaSnapshot::cleared());
    }

    /// The bar's initial state: the owner's latest report, if any. A `none`
    /// report is filtered so a dead session never paints an empty bar.
    pub(super) fn snapshot<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<MediaSnapshot> {
        let state = app.state::<SmtcState>();
        let owner = state.owner.lock().ok().and_then(|owner| owner.clone())?;
        let reports = state.reports.lock().ok()?;
        let report = reports.get(&owner)?;
        if report.state == "none" || report.title.trim().is_empty() {
            return None;
        }
        Some(super::snapshot_of(&owner, report))
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
        clear(app, &state);
        diag(&format!("media {id} -> closed tab"));
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
    pub(super) fn act<R: Runtime>(app: &tauri::AppHandle<R>, action: &str, value: Option<f64>) {
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
        // Every transport press re-raises the OSD: media keys, the earbud,
        // the Win+A card and the OSD's own buttons all want the timeline
        // visible right after they act.
        crate::media_flyout::ping(app);
        diag(&format!("media button {action} -> {id}"));
    }

    /// The page's artwork as a WinRT reference. Only absolute http(s) URIs
    /// work: Windows fetches the image itself, and a `blob:` URL belongs to
    /// the page's renderer, which Windows cannot reach. Cached by URL —
    /// YouTube keeps the same thumbnail across heartbeats, and a fresh
    /// reference per report makes the flyout flash while it downloads.
    fn artwork(state: &SmtcState, url: &str) -> Option<RandomAccessStreamReference> {
        let url = url.trim();
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return None;
        }
        let mut cache = state.art.lock().ok()?;
        if let Some((cached, thumb)) = cache.as_ref()
            && cached == url
        {
            return Some(thumb.clone());
        }
        let uri = match Uri::CreateUri(&HSTRING::from(url)) {
            Ok(uri) => uri,
            Err(error) => {
                diag(&format!("smtc -> artwork uri failed: {error}"));
                return None;
            }
        };
        match RandomAccessStreamReference::CreateFromUri(&uri) {
            Ok(thumb) => {
                *cache = Some((url.to_string(), thumb.clone()));
                Some(thumb)
            }
            Err(error) => {
                diag(&format!("smtc -> artwork failed: {error}"));
                None
            }
        }
    }

    fn close(controls: &SystemMediaTransportControls) {
        // Disable, not just "Closed": a Closed-but-enabled session still
        // leaves the app listed in Win+A. Disable removes the card entirely.
        let _ = controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        let _ = controls.SetIsEnabled(false);
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
