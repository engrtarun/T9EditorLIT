import React, { useRef, useState, useEffect } from 'react';
import {
  Scissors,
  Trash2,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Plus,
  Volume2,
  VolumeX,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Layers,
  Sparkles,
  Sliders,
  Type,
  Video,
  Mic,
  Camera,
  ChevronLeft,
  ChevronRight,
  Magnet,
  Check,
  X,
  Activity,
  FileCode,
} from 'lucide-react';
import {
  formatTimestamp,
  formatTimecodeWithDecimal,
  VideoTimelineClip,
  TranscriptLine,
} from '../utils/editor';

export type TimelineMode = 'clipchamp' | 'pro-nle' | 'storyboard';

interface VeedTimelineProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  playbackRate?: number;
  onChangePlaybackRate?: (rate: number) => void;
  clips: VideoTimelineClip[];
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelectedClip: () => void;
  onToggleClipCut: (clipId: string) => void;
  lines?: TranscriptLine[];
  onToggleLineCut?: (id: string) => void;
  timelineMode: TimelineMode;
  onChangeTimelineMode: (mode: TimelineMode) => void;
  onOpenMediaPanel?: () => void;
}

export const VeedTimeline: React.FC<VeedTimelineProps> = ({
  currentTime,
  duration,
  isPlaying,
  onTogglePlay,
  onSeek,
  playbackRate = 1,
  onChangePlaybackRate,
  clips,
  selectedClipId,
  onSelectClip,
  onSplitAtPlayhead,
  onDeleteSelectedClip,
  onToggleClipCut,
  lines = [],
  onToggleLineCut,
  timelineMode,
  onChangeTimelineMode,
  onOpenMediaPanel,
}) => {
  const [zoom, setZoom] = useState<number>(1);
  const [snapping, setSnapping] = useState<boolean>(true);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [trackMuted, setTrackMuted] = useState<{ [key: string]: boolean }>({});
  const [trackLocked, setTrackLocked] = useState<{ [key: string]: boolean }>({});
  const [splitBurst, setSplitBurst] = useState<boolean>(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Playhead percentage along duration
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Frame calculation for 60fps SMPTE timecode (HH:MM:SS:FF)
  const totalFrames = Math.floor(currentTime * 60);
  const framePart = Math.floor(totalFrames % 60)
    .toString()
    .padStart(2, '0');
  const totalSeconds = Math.floor(currentTime);
  const secPart = (totalSeconds % 60).toString().padStart(2, '0');
  const minPart = Math.floor((totalSeconds / 60) % 60)
    .toString()
    .padStart(2, '0');
  const hourPart = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, '0');
  const smpteTimecode = `${hourPart}:${minPart}:${secPart}:${framePart}`;

  // Handle timeline scrubbing
  const handleSeekFromEvent = (e: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
    if (!timelineRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    let ratio = offsetX / rect.width;
    let targetTime = ratio * duration;

    // Magnetic Snapping to clip splits or sentence boundaries
    if (snapping) {
      const snapThresholdSec = 1.5 / zoom;
      for (const clip of clips) {
        if (Math.abs(targetTime - clip.startTime) < snapThresholdSec) {
          targetTime = clip.startTime;
          break;
        }
        if (Math.abs(targetTime - clip.endTime) < snapThresholdSec) {
          targetTime = clip.endTime;
          break;
        }
      }
    }

    onSeek(Math.max(0, Math.min(duration, targetTime)));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.timeline-no-seek')) return;
    setIsScrubbing(true);
    handleSeekFromEvent(e);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      handleSeekFromEvent(moveEvent);
    };

    const handleMouseUp = () => {
      setIsScrubbing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const triggerSplit = () => {
    setSplitBurst(true);
    onSplitAtPlayhead();
    setTimeout(() => setSplitBurst(false), 300);
  };

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        triggerSplit();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault();
          onDeleteSelectedClip();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onSplitAtPlayhead, onDeleteSelectedClip, selectedClipId]);

  // Generate ruler tick marks
  const rulerTicks = [];
  const step = duration > 300 ? 60 / zoom : 30 / zoom;
  const totalSteps = Math.ceil(duration / step);
  for (let i = 0; i <= totalSteps; i++) {
    const timeSec = Math.round(i * step);
    if (timeSec <= duration) {
      rulerTicks.push(timeSec);
    }
  }

  const speedOptions = [1, 1.25, 1.5, 2];

  return (
    <div
      id="tour-timeline"
      data-tour="timeline"
      className="w-full bg-[#0F111A] border-t border-[#1E202B] flex flex-col select-none shrink-0"
    >
      {/* 1. TIMELINE TOP TOOLBAR */}
      <div className="h-11 px-3 sm:px-4 border-b border-[#1E202B] flex items-center justify-between text-xs bg-[#131520] shrink-0">
        {/* Left: Scissors Split Tool, Ripple Delete & Snapping */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Manual Split Scissors Button */}
          <button
            onClick={triggerSplit}
            data-tour="split"
            data-inspect="split-button"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-xs transition-all cursor-pointer shadow-sm border active:scale-95 group ${
              splitBurst
                ? 'bg-[#D4AF37] text-[#12131A] border-[#D4AF37] scale-105'
                : 'bg-[#1E2130] hover:bg-[#D4AF37] text-slate-200 hover:text-[#12131A] border-[#2B2F42] hover:border-[#D4AF37]'
            }`}
            title="Split clip at playhead (Hotkey: S)"
          >
            <Scissors
              className={`w-3.5 h-3.5 transition-transform duration-200 ${
                splitBurst ? '-rotate-45 scale-125' : 'group-hover:-rotate-20'
              }`}
            />
            <span className="hidden xs:inline">Split</span>
            <span className="text-[10px] font-mono px-1 rounded bg-black/30 group-hover:bg-[#12131A]/20">
              S
            </span>
          </button>

          {/* Ripple Delete Button */}
          <button
            onClick={onDeleteSelectedClip}
            disabled={!selectedClipId}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer border ${
              selectedClipId
                ? 'bg-red-950/60 text-red-300 hover:bg-red-900/80 border-red-800/60 shadow-sm active:scale-95'
                : 'text-slate-600 border-transparent cursor-not-allowed opacity-40'
            }`}
            title="Ripple delete selected clip (Delete or Backspace)"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Delete</span>
          </button>

          {/* Magnetic Snapping */}
          <button
            onClick={() => setSnapping(!snapping)}
            className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
              snapping
                ? 'bg-[#D4AF37]/15 border-[#D4AF37]/50 text-[#D4AF37]'
                : 'bg-[#161822] border-[#1E202B] text-slate-500 hover:text-slate-300'
            }`}
            title={`Magnetic Snapping: ${snapping ? 'ON' : 'OFF'}`}
          >
            <Magnet className="w-3.5 h-3.5" />
          </button>

          {/* Add Media / Insert Track */}
          {onOpenMediaPanel && (
            <button
              onClick={onOpenMediaPanel}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#161822] hover:bg-[#1E202B] text-slate-300 hover:text-[#D4AF37] border border-[#1E202B] transition-colors cursor-pointer text-xs"
              title="Open Media Library to insert B-Roll or audio clip"
            >
              <Plus className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span className="hidden md:inline">Insert Media</span>
            </button>
          )}
        </div>

        {/* Center: Playhead Controls, Speed & Timecode */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Rewind 5s */}
          <button
            onClick={() => onSeek(Math.max(0, currentTime - 5))}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 active:scale-90 transition-all cursor-pointer"
            title="Rewind 5s (J)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Play/Pause Button */}
          <button
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#D4AF37] hover:bg-[#e5c358] active:scale-90 text-[#12131A] flex items-center justify-center transition-all cursor-pointer shadow-lg shadow-[#D4AF37]/20"
            title="Play/Pause (Space)"
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 ml-0.5 fill-current" />
            )}
          </button>

          {/* Forward 5s */}
          <button
            onClick={() => onSeek(Math.min(duration, currentTime + 5))}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 active:scale-90 transition-all cursor-pointer"
            title="Forward 5s (L)"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>

          {/* Speed Presets */}
          {onChangePlaybackRate && (
            <div className="hidden lg:flex items-center gap-0.5 bg-[#0E1017] p-0.5 rounded-lg border border-[#1E202B]">
              {speedOptions.map((rate) => (
                <button
                  key={rate}
                  onClick={() => onChangePlaybackRate(rate)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-all cursor-pointer ${
                    playbackRate === rate
                      ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title={`Speed ${rate}x`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          )}

          {/* Timecode Box: SMPTE or Standard */}
          <div className="font-mono text-xs tabular-nums text-slate-200 bg-[#0E1017] px-2.5 py-1 rounded-lg border border-[#1E202B] flex items-center gap-1.5">
            <span className="text-[#D4AF37] font-bold">
              {timelineMode === 'pro-nle' ? smpteTimecode : formatTimecodeWithDecimal(currentTime)}
            </span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-400">{formatTimecodeWithDecimal(duration)}</span>
          </div>
        </div>

        {/* Right: Switchable Timeline Modes & Zoom */}
        <div className="flex items-center gap-2">
          {/* 3-WAY TIMELINE MODE SELECTOR */}
          <div className="flex items-center p-0.5 rounded-lg bg-[#0E1017] border border-[#1E202B]">
            {[
              { id: 'clipchamp', label: 'Clipchamp Tracks', icon: <Layers className="w-3 h-3" /> },
              { id: 'pro-nle', label: 'Pro NLE', icon: <Activity className="w-3 h-3" /> },
              { id: 'storyboard', label: 'Speech Storyboard', icon: <Type className="w-3 h-3" /> },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => onChangeTimelineMode(m.id as TimelineMode)}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all cursor-pointer ${
                  timelineMode === m.id
                    ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={`Switch timeline to ${m.label}`}
              >
                {m.icon}
                <span className="hidden xl:inline">{m.label}</span>
              </button>
            ))}
          </div>

          {/* Zoom Slider */}
          <div className="hidden sm:flex items-center gap-1 text-slate-400">
            <ZoomOut className="w-3 h-3" />
            <input
              type="range"
              min="1"
              max="2.5"
              step="0.25"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              aria-label="Timeline Zoom"
              className="w-14 lg:w-18 accent-[#D4AF37] cursor-pointer h-1"
            />
            <ZoomIn className="w-3 h-3" />
          </div>
        </div>
      </div>

      {/* 2. TIMELINE VIEWPORT (RENDERED ACCORDING TO SELECTED MODE) */}
      <div
        ref={timelineRef}
        onMouseDown={handleMouseDown}
        className="relative w-full bg-[#0B0C12] overflow-x-hidden cursor-crosshair select-none flex flex-col"
      >
        {/* TOP TIME RULER */}
        <div className="h-6 border-b border-[#1E202B] bg-[#10121A] relative flex items-end pl-24 sm:pl-32">
          {rulerTicks.map((time) => {
            const pct = duration > 0 ? (time / duration) * 100 : 0;
            return (
              <div
                key={time}
                style={{ left: `${pct}%` }}
                className="absolute bottom-0 flex flex-col items-center pointer-events-none transform -translate-x-1/2"
              >
                <span className="text-[9px] font-mono text-slate-500 mb-0.5">
                  {formatTimestamp(time)}
                </span>
                <div className="w-[1px] h-1.5 bg-slate-600" />
              </div>
            );
          })}
        </div>

        {/* ======================================================== */}
        {/* MODE 1: CLIPCHAMP MULTI-TRACK LAYOUT                    */}
        {/* ======================================================== */}
        {timelineMode === 'clipchamp' && (
          <div className="flex flex-col divide-y divide-[#181A26] py-1">
            {/* TRACK 1: VIDEO & MEDIA */}
            <div className="flex items-stretch h-14 relative group/track">
              {/* Left Track Header */}
              <div className="w-24 sm:w-32 bg-[#12141F] border-r border-[#1E202B] px-2 py-1 flex items-center justify-between shrink-0 z-10 timeline-no-seek">
                <div className="flex items-center gap-1.5 truncate">
                  <Video className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="text-[10px] font-bold text-slate-200 truncate">Video Track</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      setTrackMuted((prev) => ({ ...prev, video: !prev.video }))
                    }
                    className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/5 cursor-pointer"
                    title="Toggle Video Visibility"
                  >
                    {trackMuted.video ? (
                      <EyeOff className="w-3 h-3 text-red-400" />
                    ) : (
                      <Eye className="w-3 h-3" />
                    )}
                  </button>
                  <button
                    onClick={() =>
                      setTrackLocked((prev) => ({ ...prev, video: !prev.video }))
                    }
                    className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/5 cursor-pointer"
                    title="Lock Track"
                  >
                    {trackLocked.video ? (
                      <Lock className="w-3 h-3 text-amber-400" />
                    ) : (
                      <Unlock className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>

              {/* Track Content: Clips */}
              <div className="flex-1 relative h-full bg-[#10121D] overflow-hidden">
                {clips.map((clip, index) => {
                  const startPct = duration > 0 ? (clip.startTime / duration) * 100 : 0;
                  const widthPct =
                    duration > 0
                      ? Math.max(0.5, ((clip.endTime - clip.startTime) / duration) * 100)
                      : 0;
                  const isSelected = selectedClipId === clip.id;
                  const isCut = clip.isCut;

                  return (
                    <div
                      key={clip.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectClip(clip.id);
                      }}
                      style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                      className={`absolute top-1 bottom-1 rounded-md transition-all cursor-pointer border-r border-[#0E1017] flex items-center justify-between px-2 overflow-hidden ${
                        isCut
                          ? 'bg-red-950/60 border-2 border-red-700/60 text-red-300'
                          : isSelected
                          ? 'bg-gradient-to-r from-amber-600/30 via-[#D4AF37]/35 to-amber-600/30 border-2 border-[#D4AF37] text-white shadow-lg shadow-[#D4AF37]/20 z-10'
                          : 'bg-[#181B2A] hover:bg-[#202438] border border-white/10 text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />
                        <span className="text-[10px] font-semibold truncate">
                          {clip.label || `Clip ${index + 1}`}
                        </span>
                      </div>
                      <span className="text-[9px] font-mono opacity-80 shrink-0 ml-1">
                        {(clip.endTime - clip.startTime).toFixed(1)}s
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* TRACK 2: AUDIO VOICEOVER & WAVEFORMS */}
            <div className="flex items-stretch h-12 relative group/track">
              {/* Left Track Header */}
              <div className="w-24 sm:w-32 bg-[#12141F] border-r border-[#1E202B] px-2 py-1 flex items-center justify-between shrink-0 z-10 timeline-no-seek">
                <div className="flex items-center gap-1.5 truncate">
                  <Mic className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
                  <span className="text-[10px] font-bold text-slate-200 truncate">Audio 1</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      setTrackMuted((prev) => ({ ...prev, audio: !prev.audio }))
                    }
                    className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/5 cursor-pointer"
                    title="Mute Audio Track"
                  >
                    {trackMuted.audio ? (
                      <VolumeX className="w-3 h-3 text-red-400" />
                    ) : (
                      <Volume2 className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>

              {/* Track Content: Animated Waveforms */}
              <div className="flex-1 relative h-full bg-[#0E1019] flex items-center px-1 overflow-hidden">
                <div className="w-full flex items-center gap-[2px] h-8 opacity-75">
                  {Array.from({ length: 90 }).map((_, waveIdx) => {
                    const waveTime = (waveIdx / 90) * duration;
                    const isActive = Math.abs(currentTime - waveTime) < duration / 25;
                    const h = isPlaying
                      ? 6 + Math.abs(Math.sin(waveIdx * 0.8 + currentTime * 5)) * 22
                      : 4 + Math.abs(Math.sin(waveIdx * 0.8)) * 18;
                    return (
                      <div
                        key={waveIdx}
                        style={{ height: `${h}px` }}
                        className={`flex-1 rounded-full transition-all duration-75 ${
                          isActive
                            ? 'bg-[#D4AF37] shadow-sm'
                            : 'bg-emerald-500/50'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>
            </div>

            {/* TRACK 3: SUBTITLES & CAPTIONS */}
            <div className="flex items-stretch h-10 relative group/track">
              {/* Left Track Header */}
              <div className="w-24 sm:w-32 bg-[#12141F] border-r border-[#1E202B] px-2 py-1 flex items-center justify-between shrink-0 z-10 timeline-no-seek">
                <div className="flex items-center gap-1.5 truncate">
                  <Type className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="text-[10px] font-bold text-slate-200 truncate">Captions</span>
                </div>
                <span className="text-[9px] font-mono text-purple-400/80">SYNC</span>
              </div>

              {/* Track Content: Sentence Chunks */}
              <div className="flex-1 relative h-full bg-[#10121D] overflow-hidden">
                {lines.map((line) => {
                  const startPct = duration > 0 ? (line.startTime / duration) * 100 : 0;
                  const widthPct =
                    duration > 0
                      ? Math.max(0.4, ((line.endTime - line.startTime) / duration) * 100)
                      : 0;
                  const isCurrent = currentTime >= line.startTime && currentTime <= line.endTime;
                  const isCut = line.status === 'cut';

                  return (
                    <div
                      key={line.id}
                      style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                      className={`absolute top-1 bottom-1 rounded px-1 flex items-center truncate text-[9px] font-mono border ${
                        isCut
                          ? 'bg-red-950/40 border-red-700/50 text-red-300 line-through'
                          : isCurrent
                          ? 'bg-purple-900/60 border-purple-400 text-purple-200 font-bold'
                          : 'bg-[#181B28] border-purple-900/40 text-slate-400'
                      }`}
                      title={line.text}
                    >
                      <span className="truncate">{line.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* TRACK 4: PIP FACECAM */}
            <div className="flex items-stretch h-9 relative group/track">
              {/* Left Track Header */}
              <div className="w-24 sm:w-32 bg-[#12141F] border-r border-[#1E202B] px-2 py-1 flex items-center justify-between shrink-0 z-10 timeline-no-seek">
                <div className="flex items-center gap-1.5 truncate">
                  <Camera className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="text-[10px] font-bold text-slate-200 truncate">Facecam PiP</span>
                </div>
                <span className="text-[8px] font-mono text-emerald-400">60FPS</span>
              </div>

              {/* Track Content: PiP Strip */}
              <div className="flex-1 relative h-full bg-[#0E1019] overflow-hidden flex items-center px-1">
                <div className="w-full h-4 rounded bg-[#161B26] border border-emerald-900/50 flex items-center justify-between px-2 text-[8px] font-mono text-emerald-400/80">
                  <span>CAM 01 · Presenter Angle</span>
                  <span>Active Overlay</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 2: PRO NLE DENSE (PREMIERE / DAVINCI STYLE)         */}
        {/* ======================================================== */}
        {timelineMode === 'pro-nle' && (
          <div className="p-3 relative flex flex-col gap-2">
            {/* Audio VU Decibel Peak Meters Strip */}
            <div className="flex items-center gap-2 p-1.5 rounded-lg bg-[#11131E] border border-[#1E202B]">
              <span className="text-[9px] font-mono text-slate-400 font-bold">STEREO VU</span>
              {/* Left Channel dB */}
              <div className="flex-1 flex items-center gap-1">
                <span className="text-[8px] font-mono text-slate-500 w-3">L</span>
                <div className="flex-1 flex items-center gap-[1px] h-2 bg-black/60 rounded p-0.5">
                  {Array.from({ length: 30 }).map((_, i) => {
                    const lit = isPlaying ? i < 18 + Math.floor(Math.sin(currentTime * 8 + i) * 8) : i < 12;
                    const isRed = i >= 26;
                    const isAmber = i >= 20 && i < 26;
                    return (
                      <div
                        key={i}
                        className={`flex-1 h-full rounded-xs transition-colors duration-75 ${
                          lit
                            ? isRed
                              ? 'bg-red-500'
                              : isAmber
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                            : 'bg-white/5'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Right Channel dB */}
              <div className="flex-1 flex items-center gap-1">
                <span className="text-[8px] font-mono text-slate-500 w-3">R</span>
                <div className="flex-1 flex items-center gap-[1px] h-2 bg-black/60 rounded p-0.5">
                  {Array.from({ length: 30 }).map((_, i) => {
                    const lit = isPlaying ? i < 16 + Math.floor(Math.cos(currentTime * 8 + i) * 8) : i < 12;
                    const isRed = i >= 26;
                    const isAmber = i >= 20 && i < 26;
                    return (
                      <div
                        key={i}
                        className={`flex-1 h-full rounded-xs transition-colors duration-75 ${
                          lit
                            ? isRed
                              ? 'bg-red-500'
                              : isAmber
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                            : 'bg-white/5'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              <span className="text-[9px] font-mono text-[#D4AF37] font-bold">-6.2 dB</span>
            </div>

            {/* Dense Video & Audio Combined Track */}
            <div className="relative h-20 w-full rounded-md bg-[#141624] border border-[#23273A] overflow-hidden flex shadow-inner">
              {clips.map((clip, index) => {
                const startPct = duration > 0 ? (clip.startTime / duration) * 100 : 0;
                const widthPct =
                  duration > 0
                    ? Math.max(0.5, ((clip.endTime - clip.startTime) / duration) * 100)
                    : 0;
                const isSelected = selectedClipId === clip.id;
                const isCut = clip.isCut;

                return (
                  <div
                    key={clip.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip(clip.id);
                    }}
                    style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                    className={`absolute top-0 bottom-0 rounded transition-all cursor-pointer border-r border-[#0E1017] flex flex-col justify-between p-1.5 ${
                      isCut
                        ? 'bg-red-950/60 border-2 border-red-700/60'
                        : isSelected
                        ? 'bg-[#D4AF37]/25 border-2 border-[#D4AF37] shadow-lg shadow-[#D4AF37]/20 z-10'
                        : 'bg-[#1C2030] hover:bg-[#23283D] border border-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-medium leading-none">
                      <span className="truncate text-slate-200">
                        {clip.label || `Clip ${index + 1}`}
                      </span>
                      <span className="text-[9px] font-mono text-slate-400">
                        {(clip.endTime - clip.startTime).toFixed(1)}s
                      </span>
                    </div>

                    {/* Pro Audio Waveform */}
                    <div className="flex items-center gap-[2px] h-6 opacity-60 pointer-events-none">
                      {Array.from({ length: 24 }).map((_, waveIdx) => {
                        const h = isCut
                          ? 2
                          : isPlaying && isSelected
                          ? 4 + Math.abs(Math.sin(waveIdx * 1.5 + currentTime * 4)) * 20
                          : 4 + Math.abs(Math.sin(waveIdx * 1.5 + index)) * 18;
                        return (
                          <div
                            key={waveIdx}
                            style={{ height: `${h}px` }}
                            className={`w-1 rounded-full ${
                              isCut ? 'bg-red-500/40' : isSelected ? 'bg-[#D4AF37]' : 'bg-cyan-400/50'
                            }`}
                          />
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between text-[8px] font-mono text-slate-500">
                      <span>SMPTE IN: {clip.startTime.toFixed(1)}s</span>
                      <span className={isCut ? 'text-red-400 font-bold' : 'text-slate-400'}>
                        {isCut ? 'EXCISED' : 'ACTIVE'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* MODE 3: SPEECH STORYBOARD (VEED / DESCRIPT STYLE)        */}
        {/* ======================================================== */}
        {timelineMode === 'storyboard' && (
          <div className="p-3 relative space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono pb-1 border-b border-[#1E202B]">
              <div className="flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span className="text-white font-bold">Spoken Script Storyboard</span>
                <span>· Click any block to jump playhead</span>
              </div>
              <span className="text-[10px] text-slate-500">
                Green = Kept · Red = Cut (Auto-Skipped)
              </span>
            </div>

            {/* Horizontal Storyboard Blocks */}
            <div className="relative h-20 w-full rounded-lg bg-[#141624] border border-[#23273A] overflow-hidden flex">
              {lines.map((line, idx) => {
                const startPct = duration > 0 ? (line.startTime / duration) * 100 : 0;
                const widthPct =
                  duration > 0
                    ? Math.max(0.6, ((line.endTime - line.startTime) / duration) * 100)
                    : 0;
                const isCurrent = currentTime >= line.startTime && currentTime <= line.endTime;
                const isCut = line.status === 'cut';

                return (
                  <div
                    key={line.id}
                    onClick={() => onSeek(line.startTime)}
                    style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                    className={`absolute top-1 bottom-1 rounded-md p-1.5 transition-all cursor-pointer border flex flex-col justify-between overflow-hidden group/block ${
                      isCut
                        ? 'bg-red-950/60 border-red-700/60 text-red-300'
                        : isCurrent
                        ? 'bg-[#D4AF37]/25 border-2 border-[#D4AF37] text-white shadow-lg'
                        : 'bg-[#181B2A] hover:bg-[#20253B] border-white/10 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 text-[9px]">
                      <span className="font-mono text-slate-400 truncate">
                        {formatTimestamp(line.startTime)}
                      </span>
                      {onToggleLineCut && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleLineCut(line.id);
                          }}
                          className={`px-1 rounded text-[8px] font-bold cursor-pointer transition-colors ${
                            isCut
                              ? 'bg-red-600 text-white'
                              : 'bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600 hover:text-white'
                          }`}
                        >
                          {isCut ? 'CUT' : 'KEEP'}
                        </button>
                      )}
                    </div>
                    <p className={`text-[10px] leading-tight line-clamp-2 ${isCut ? 'line-through opacity-70' : ''}`}>
                      {line.text}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. THE PLAYHEAD NEEDLE (SHARED ACROSS ALL TIMELINE MODES) */}
        <div
          style={{
            left:
              timelineMode === 'clipchamp'
                ? `calc(min(${playheadPercent}%, 100%))`
                : `${playheadPercent}%`,
          }}
          className="absolute top-0 bottom-0 -ml-[1px] w-[2px] bg-[#D4AF37] pointer-events-none z-30 shadow-[0_0_12px_rgba(212,175,55,1)]"
        >
          {/* Downward Playhead Flag with Timecode Indicator */}
          <div className="relative">
            <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-[#D4AF37] -ml-[5px] -mt-0.5" />
          </div>
        </div>
      </div>
    </div>
  );
};
