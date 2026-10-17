//! Pure timeline operations — the Rust mirror of `src/lib/timeline.ts`.
//!
//! Kept free of Tauri types so it unit-tests without a webview. FFmpeg
//! arguments are *built* here as strings but never executed: spawning and
//! killing the child process is `ffmpeg.rs`'s job, which keeps this module
//! pure and fast to test.

// Scaffold state: this is the intended command-facing API and every function
// below is covered by the tests at the bottom, but no `#[tauri::command]`
// calls them yet. Drop this allow as the commands are wired up.
#![allow(dead_code)]

use crate::model::{Clip, LookAdjustments, TransitionKind, TrackKind};

/// Tolerance for "these two times are the same instant".
pub const EPSILON: f64 = 1e-6;

/// Shortest clip we allow. Below this the trim handles become unusable.
pub const MIN_CLIP_SECS: f64 = 0.1;

pub fn clip_end(clip: &Clip) -> f64 {
    clip.start_secs + clip.duration_secs
}

/// Snap `t` to `step` only when it is already within `tolerance` of a step.
pub fn snap(t: f64, step: f64, tolerance: f64) -> f64 {
    if step <= 0.0 {
        return t;
    }
    let nearest = (t / step).round() * step;
    if (nearest - t).abs() <= tolerance {
        nearest
    } else {
        t
    }
}

/// Split a clip at `offset_secs` within it, closing the gap.
/// Returns `None` for a cut at either end, so no empty clip is produced.
pub fn split_clip(clip: &Clip, offset_secs: f64) -> Option<(Clip, Clip)> {
    if offset_secs <= EPSILON || offset_secs >= clip.duration_secs - EPSILON {
        return None;
    }

    let mut head = clip.clone();
    head.duration_secs = offset_secs;
    head.out_point_secs = clip.in_point_secs + offset_secs;

    let mut tail = clip.clone();
    tail.id = format!("{}-split-{}", clip.id, offset_secs);
    tail.start_secs = clip.start_secs + offset_secs;
    tail.duration_secs = clip.duration_secs - offset_secs;
    tail.in_point_secs = clip.in_point_secs + offset_secs;
    // The transition belongs to the head; the tail starts clean.
    tail.transition = None;

    Some((head, tail))
}

/// Move a clip, clamped so it cannot go negative.
pub fn move_clip(clip: &Clip, new_start_secs: f64) -> Clip {
    let mut c = clip.clone();
    c.start_secs = new_start_secs.max(0.0);
    c
}

/// Trim the right edge, never exposing source material that does not exist.
///
/// `max_source_secs` is the asset's duration; pass `None` to disable clamping.
pub fn trim_right(clip: &Clip, new_duration_secs: f64, max_source_secs: Option<f64>) -> Clip {
    let mut duration = new_duration_secs.max(MIN_CLIP_SECS);

    if let Some(max_source) = max_source_secs.filter(|m| *m > 0.0) {
        let headroom = max_source - clip.in_point_secs;
        if headroom < MIN_CLIP_SECS * clip.speed {
            let mut c = clip.clone();
            c.duration_secs = MIN_CLIP_SECS;
            c.out_point_secs = clip.in_point_secs + MIN_CLIP_SECS * clip.speed;
            return c;
        }
        duration = duration.min(headroom / clip.speed);
    }

    let mut c = clip.clone();
    c.duration_secs = duration;
    c.out_point_secs = clip.in_point_secs + duration * clip.speed;
    c
}

/// Do two clips on this track overlap?
///
/// Overlay tracks stack freely; linear tracks must not overlap because the
/// renderer can only show one clip at a time there.
pub fn overlaps(a: &Clip, b: &Clip, kind: TrackKind) -> bool {
    if kind == TrackKind::Overlay || a.id == b.id {
        return false;
    }
    a.start_secs < clip_end(b) - EPSILON && b.start_secs < clip_end(a) - EPSILON
}

/// First clip blocking `candidate` on the same track.
pub fn find_collision<'a>(candidate: &Clip, clips: &'a [Clip], kind: TrackKind) -> Option<&'a Clip> {
    clips.iter().find(|c| overlaps(candidate, c, kind))
}

