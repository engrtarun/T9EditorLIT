export type CutStatus = 'unreviewed' | 'kept' | 'cut';

export interface TranscriptLine {
  id: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  text: string;
  status: CutStatus;
  isFlubOrSilence?: boolean;
  codeSnippet?: string;
  category?: 'explanation' | 'coding' | 'terminal' | 'flub' | 'pause';
}

export interface CutStats {
  totalDuration: number;
  keptDuration: number;
  cutDuration: number;
  keptCount: number;
  cutCount: number;
  unreviewedCount: number;
  timeSavedSeconds: number;
  timeSavedPercentage: number;
}

export interface TimelineRegion {
  startTime: number;
  endTime: number;
  status: CutStatus;
  percentageStart: number;
  percentageWidth: number;
  id: string;
}

export interface VideoTimelineClip {
  id: string;
  startTime: number;
  endTime: number;
  isCut: boolean;
  label?: string;
}

/**
 * Format seconds into MM:SS or HH:MM:SS format
 */
export function formatTimestamp(seconds: number, forceHours = false): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const mm = mins.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');

  if (hrs > 0 || forceHours) {
    const hh = hrs.toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Format seconds with decimals for precise NLE timeline (e.g. 00:15.4 / 01:20.0)
 */
export function formatTimecodeWithDecimal(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00.0';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${tenths}`;
}

/**
 * Parse a timestamp string like "02:15" or "01:02:15" into seconds
 */
export function parseTimestamp(str: string): number {
  if (!str) return 0;
  const parts = str.trim().split(':').map((p) => parseFloat(p) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Splits a clip at a specific time into two clips (Scissors / Split tool)
 */
export function splitClipAtTime(
  clips: VideoTimelineClip[],
  splitTime: number
): { updatedClips: VideoTimelineClip[]; splitSuccessful: boolean; newClipId?: string } {
  const targetIndex = clips.findIndex(
    (c) => splitTime > c.startTime + 0.1 && splitTime < c.endTime - 0.1
  );
  if (targetIndex === -1) {
    return { updatedClips: clips, splitSuccessful: false };
  }

  const target = clips[targetIndex];
  const clipA: VideoTimelineClip = {
    id: `${target.id}_partA_${Date.now()}`,
    startTime: target.startTime,
    endTime: splitTime,
    isCut: target.isCut,
    label: target.label ? `${target.label} (Part 1)` : 'Clip Part 1',
  };
  const clipB: VideoTimelineClip = {
    id: `${target.id}_partB_${Date.now()}`,
    startTime: splitTime,
    endTime: target.endTime,
    isCut: target.isCut,
    label: target.label ? `${target.label} (Part 2)` : 'Clip Part 2',
  };

  const newClips = [...clips];
  newClips.splice(targetIndex, 1, clipA, clipB);
  return { updatedClips: newClips, splitSuccessful: true, newClipId: clipB.id };
}

/**
 * Calculate comprehensive statistics about cut time vs kept time
 */
export function calculateCutStats(lines: TranscriptLine[], totalVideoDuration?: number): CutStats {
  if (!lines || lines.length === 0) {
    const total = totalVideoDuration || 0;
    return {
      totalDuration: total,
      keptDuration: total,
      cutDuration: 0,
      keptCount: 0,
      cutCount: 0,
      unreviewedCount: 0,
      timeSavedSeconds: 0,
      timeSavedPercentage: 0,
    };
  }

  let keptDuration = 0;
  let cutDuration = 0;
  let unreviewedDuration = 0;
  let keptCount = 0;
  let cutCount = 0;
  let unreviewedCount = 0;

  lines.forEach((line) => {
    const duration = Math.max(0, line.endTime - line.startTime);
    if (line.status === 'cut') {
      cutDuration += duration;
      cutCount++;
    } else if (line.status === 'kept') {
      keptDuration += duration;
      keptCount++;
    } else {
      unreviewedDuration += duration;
      unreviewedCount++;
    }
  });

  const effectiveTotal = Math.max(
    totalVideoDuration || 0,
    lines[lines.length - 1]?.endTime || 0
  );
  
  const finalKept = effectiveTotal - cutDuration;
  const timeSaved = cutDuration;
  const percentage = effectiveTotal > 0 ? (timeSaved / effectiveTotal) * 100 : 0;

  return {
    totalDuration: effectiveTotal,
    keptDuration: Math.max(0, finalKept),
    cutDuration: timeSaved,
    keptCount,
    cutCount,
    unreviewedCount,
    timeSavedSeconds: timeSaved,
    timeSavedPercentage: Math.round(percentage * 10) / 10,
  };
}

/**
 * Returns timeline segments mapped to percentages [0..100] for scrubber visual display
 */
export function getTimelineRegions(lines: TranscriptLine[], totalDuration: number): TimelineRegion[] {
  if (!lines || lines.length === 0 || totalDuration <= 0) return [];

  return lines.map((line) => {
    const start = Math.max(0, Math.min(line.startTime, totalDuration));
    const end = Math.max(start, Math.min(line.endTime, totalDuration));
    const percentageStart = (start / totalDuration) * 100;
    const percentageWidth = Math.max(0.2, ((end - start) / totalDuration) * 100);

    return {
      id: line.id,
      startTime: line.startTime,
      endTime: line.endTime,
      status: line.status,
      percentageStart,
      percentageWidth,
    };
  });
}

/**
 * Finds the index of the transcript line active at `currentTime`
 */
export function findActiveLineIndex(lines: TranscriptLine[], currentTime: number): number {
  if (!lines || lines.length === 0) return -1;
  return lines.findIndex(
    (line) => currentTime >= line.startTime && currentTime < line.endTime
  );
}

/**
 * If `currentTime` is within a cut segment, finds the start of the next kept segment (for auto-skip feature)
 */
export function getNextKeptSegmentTime(lines: TranscriptLine[], currentTime: number): number | null {
  const currentLine = lines.find(
    (line) => currentTime >= line.startTime && currentTime < line.endTime
  );

  if (currentLine && currentLine.status === 'cut') {
    const nextLine = lines.find(
      (line) => line.startTime >= currentLine.endTime && line.status !== 'cut'
    );
    if (nextLine) {
      return nextLine.startTime;
    }
  }
  return null;
}

/**
 * Find next unreviewed line after current index
 */
export function findNextUnreviewedIndex(lines: TranscriptLine[], startIndex: number): number {
  if (!lines || lines.length === 0) return -1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].status === 'unreviewed') return i;
  }
  // Wrap around
  for (let i = 0; i <= startIndex; i++) {
    if (lines[i].status === 'unreviewed') return i;
  }
  return -1;
}

