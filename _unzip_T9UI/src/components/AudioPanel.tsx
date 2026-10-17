import React, { useState } from 'react';
import { Music2, Volume2, Mic, Play, Pause, Sparkles, Sliders } from 'lucide-react';

export const AudioPanel: React.FC = () => {
  const [selectedBgm, setSelectedBgm] = useState<string>('lofi-coding');
  const [bgmVolume, setBgmVolume] = useState<number>(18);
  const [autoDucking, setAutoDucking] = useState<boolean>(true);
  const [silenceThreshold, setSilenceThreshold] = useState<number>(0.8);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);

  const bgmTracks = [
    {
      id: 'lofi-coding',
      title: 'Midnight TypeScript Lofi',
      duration: '03:45',
      tempo: '78 BPM · Chill Study',
    },
    {
      id: 'synthwave-focus',
      title: 'Shibuya Night Coding',
      duration: '04:12',
      tempo: '90 BPM · Deep Flow',
    },
    {
      id: 'ambient-minimal',
      title: 'Nanami Calm Horizon',
      duration: '05:00',
      tempo: '60 BPM · Ambient Meditation',
    },
  ];

  const soundEffects = [
    { name: 'Mechanical Key Click', tag: 'Typing' },
    { name: 'Terminal Success Ping', tag: 'Build Pass' },
    { name: 'Subtle Whoosh Transition', tag: 'Cut Slide' },
    { name: 'Compiler Warning Beep', tag: 'Bug Alert' },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#1E202B] shrink-0 bg-[#14161F] space-y-1">
        <div className="flex items-center gap-2">
          <Music2 className="w-4 h-4 text-[#D4AF37]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
            Audio & Sound Design
          </h2>
        </div>
        <p className="text-[11px] text-slate-500 font-mono">
          Background lofi beats, smart voice ducking & coding SFX
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Background Music Selector */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
              Background Music
            </label>
            <span className="text-[10px] text-[#D4AF37] font-mono">Royalty Free</span>
          </div>

          <div className="space-y-2">
            {bgmTracks.map((track) => {
              const isSelected = selectedBgm === track.id;
              return (
                <div
                  key={track.id}
                  onClick={() => setSelectedBgm(track.id)}
                  className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-all cursor-pointer ${
                    isSelected
                      ? 'border-[#D4AF37] bg-[#D4AF37]/10 shadow-[0_0_10px_rgba(212,175,55,0.1)]'
                      : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewPlaying(previewPlaying === track.id ? null : track.id);
                      }}
                      className="w-8 h-8 rounded-full bg-[#12131A] border border-[#2A2E3D] text-[#D4AF37] flex items-center justify-center hover:scale-105 transition-transform"
                    >
                      {previewPlaying === track.id ? (
                        <Pause className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <Play className="w-3.5 h-3.5 ml-0.5 fill-current" />
                      )}
                    </button>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-200">{track.title}</h4>
                      <p className="text-[10px] text-slate-500 font-mono">{track.tempo}</p>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">{track.duration}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Volume & Auto-Ducking Controls */}
        <div className="p-4 rounded-xl bg-[#161822] border border-[#1E202B] space-y-3.5">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-slate-300">BGM Volume:</span>
            <span className="text-[#D4AF37] font-bold">{bgmVolume}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={bgmVolume}
            onChange={(e) => setBgmVolume(parseInt(e.target.value, 10))}
            className="w-full accent-[#D4AF37] cursor-pointer"
          />

          <div className="flex items-center justify-between pt-2 border-t border-[#1E202B]">
            <div>
              <span className="text-xs font-medium text-slate-200 block">Smart Voice Ducking</span>
              <span className="text-[10px] text-slate-500">Auto-reduces BGM while tutor is speaking</span>
            </div>
            <button
              onClick={() => setAutoDucking(!autoDucking)}
              className={`w-10 h-5 rounded-full p-0.5 transition-colors cursor-pointer ${
                autoDucking ? 'bg-[#D4AF37]' : 'bg-slate-700'
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-[#12131A] transform transition-transform ${
                  autoDucking ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Sound Effects Grid */}
        <div className="space-y-2.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block font-mono">
            Tutorial Sound Effects (SFX)
          </label>
          <div className="grid grid-cols-2 gap-2">
            {soundEffects.map((sfx, idx) => (
              <button
                key={idx}
                className="p-2.5 rounded-lg bg-[#161822] hover:bg-[#1E2130] border border-[#1E202B] text-left text-xs transition-colors cursor-pointer group flex flex-col justify-between"
              >
                <span className="font-semibold text-slate-200 group-hover:text-[#D4AF37]">
                  {sfx.name}
                </span>
                <span className="text-[9px] font-mono text-slate-500 mt-1">{sfx.tag}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