/// Ripple-delete: drop `removed_id` and close the gap it leaves.
pub fn ripple_delete(
    clips: &[Clip],
    removed_id: &str,
    removed_start_secs: f64,
    removed_end_secs: f64,
) -> Vec<Clip> {
    let gap = (removed_end_secs - removed_start_secs).max(0.0);
    clips
        .iter()
        .filter(|c| c.id != removed_id)
        .map(|c| {
            let mut next = c.clone();
            if c.start_secs >= removed_start_secs - EPSILON {
                next.start_secs = (c.start_secs - gap).max(0.0);
            }
            next
        })
        .collect()
}

/// Furthest clip end across every track.
pub fn timeline_duration(tracks: &[(&[Clip], TrackKind)]) -> f64 {
    let mut max = 0.0_f64;
    for (clips, _) in tracks {
        for c in clips.iter() {
            max = max.max(clip_end(c));
        }
    }
    max
}

/// Build the FFmpeg filter chain for a look.
///
/// Only non-identity adjustments are emitted, so the common case passes no
/// filter at all — every filter is CPU work on an i3.
pub fn look_to_ffmpeg(look: &LookAdjustments) -> String {
    let mut parts: Vec<String> = Vec::new();

    if look.brightness != 0.0 || look.contrast != 0.0 || look.saturation != 0.0 {
        let b = look.brightness * 0.5; // eq wants -1..1, the UI holds -0.5..0.5
        let c = 1.0 + look.contrast;
        let s = 1.0 + look.saturation;
        parts.push(format!("eq=brightness={b:.3}:contrast={c:.3}:saturation={s:.3}"));
    }
    if look.temperature != 0.0 || look.tint != 0.0 {
        let t = (look.temperature * 5000.0).round() as i64;
        let g = (look.tint * 5000.0).round() as i64;
        parts.push(format!("colortemperature=temperature={t}:tint={g}"));
    }
    if look.vignette > 0.0 {
        parts.push(format!("vignette=PI/{:.3}", look.vignette));
    }
    parts.join(",")
}