/**
 * Export cut transcript in various standard formats
 */
export function exportCutList(
  lines: TranscriptLine[],
  format: 'json' | 'edl' | 'chapters' | 'fcpxml'
): string {
  if (format === 'json') {
    const kept = lines.filter((l) => l.status !== 'cut');
    const cut = lines.filter((l) => l.status === 'cut');
    return JSON.stringify(
      {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        summary: calculateCutStats(lines),
        keptSegments: kept.map((l) => ({
          id: l.id,
          startTime: l.startTime,
          endTime: l.endTime,
          startFormatted: formatTimestamp(l.startTime),
          endFormatted: formatTimestamp(l.endTime),
          text: l.text,
        })),
        cutSegments: cut.map((l) => ({
          id: l.id,
          startTime: l.startTime,
          endTime: l.endTime,
          startFormatted: formatTimestamp(l.startTime),
          endFormatted: formatTimestamp(l.endTime),
          text: l.text,
        })),
      },
      null,
      2
    );
  }

  if (format === 'chapters') {
    const kept = lines.filter((l) => l.status !== 'cut');
    return kept
      .map((l) => `${formatTimestamp(l.startTime)} - ${l.text.slice(0, 50)}${l.text.length > 50 ? '...' : ''}`)
      .join('\n');
  }

  if (format === 'edl') {
    let edl = `TITLE: TUTORIAL_RATIO_CUT\nFCM: NON-DROP FRAME\n\n`;
    const kept = lines.filter((l) => l.status !== 'cut');
    kept.forEach((line, index) => {
      const eventNum = (index + 1).toString().padStart(3, '0');
      const startTc = `${formatTimestamp(line.startTime, true)}:00`;
      const endTc = `${formatTimestamp(line.endTime, true)}:00`;
      edl += `${eventNum}  AX       V     C        ${startTc} ${endTc} ${startTc} ${endTc}\n`;
      edl += `* FROM CLIP: TUTORIAL_CAPTURE.MP4 | NOTE: ${line.text.slice(0, 40)}\n\n`;
    });
    return edl;
  }

  if (format === 'fcpxml') {
    const kept = lines.filter((l) => l.status !== 'cut');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9">\n  <library>\n    <event name="RatioCut Export">\n      <project name="Programming Tutorial Final Cut">\n        <sequence duration="${kept[kept.length - 1]?.endTime || 0}s" format="r1">\n          <spine>\n`;
    kept.forEach((line) => {
      const dur = (line.endTime - line.startTime).toFixed(2);
      xml += `            <clip name="${line.text.slice(0, 30).replace(/"/g, '&quot;')}" offset="${line.startTime}s" duration="${dur}s" start="${line.startTime}s" />\n`;
    });
    xml += `          </spine>\n        </sequence>\n      </project>\n    </event>\n  </library>\n</fcpxml>`;
    return xml;
  }

  return '';
}
