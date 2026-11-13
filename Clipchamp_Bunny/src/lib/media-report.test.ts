import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asrPercent,
  durationLabel,
  formatBytes,
  gateVerdict,
  hasAction,
  isAudioProject,
  issueIcon,
  layoutLabel,
  overlayAdvice,
  sortedIssues,
  sourceSummary,
  type MediaReport
} from './media-report.ts';

function report(over: Partial<MediaReport> = {}): MediaReport {
  return {
    path: 'C:/media/a.mp4',
    duration_secs: 2999.5,
    size_bytes: 5_300_000_000,
    bit_rate_bps: 14_137_000,
    has_audio: true,
    video: {
      index: 0,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 29.998,
      start_secs: 0,
      duration_secs: 2999.5
    },
    asr_copy_bytes: 5_999_000,
    ...over
  };
}

test('issues are ordered action, warn, info', () => {
  const issues = sortedIssues(
    report({
      issues: [
        { code: 'long_source', severity: 'info', title: 'Long source', detail: '' },
        { code: 'bloat', severity: 'warn', title: 'Bloat', detail: '' },
        { code: 'duration_split', severity: 'action', title: 'Split', detail: '', action: 'remux' }
      ]
    })
  );
  assert.deepEqual(
    issues.map((i) => i.code),
    ['duration_split', 'bloat', 'long_source']
  );
});

test('hasAction finds the one machine repair', () => {
  const r = report({
    issues: [
      { code: 'duration_split', severity: 'action', title: 'x', detail: '', action: 'remux' }
    ]
  });
  assert.equal(hasAction(r), true);
  assert.equal(hasAction(r, 'crop'), false);
  assert.equal(hasAction(null), false);
});

test('sourceSummary is the one line above the list', () => {
  const text = sourceSummary(report());
  assert.match(text, /49m 60s|50m 00s/);
  assert.match(text, /4\.9 GB/);
  assert.match(text, /1920×1080 30fps/);
  assert.match(text, /h264/);
});

test('an audio project says so instead of faking a frame size', () => {
  const r = report({ video: undefined, audio_only: true, issues: [] });
  assert.equal(isAudioProject(r), true);
  assert.match(sourceSummary(r), /audio only/);
});

test('asrPercent is the share of the source that reaches the API', () => {
  const pct = asrPercent(report());
  assert.ok(pct !== null);
  assert.ok(pct > 0 && pct < 1);
  assert.equal(asrPercent(report({ size_bytes: 0 })), null);
});

test('layout and overlay advice name the regions', () => {
  const layout = {
    cols: 3,
    rows: 3,
    motion: [],
    detail: [],
    samples: 12,
    watermark_region: 'bottom-left',
    facecam_region: 'top-right',
    confidence: 0.6,
    width: 96,
    height: 54
  };
  assert.equal(layoutLabel(layout), 'watermark bottom-left · face-cam top-right');
  assert.match(overlayAdvice(layout), /top-right/);
  assert.equal(overlayAdvice(null), '');
});

test('gateVerdict is the worst finding, or clean', () => {
  assert.equal(gateVerdict(report()), 'Source is clean');
  assert.equal(
    gateVerdict(
      report({ issues: [{ code: 'bloat', severity: 'warn', title: 'Bloat', detail: '' }] })
    ),
    'Bloat'
  );
});

test('formatters stay honest at the edges', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024 * 1024 * 5.3), '5.3 MB');
  assert.equal(durationLabel(59), '59s');
  assert.equal(durationLabel(3723), '1h 02m');
  assert.equal(issueIcon('bloat'), '◱');
  assert.equal(issueIcon('unknown-code'), '·');
});