/// FFmpeg filter for a clip's head transition, or `None`.
pub fn transition_to_ffmpeg(kind: Option<TransitionKind>, duration_secs: f64) -> Option<String> {
    let kind = kind?;
    if duration_secs <= 0.0 {
        return None;
    }
    let d = duration_secs.min(2.0);
    Some(match kind {
        TransitionKind::Crossfade | TransitionKind::Dissolve => {
            format!("xfade=transition=fade:duration={d:.2}")
        }
        TransitionKind::DipToBlack => {
            format!("fade=t=in:st=0:d={d:.2},fade=t=out:st=0:d={d:.2}")
        }
        TransitionKind::Wipe => format!("xfade=transition=wipeleft:duration={d:.2}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip() -> Clip {
        Clip {
            id: "c1".into(),
            asset_id: "a1".into(),
            track_id: "t1".into(),
            start_secs: 0.0,
            duration_secs: 10.0,
            in_point_secs: 0.0,
            out_point_secs: 10.0,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            transition: None,
        }
    }

    #[test]
    fn split_advances_the_tails_in_point() {
        let c = Clip {
            in_point_secs: 2.0,
            ..clip()
        };
        let (head, tail) = split_clip(&c, 4.0).unwrap();
        assert_eq!(head.duration_secs, 4.0);
        assert_eq!(head.out_point_secs, 6.0);
        assert_eq!(tail.start_secs, 4.0);
        assert_eq!(tail.duration_secs, 6.0);
        assert_eq!(tail.in_point_secs, 6.0);
        assert_ne!(head.id, tail.id);
    }

    #[test]
    fn split_at_the_edges_is_rejected() {
        assert!(split_clip(&clip(), 0.0).is_none());
        assert!(split_clip(&clip(), 10.0).is_none());
    }

    #[test]
    fn move_clamps_at_zero() {
        assert_eq!(move_clip(&clip(), -5.0).start_secs, 0.0);
        assert_eq!(move_clip(&clip(), 12.0).start_secs, 12.0);
    }

    #[test]
    fn trim_right_respects_the_minimum_length() {
        assert_eq!(trim_right(&clip(), 0.0, None).duration_secs, MIN_CLIP_SECS);
    }

    #[test]
    fn trim_right_clamps_to_available_source() {
        let t = trim_right(&clip(), 20.0, Some(6.0));
        assert_eq!(t.duration_secs, 6.0);
        assert_eq!(t.out_point_secs, 6.0);
    }

    #[test]
    fn trim_right_scales_by_speed() {
        let c = Clip {
            speed: 2.0,
            ..clip()
        };
        // 6s of source at 2x speed is only 3s of timeline.
        let t = trim_right(&c, 30.0, Some(6.0));
        assert_eq!(t.duration_secs, 3.0);
        assert_eq!(t.out_point_secs, 6.0);
    }

    #[test]
    fn touching_clips_do_not_overlap() {
        // a = [0,10), b = [10,20) — b starts exactly where a ends. Half-open
        // intervals, so the shared edge is not an overlap.
        let a = clip();
        let b = Clip {
            id: "b".into(),
            start_secs: 10.0,
            ..clip()
        };
        assert!(!overlaps(&a, &b, TrackKind::Video));
    }

    #[test]
    fn overlapping_clips_collide_on_linear_tracks_only() {
        let a = clip();
        let b = Clip {
            id: "b".into(),
            start_secs: 1.0,
            ..clip()
        };
        assert!(overlaps(&a, &b, TrackKind::Video));
        assert!(!overlaps(&a, &b, TrackKind::Overlay));
    }

    #[test]
    fn find_collision_skips_the_candidate_itself() {
        let a = clip(); // [0,10)
        let later = Clip {
            id: "later".into(),
            start_secs: 30.0,
            ..clip()
        };
        // A distinct clip that genuinely overlaps `a` — a clone of `a` would
        // never collide, because matching ids are treated as the same clip.
        let blocker = Clip {
            id: "blocker".into(),
            start_secs: 3.0,
            duration_secs: 5.0,
            ..clip()
        };

        assert!(find_collision(&a, &[later.clone()], TrackKind::Video).is_none());
        assert_eq!(
            find_collision(&a, &[a.clone(), later, blocker], TrackKind::Video)
                .map(|c| c.id.as_str()),
            Some("blocker")
        );
    }

    #[test]
    fn ripple_delete_closes_the_gap() {
        let before = clip();
        let removed = Clip {
            id: "b".into(),
            start_secs: 5.0,
            ..clip()
        };
        let after = Clip {
            id: "c".into(),
            start_secs: 10.0,
            ..clip()
        };
        let out = ripple_delete(&[before, removed, after], "b", 5.0, 10.0);
        let ids: Vec<_> = out.iter().map(|c| (c.id.as_str(), c.start_secs)).collect();
        assert_eq!(ids, vec![("c1", 0.0), ("c", 5.0)]);
    }

    #[test]
    fn timeline_duration_spans_all_tracks() {
        let a = clip(); // [0,10)
        let b = Clip {
            id: "b".into(),
            start_secs: 12.0,
            duration_secs: 4.0, // [12,16)
            ..clip()
        };
        let t = timeline_duration(&[(&[a], TrackKind::Video), (&[b], TrackKind::Audio)]);
        assert_eq!(t, 16.0);
    }

    #[test]
    fn identity_look_emits_no_filter() {
        assert_eq!(look_to_ffmpeg(&LookAdjustments::neutral()), "");
    }

    #[test]
    fn look_emits_only_active_filters() {
        let look = LookAdjustments {
            saturation: 0.5,
            temperature: 0.5,
            vignette: 0.25,
            ..LookAdjustments::neutral()
        };
        let out = look_to_ffmpeg(&look);
        assert!(out.contains("saturation=1.500"), "{out}");
        assert!(out.contains("colortemperature=temperature=2500"), "{out}");
        assert!(out.contains("vignette=PI/0.250"), "{out}");
    }

    #[test]
    fn transitions_map_to_ffmpeg_filters() {
        assert_eq!(transition_to_ffmpeg(None, 1.0), None);
        assert_eq!(transition_to_ffmpeg(Some(TransitionKind::Crossfade), 0.0), None);
        assert_eq!(
            transition_to_ffmpeg(Some(TransitionKind::Wipe), 1.0).unwrap(),
            "xfade=transition=wipeleft:duration=1.00"
        );
    }

    #[test]
    fn snap_respects_tolerance() {
        assert_eq!(snap(10.04, 1.0, 0.1), 10.0);
        assert_eq!(snap(10.6, 1.0, 0.1), 10.6);
        assert_eq!(snap(7.3, 0.0, 1.0), 7.3);
    }
}