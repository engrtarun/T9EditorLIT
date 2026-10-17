import React from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  FastForward,
  SkipForward,
} from 'lucide-react';
import { formatTimestamp } from '../utils/editor';

interface PlaybackControlsProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onRewind10: () => void;
  onForward10: () => void;
  currentTime: number;
  duration: number;
  playbackRate: number;
  onChangePlaybackRate: (rate: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
  autoSkipCuts: boolean;
  onToggleAutoSkipCuts: () => void;
  onNextUncut: () => void;
}

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  isPlaying,
  onTogglePlay,
  onRewind10,
  onForward10,
  currentTime,
  duration,
  playbackRate,
  onChangePlaybackRate,
  isMuted,
  onToggleMute,
  autoSkipCuts,
  onToggleAutoSkipCuts,
  onNextUncut,
}) => {
  const speeds = [1, 1.25, 1.5, 2];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 pb-1 border-t border-[#1E202B]/60 select-none">
      {/* Left Section: J/L buttons & Big Play/Pause Button */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* J (-10s Rewind) Button */}
        <button
          onClick={onRewind10}
          aria-label="Rewind 10 seconds (J key)"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-300 hover:text-[#D4AF37] transition-colors group cursor-pointer"
          title="Rewind 10s (Press J)"
        >
          <RotateCcw className="w-3.5 h-3.5 group-hover:-rotate-45 transition-transform" />
          <span className="font-mono text-xs font-semibold">10s</span>
          <span className="text-[10px] text-slate-500 font-mono ml-0.5 hidden xs:inline">[J]</span>
        </button>

        {/* Big Play/Pause Button (Nanami Gold Accent) */}
        <button
          onClick={onTogglePlay}
          aria-label={isPlaying ? 'Pause video (Space)' : 'Play video (Space)'}
          className="w-12 h-12 rounded-full bg-[#D4AF37] hover:bg-[#e5c358] active:scale-95 text-[#12131A] flex items-center justify-center shadow-lg shadow-[#D4AF37]/20 transition-all cursor-pointer"
          title={isPlaying ? 'Pause (Space or K)' : 'Play (Space or K)'}
        >
          {isPlaying ? (
            <Pause className="w-6 h-6 fill-current" />
          ) : (
            <Play className="w-6 h-6 ml-0.5 fill-current" />
          )}
        </button>

        {/* L (+10s Forward) Button */}
        <button
          onClick={onForward10}
          aria-label="Forward 10 seconds (L key)"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-300 hover:text-[#D4AF37] transition-colors group cursor-pointer"
          title="Forward 10s (Press L)"
        >
          <RotateCw className="w-3.5 h-3.5 group-hover:rotate-45 transition-transform" />
          <span className="font-mono text-xs font-semibold">10s</span>
          <span className="text-[10px] text-slate-500 font-mono ml-0.5 hidden xs:inline">[L]</span>
        </button>

        {/* Jump to Next Unreviewed */}
        <button
          onClick={onNextUncut}
          className="hidden sm:flex items-center gap-1 px-2 py-1.5 rounded bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-400 hover:text-slate-200 text-xs transition-colors cursor-pointer"
          title="Jump to Next Unreviewed Line"
        >
          <SkipForward className="w-3.5 h-3.5" />
          <span className="text-[11px] font-mono">Next</span>
        </button>
      </div>

      {/* Middle Section: Current Timestamp Display (tabular-nums) */}
      <div className="flex items-center gap-2 bg-[#161822] px-3 py-1.5 rounded border border-[#1E202B]">
        <div className="font-mono text-sm tracking-tight text-slate-100 tabular-nums">
          <span className="text-[#D4AF37] font-semibold">{formatTimestamp(currentTime)}</span>
          <span className="text-slate-600 mx-1.5">/</span>
          <span className="text-slate-400">{formatTimestamp(duration)}</span>
        </div>
      </div>

      {/* Right Section: Speed, Auto-Skip Cuts, Volume */}
      <div className="flex items-center gap-2">
        {/* Auto-Skip Cuts Toggle */}
        <button
          onClick={onToggleAutoSkipCuts}
          aria-pressed={autoSkipCuts}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
            autoSkipCuts
              ? 'bg-[#D4AF37]/15 text-[#D4AF37] border-[#D4AF37]/50'
              : 'bg-[#161822] text-slate-400 hover:text-slate-300 border-[#1E202B]'
          }`}
          title="When enabled, playback automatically jumps over cut segments"
        >
          <FastForward className="w-3 h-3" />
          <span className="text-[11px] hidden md:inline">Auto-Skip Cuts</span>
          <span className={`w-1.5 h-1.5 rounded-full ${autoSkipCuts ? 'bg-[#D4AF37]' : 'bg-slate-600'}`} />
        </button>

        {/* Playback Rate Selector */}
        <div className="flex items-center bg-[#161822] rounded border border-[#1E202B] p-0.5">
          {speeds.map((rate) => (
            <button
              key={rate}
              onClick={() => onChangePlaybackRate(rate)}
              className={`px-1.5 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                playbackRate === rate
                  ? 'bg-[#D4AF37] text-[#12131A] font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>

        {/* Mute Toggle */}
        <button
          onClick={onToggleMute}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
          className="p-1.5 rounded bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          {isMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
};
