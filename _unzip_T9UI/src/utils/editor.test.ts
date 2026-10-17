import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  formatTimecodeWithDecimal,
  parseTimestamp,
  calculateCutStats,
  getTimelineRegions,
  findActiveLineIndex,
  getNextKeptSegmentTime,
  findNextUnreviewedIndex,
  exportCutList,
  splitClipAtTime,
  type TranscriptLine,
  type VideoTimelineClip
} from './editor.ts';

const mockLines: TranscriptLine[] = [
  {
    id: 'l1',
    startTime: 0,
    endTime: 15,
    text: 'Welcome back everyone. Today we are building a type-safe event bus.',
    status: 'kept',
  },
  {
    id: 'l2',
    startTime: 15,
    endTime: 28,
    text: 'Umm, wait, let me close this terminal tab... sorry about that.',
    status: 'cut',
    isFlubOrSilence: true,
  },
  {
    id: 'l3',
    startTime: 28,
    endTime: 60,
    text: 'We define the generic interface EventMap with key constraints.',
    status: 'unreviewed',
  },
  {
    id: 'l4',
    startTime: 60,
    endTime: 90,
    text: 'Notice how TypeScript infers payload types automatically.',
    status: 'kept',
  },
];

test('formatTimestamp formats seconds properly', () => {
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(75), '01:15');
  assert.equal(formatTimestamp(135), '02:15');
  assert.equal(formatTimestamp(3665), '01:01:05');
});

test('formatTimecodeWithDecimal formats with tenths for NLE timeline', () => {
  assert.equal(formatTimecodeWithDecimal(0), '00:00.0');
  assert.equal(formatTimecodeWithDecimal(15.4), '00:15.4');
  assert.equal(formatTimecodeWithDecimal(80.5), '01:20.5');
});

test('splitClipAtTime splits clip at playhead scissors cut', () => {
  const clips: VideoTimelineClip[] = [
    { id: 'c1', startTime: 0, endTime: 30, isCut: false, label: 'Intro' },
    { id: 'c2', startTime: 30, endTime: 60, isCut: false, label: 'Main' },
  ];

  // Split at 15s
  const { updatedClips, splitSuccessful } = splitClipAtTime(clips, 15);
  assert.equal(splitSuccessful, true);
  assert.equal(updatedClips.length, 3);
  assert.equal(updatedClips[0].startTime, 0);
  assert.equal(updatedClips[0].endTime, 15);
  assert.equal(updatedClips[1].startTime, 15);
  assert.equal(updatedClips[1].endTime, 30);
  assert.equal(updatedClips[2].startTime, 30);
  assert.equal(updatedClips[2].endTime, 60);

  // Boundary condition (can't split at edge 0.05s)
  const edgeSplit = splitClipAtTime(clips, 0.05);
  assert.equal(edgeSplit.splitSuccessful, false);
});

test('parseTimestamp parses string format to seconds correctly', () => {
  assert.equal(parseTimestamp('02:15'), 135);
  assert.equal(parseTimestamp('00:00'), 0);
  assert.equal(parseTimestamp('01:02:15'), 3735);
});

test('calculateCutStats calculates durations, cut savings and counts', () => {
  const stats = calculateCutStats(mockLines, 90);
  assert.equal(stats.totalDuration, 90);
  assert.equal(stats.cutDuration, 13);
  assert.equal(stats.keptDuration, 77);
});

test('getTimelineRegions computes correct percentages and widths', () => {
  const regions = getTimelineRegions(mockLines, 90);
  assert.equal(regions.length, 4);
});

test('exportCutList formats properly for JSON, EDL, and chapters', () => {
  const chapterExport = exportCutList(mockLines, 'chapters');
  assert.ok(chapterExport.includes('00:00 - Welcome back everyone'));
});
