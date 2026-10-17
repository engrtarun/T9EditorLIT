import React, { useRef, useState } from 'react';
import { formatTimestamp, getTimelineRegions, TranscriptLine } from '../utils/editor';

interface TimelineScrubberProps {
  currentTime: number;
  duration: number;
  lines: TranscriptLine[];
  onSeek: (time: number) => void;
}

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentTime,
  duration,
  lines,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number>(0);
  const [isDragging, setIsDragging] = useState(false);

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const regions = getTimelineRegions(lines, duration);

  const calculateTimeFromEvent = (e: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
    if (!containerRef.current || duration <= 0) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX;
    const offsetX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const ratio = offsetX / rect.width;
    return ratio * duration;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const targetTime = calculateTimeFromEvent(e);
    setIsDragging(true);
    onSeek(targetTime);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const time = calculateTimeFromEvent(moveEvent);
      onSeek(time);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || duration <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const ratio = offsetX / rect.width;
    setHoverTime(ratio * duration);
    setHoverPosition(offsetX);
  };

  const handleMouseLeave = () => {
    setHoverTime(null);
  };

  return (
    <div className="w-full select-none py-1.5">
      {/* Scrubber Container */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="relative h-6 bg-[#161822] rounded cursor-pointer group flex items-center border border-[#1E202B] px-0.5"
      >
        {/* Segments Display (Kept vs Cut vs Unreviewed) */}
        <div className="absolute inset-x-0 h-2.5 bg-[#1A1C28] rounded-sm overflow-hidden flex">
          {regions.map((region) => {
            const isCut = region.status === 'cut';
            const isKept = region.status === 'kept';
            return (
              <div
                key={region.id}
                style={{
                  left: `${region.percentageStart}%`,
                  width: `${region.percentageWidth}%`,
                }}
                className={`absolute top-0 bottom-0 border-r border-[#12131A]/40 transition-colors ${
                  isCut
                    ? 'bg-red-900/60 opacity-80'
                    : isKept
                    ? 'bg-[#D4AF37]/30'
                    : 'bg-slate-700/40'
                }`}
                title={`Segment: ${formatTimestamp(region.startTime)} - ${formatTimestamp(region.endTime)} (${region.status})`}
              />
            );
          })}
        </div>

        {/* Progress fill (Gold Accent) */}
        <div
          style={{ width: `${progressPercent}%` }}
          className="absolute left-0 top-1.5 bottom-1.5 bg-[#D4AF37]/50 pointer-events-none rounded-l-sm"
        />

        {/* Playhead Handle (Nanami Gold Accent) */}
        <div
          style={{ left: `${progressPercent}%` }}
          className="absolute top-0 bottom-0 -ml-[2px] w-[4px] bg-[#D4AF37] pointer-events-none z-10 shadow-[0_0_8px_rgba(212,175,55,0.8)] flex items-center justify-center"
        >
          {/* Diamond top pin */}
          <div className="w-2.5 h-2.5 bg-[#D4AF37] rotate-45 transform -translate-y-2 rounded-xs border border-[#12131A]" />
        </div>

        {/* Hover Time Tooltip */}
        {hoverTime !== null && (
          <div
            style={{ left: `${hoverPosition}px` }}
            className="absolute -top-7 transform -translate-x-1/2 bg-[#12131A] text-[#D4AF37] text-[10px] font-mono px-1.5 py-0.5 rounded border border-[#D4AF37]/50 pointer-events-none z-30 shadow-lg"
          >
            {formatTimestamp(hoverTime)}
          </div>
        )}
      </div>

      {/* Timeline ruler info / Nanami 7:3 tick */}
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 mt-1 px-1">
        <span>00:00</span>
        <div className="flex items-center gap-1 text-[9px] text-slate-500">
          <span className="inline-block w-2 h-2 rounded-full bg-[#D4AF37]/30" />
          <span>Kept</span>
          <span className="mx-1">·</span>
          <span className="inline-block w-2 h-2 rounded-full bg-red-900/80" />
          <span>Cut</span>
        </div>
        <span>{formatTimestamp(duration)}</span>
      </div>
    </div>
  );
};
