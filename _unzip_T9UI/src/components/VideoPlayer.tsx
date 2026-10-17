import React, { useState } from 'react';
import {
  Play,
  Pause,
  Terminal,
  Code2,
  Video,
  Eye,
  EyeOff,
  AlertCircle,
  Camera,
  Layers,
  Sliders,
  Check,
  X,
  Keyboard,
  Monitor,
} from 'lucide-react';
import { formatTimestamp, TranscriptLine } from '../utils/editor';
import { TutorialProject } from '../data/sampleTutorials';

export type CameraSource = 'cam01' | 'cam02' | 'screen-only' | 'side-by-side';
export type PipPosition = 'bottom-right' | 'top-right' | 'bottom-left';
export type PipSize = 'compact' | 'standard' | 'large';

interface VideoPlayerProps {
  project: TutorialProject;
  currentTime: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  activeLine: TranscriptLine | null;
  enablePip?: boolean;
  onTogglePip?: (enabled: boolean) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  project,
  currentTime,
  isPlaying,
  onTogglePlay,
  activeLine,
  enablePip = true,
  onTogglePip,
}) => {
  const [showWebcam, setShowWebcam] = useState(enablePip);
  const [activeTab, setActiveTab] = useState<'code' | 'terminal'>('code');

  // Multi-Cam and PiP customization state
  const [cameraSource, setCameraSource] = useState<CameraSource>('cam01');
  const [pipPosition, setPipPosition] = useState<PipPosition>('bottom-right');
  const [pipSize, setPipSize] = useState<PipSize>('standard');
  const [pipShape, setPipShape] = useState<'rect' | 'circle'>('rect');
  const [showCamPopover, setShowCamPopover] = useState(false);

  // Determine active code snippet based on time
  let snippetKey = 'intro';
  if (currentTime >= 350) {
    snippetKey = 'testing';
  } else if (currentTime >= 146) {
    snippetKey = 'implementation';
  } else if (currentTime >= 122) {
    snippetKey = 'flubArea';
  } else if (currentTime >= 49) {
    snippetKey = 'genericConstraint';
  }

  const snippet = project.codeSnippets[snippetKey] || project.codeSnippets.intro;
  const isCut = activeLine?.status === 'cut';

  // Compute frame number for 60fps timecode
  const frames = Math.floor((currentTime % 1) * 60)
    .toString()
    .padStart(2, '0');

  // Position classes for the PiP overlay
  const positionClasses = {
    'bottom-right': 'bottom-11 right-2 sm:right-3',
    'top-right': 'top-10 right-2 sm:right-3',
    'bottom-left': 'bottom-11 left-2 sm:left-3',
  }[pipPosition];

  // Size classes for the PiP overlay
  const sizeClasses = {
    compact: pipShape === 'circle' ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-24 sm:w-28 aspect-video',
    standard: pipShape === 'circle' ? 'w-20 h-20 sm:w-24 sm:h-24' : 'w-28 sm:w-36 aspect-video',
    large: pipShape === 'circle' ? 'w-24 h-24 sm:w-32 sm:h-32' : 'w-36 sm:w-44 aspect-video',
  }[pipSize];

  return (
    <div
      data-tour="player"
      data-inspect="video-player"
      className="relative w-full aspect-video bg-[#14161F] rounded-xl border border-[#1E202B] overflow-hidden group shadow-2xl flex flex-col justify-between select-none"
    >
      {/* Integrated Window Header of the Tutorial Screen */}
      <div className="h-8 bg-[#0E1017] border-b border-[#1E202B] flex items-center justify-between px-2 text-[11px] font-mono shrink-0 z-20">
        <div className="flex items-center gap-1 h-full overflow-hidden">
          <button
            onClick={() => setActiveTab('code')}
            className={`h-full px-2.5 flex items-center gap-1.5 border-r border-[#1E202B] transition-colors cursor-pointer ${
              activeTab === 'code'
                ? 'bg-[#14161F] text-[#D4AF37] border-t-2 border-t-[#D4AF37]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 className="w-3 h-3 text-[#D4AF37] shrink-0" />
            <span className="truncate max-w-[110px] sm:max-w-none">{snippet.file}</span>
          </button>
          <button
            onClick={() => setActiveTab('terminal')}
            className={`h-full px-2.5 flex items-center gap-1.5 border-r border-[#1E202B] transition-colors cursor-pointer ${
              activeTab === 'terminal'
                ? 'bg-[#14161F] text-[#D4AF37] border-t-2 border-t-[#D4AF37]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3 h-3 text-slate-400 shrink-0" />
            <span>terminal</span>
          </button>

          {isCut && (
            <div className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-950/80 border border-red-500/50 text-[9px] font-mono text-red-300 ml-1 animate-pulse">
              <AlertCircle className="w-2.5 h-2.5 text-red-400" />
              <span>CUT SEGMENT [EXCISED]</span>
            </div>
          )}
        </div>

        {/* Video Rec Status & Multi-Cam Switcher Trigger */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 border border-white/5 text-[9px] text-slate-300">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isPlaying ? 'bg-red-500 animate-pulse' : 'bg-slate-500'
              }`}
            />
            <span className="hidden xs:inline">{isPlaying ? 'REC' : 'STBY'}</span>
            <span className="text-slate-600">·</span>
            <span className="text-[#D4AF37]">{project.resolution}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">{project.fps}FPS</span>
          </div>

          {/* Quick Toggle PiP (Presenter Facecam) */}
          <button
            onClick={() => {
              const next = !showWebcam;
              setShowWebcam(next);
              onTogglePip?.(next);
            }}
            className={`px-2 py-0.5 rounded border text-[9px] font-mono transition-colors flex items-center gap-1 cursor-pointer ${
              showWebcam && enablePip
                ? 'bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37]'
                : 'bg-black/40 border-white/10 text-slate-500 hover:text-slate-300'
            }`}
            title="Toggle Presenter Facecam PiP (Turn completely on/off)"
          >
            {showWebcam && enablePip ? (
              <Eye className="w-2.5 h-2.5 text-[#D4AF37]" />
            ) : (
              <EyeOff className="w-2.5 h-2.5" />
            )}
            <span>Facecam PiP: {showWebcam && enablePip ? 'ON' : 'OFF'}</span>
          </button>

          {/* Timecode */}
          <div className="font-mono text-[10px] text-[#D4AF37] tabular-nums bg-black/70 px-1.5 py-0.5 rounded border border-[#D4AF37]/30">
            {formatTimestamp(currentTime, true)}:{frames}
          </div>
        </div>
      </div>

      {/* Code Viewport with Syntax Highlighting Simulation */}
      <div className="flex-1 p-3 overflow-hidden font-mono text-[11px] leading-relaxed relative flex flex-col justify-between bg-[#14161F]">
        {activeTab === 'code' ? (
          <div className="flex-1 overflow-auto select-text pr-1">
            {snippet.code.split('\n').map((lineText, idx) => {
              const lineNum = idx + 1;
              const isHighlight = snippet.activeLine === lineNum;
              return (
                <div
                  key={idx}
                  className={`flex items-start gap-2.5 px-1 py-0.5 rounded transition-colors ${
                    isHighlight
                      ? 'bg-[#D4AF37]/15 border-l-2 border-[#D4AF37] text-white'
                      : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <span className="w-5 text-right text-slate-600 select-none text-[10px] shrink-0">
                    {lineNum}
                  </span>
                  <span className="flex-1 font-mono break-all sm:break-normal">
                    {lineText.startsWith('//') ? (
                      <span className="text-slate-500 italic">{lineText}</span>
                    ) : lineText.includes('export') ||
                      lineText.includes('class') ||
                      lineText.includes('type') ||
                      lineText.includes('const') ? (
                      <span>
                        <span className="text-[#D4AF37] font-semibold">
                          {lineText.split(' ')[0]}
                        </span>{' '}
                        <span className="text-slate-200">{lineText.slice(lineText.indexOf(' ') + 1)}</span>
                      </span>
                    ) : lineText.includes('return') ? (
                      <span>
                        <span className="text-amber-400">return</span>
                        <span className="text-slate-300">{lineText.replace('return', '')}</span>
                      </span>
                    ) : (
                      <span className="text-slate-300">{lineText}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 bg-[#0B0C12] p-3 rounded border border-[#1E202B] text-slate-300 text-[11px] overflow-auto select-text font-mono">
            <pre className="whitespace-pre-wrap">{snippet.terminal || '$ Ready.'}</pre>
          </div>
        )}

        {/* Bottom Terminal Output Strip when in code tab */}
        {activeTab === 'code' && snippet.terminal && (
          <div className="mt-1 pt-1.5 border-t border-[#1E202B] flex items-center justify-between text-[10px] text-slate-400 bg-[#0E1017]/70 px-2 py-1 rounded shrink-0">
            <div className="flex items-center gap-1.5 truncate">
              <Terminal className="w-3 h-3 text-[#D4AF37] shrink-0" />
              <span className="truncate text-slate-300 font-mono">{snippet.terminal.split('\n')[0]}</span>
            </div>
            <span className="text-[#D4AF37] font-mono shrink-0 ml-2">PASS</span>
          </div>
        )}
      </div>

      {/* Picture-in-Picture Speaker Camera Inset (Presenter Facecam) */}
      {showWebcam && enablePip && cameraSource !== 'screen-only' && (
        <div
          data-tour="cam"
          data-inspect="cam-switcher"
          className={`absolute ${positionClasses} ${sizeClasses} ${
            pipShape === 'circle' ? 'rounded-full' : 'rounded-lg'
          } bg-[#0D0E14] border border-[#D4AF37]/50 shadow-2xl overflow-hidden z-20 group/cam cursor-pointer transition-all hover:scale-105 hover:border-[#D4AF37]`}
          onClick={(e) => {
            e.stopPropagation();
            setShowCamPopover(!showCamPopover);
          }}
          title="CAM 01: Presenter Facecam · Click to open Multi-Cam Switcher"
        >
          <div className="relative w-full h-full bg-[#181A24] flex items-center justify-center overflow-hidden">
            <div className="flex flex-col items-center justify-center text-center p-1">
              <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/60 flex items-center justify-center text-slate-200">
                {cameraSource === 'cam02' ? (
                  <Keyboard className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-cyan-400" />
                ) : (
                  <Video className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#D4AF37]" />
                )}
              </div>
              <span className="text-[8px] font-mono text-[#D4AF37] mt-0.5 font-bold">
                {cameraSource === 'cam02' ? 'CAM 02 · KEYBOARD' : 'CAM 01 · 60FPS'}
              </span>
            </div>

            {/* Hover overlay hint */}
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/cam:opacity-100 flex items-center justify-center transition-opacity">
              <span className="text-[9px] font-bold text-white bg-[#D4AF37]/90 text-[#12131A] px-1.5 py-0.5 rounded">
                Switch Angle
              </span>
            </div>

            {/* Live mic meter animation */}
            <div className="absolute bottom-1 left-2 right-2 flex items-center gap-0.5 h-0.5 sm:h-1">
              <span className="flex-1 h-full bg-emerald-500 rounded-full animate-pulse" />
              <span className="flex-1 h-full bg-emerald-500 rounded-full animate-pulse" />
              <span className="flex-1 h-full bg-emerald-500 rounded-full" />
              <span className="flex-1 h-full bg-emerald-500/40 rounded-full" />
              <span className="flex-1 h-full bg-emerald-500/20 rounded-full" />
            </div>
          </div>
        </div>
      )}

      {/* CAM 01 MULTI-CAM & PIP CONTROL POPOVER */}
      {showCamPopover && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-16 right-4 sm:right-6 z-40 w-72 bg-[#121422]/98 backdrop-blur-xl border border-[#D4AF37]/60 rounded-xl shadow-2xl p-3.5 text-slate-100 text-xs animate-in fade-in zoom-in-95"
        >
          <div className="flex items-center justify-between pb-2 border-b border-[#23273E]">
            <div className="flex items-center gap-1.5">
              <Camera className="w-4 h-4 text-[#D4AF37]" />
              <span className="font-bold text-white text-xs">Presenter Camera & PiP Settings</span>
            </div>
            <button
              onClick={() => setShowCamPopover(false)}
              className="text-slate-400 hover:text-white p-0.5 rounded hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="py-2.5 space-y-3">
            {/* Camera Source Switcher */}
            <div>
              <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold block mb-1.5">
                Camera Angle / Source
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { id: 'cam01', label: 'CAM 01 (Facecam)', icon: <Video className="w-3 h-3 text-[#D4AF37]" /> },
                  { id: 'cam02', label: 'CAM 02 (Keyboard)', icon: <Keyboard className="w-3 h-3 text-cyan-400" /> },
                  { id: 'screen-only', label: 'Screen Only (Hide)', icon: <Monitor className="w-3 h-3 text-slate-400" /> },
                  { id: 'side-by-side', label: 'Side-by-Side (70:30)', icon: <Layers className="w-3 h-3 text-emerald-400" /> },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setCameraSource(item.id as any)}
                    className={`p-1.5 rounded-lg border text-left flex items-center gap-1.5 text-[11px] transition-all cursor-pointer ${
                      cameraSource === item.id
                        ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-white font-semibold'
                        : 'border-[#1E2135] bg-[#161928] text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Position */}
            <div>
              <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold block mb-1">
                PiP Placement
              </span>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: 'bottom-right', label: 'Bottom-Right' },
                    { id: 'top-right', label: 'Top-Right' },
                    { id: 'bottom-left', label: 'Bottom-Left' },
                  ] as const
                ).map((pos) => (
                  <button
                    key={pos.id}
                    onClick={() => setPipPosition(pos.id)}
                    className={`py-1 text-center rounded text-[10px] font-mono transition-all cursor-pointer border ${
                      pipPosition === pos.id
                        ? 'border-[#D4AF37] bg-[#D4AF37]/20 text-[#D4AF37] font-bold'
                        : 'border-[#1E2135] bg-[#161928] text-slate-400'
                    }`}
                  >
                    {pos.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Size & Shape */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#23273E]">
              <div>
                <span className="text-[10px] font-mono text-slate-400 block mb-1">Scale</span>
                <div className="flex items-center gap-1">
                  {(['compact', 'standard', 'large'] as const).map((sz) => (
                    <button
                      key={sz}
                      onClick={() => setPipSize(sz)}
                      className={`px-2 py-0.5 rounded text-[10px] capitalize transition-all cursor-pointer border ${
                        pipSize === sz
                          ? 'border-[#D4AF37] bg-[#D4AF37] text-black font-bold'
                          : 'border-[#1E2135] bg-[#161928] text-slate-400'
                      }`}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-[10px] font-mono text-slate-400 block mb-1">Shape</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPipShape('rect')}
                    className={`px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer border ${
                      pipShape === 'rect'
                        ? 'border-[#D4AF37] bg-[#D4AF37] text-black font-bold'
                        : 'border-[#1E2135] bg-[#161928] text-slate-400'
                    }`}
                  >
                    Rect
                  </button>
                  <button
                    onClick={() => setPipShape('circle')}
                    className={`px-2 py-0.5 rounded text-[10px] transition-all cursor-pointer border ${
                      pipShape === 'circle'
                        ? 'border-[#D4AF37] bg-[#D4AF37] text-black font-bold'
                        : 'border-[#1E2135] bg-[#161928] text-slate-400'
                    }`}
                  >
                    Circle
                  </button>
                </div>
              </div>
            </div>

            {/* Turn Off PiP Button */}
            <div className="pt-2 border-t border-[#23273E] flex items-center justify-between">
              <span className="text-[10px] text-slate-400">Do not want facecam?</span>
              <button
                onClick={() => {
                  setShowWebcam(false);
                  onTogglePip?.(false);
                  setShowCamPopover(false);
                }}
                className="px-2.5 py-1 rounded bg-red-950/70 hover:bg-red-900 border border-red-700/60 text-red-300 text-[10px] font-semibold transition-colors cursor-pointer"
              >
                Hide PiP Completely
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Spoken Caption Overlay on Video */}
      <div className="absolute bottom-2 left-2 right-2 sm:right-40 z-20 pointer-events-none">
        {activeLine && (
          <div
            className={`px-2 py-1 rounded backdrop-blur-md text-xs font-mono transition-all ${
              isCut
                ? 'bg-red-950/85 border border-red-500/50 text-red-200 line-through'
                : 'bg-black/80 border border-white/10 text-slate-100 shadow-lg'
            }`}
          >
            <span className="text-[#D4AF37] mr-1.5 font-bold">[{formatTimestamp(activeLine.startTime)}]</span>
            <span>{activeLine.text}</span>
          </div>
        )}
      </div>

      {/* Click-to-Play Overlay Layer */}
      <button
        onClick={onTogglePlay}
        aria-label={isPlaying ? 'Pause Video' : 'Play Video'}
        className="absolute inset-0 z-10 flex items-center justify-center bg-black/10 hover:bg-black/20 transition-colors cursor-pointer group-hover:opacity-100"
      >
        {!isPlaying && (
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-[#12131A]/90 border border-[#D4AF37]/80 text-[#D4AF37] flex items-center justify-center shadow-2xl transform group-hover:scale-105 active:scale-95 transition-transform animate-pulse-gold">
            <Play className="w-5 h-5 sm:w-6 sm:h-6 ml-0.5 fill-current" />
          </div>
        )}
      </button>
    </div>
  );
};
