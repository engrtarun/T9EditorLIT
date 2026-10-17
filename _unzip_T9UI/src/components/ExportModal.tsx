import React, { useState } from 'react';
import {
  X,
  Copy,
  Check,
  Download,
  Film,
  FileAudio,
  FileVideo,
  Code,
  Send,
  Sparkles,
  Sliders,
} from 'lucide-react';
import {
  exportCutList,
  TranscriptLine,
  CutStats,
  VideoTimelineClip,
  formatTimestamp,
} from '../utils/editor';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  lines: TranscriptLine[];
  stats: CutStats;
  selectedClip?: VideoTimelineClip | null;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  lines,
  stats,
  selectedClip,
}) => {
  const [activeTab, setActiveTab] = useState<'video' | 'audio' | 'nle'>('video');

  // Video Settings
  const [videoFormat, setVideoFormat] = useState<'mp4' | 'mkv' | 'mov' | 'webm'>('mp4');
  const [resolution, setResolution] = useState<'4K' | '1080p' | '720p'>('4K');
  const [fps, setFps] = useState<number>(60);
  const [videoScope, setVideoScope] = useState<'kept-only' | 'entire' | 'selected-clip'>('kept-only');

  // Audio Settings (User requested: "audio me export karna ya koi specific part ki audio export karna")
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav' | 'aac' | 'flac'>('mp3');
  const [audioScope, setAudioScope] = useState<'kept-only' | 'selected-clip' | 'entire'>('kept-only');

  // NLE / Chapters
  const [nleFormat, setNleFormat] = useState<'chapters' | 'edl' | 'fcpxml' | 'json'>('chapters');

  // Render Simulation State
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [downloadReady, setDownloadReady] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [telegramSent, setTelegramSent] = useState(false);

  if (!isOpen) return null;

  const exportedNleText = exportCutList(lines, nleFormat);

  const handleStartRender = () => {
    setIsRendering(true);
    setRenderProgress(5);
    setDownloadReady(null);

    const interval = setInterval(() => {
      setRenderProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsRendering(false);
          const ext = activeTab === 'audio' ? audioFormat : activeTab === 'video' ? videoFormat : nleFormat;
          setDownloadReady(`tutorial_render_${Date.now()}.${ext}`);
          return 100;
        }
        return prev + 15;
      });
    }, 200);
  };

  const handleDownloadFile = () => {
    if (!downloadReady) return;
    const dummyContent =
      activeTab === 'audio'
        ? `T9 EditorLIT Audio Master - ${audioFormat.toUpperCase()} - 48kHz Stereo 320kbps\n` +
          `Trimmed duration: ${formatTimestamp(stats.keptDuration)}\n` +
          `Time Saved: ${stats.timeSavedSeconds.toFixed(1)}s`
        : activeTab === 'video'
        ? `T9 EditorLIT 4K Video Master - ${resolution} @ ${fps}fps (${videoFormat.toUpperCase()})\n` +
          `Total kept scenes: ${stats.keptCount}\n` +
          `Output duration: ${formatTimestamp(stats.keptDuration)}`
        : exportedNleText;

    const blob = new Blob([dummyContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadReady;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl bg-[#141624] border border-[#23273D] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden select-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1E202B] bg-[#0E1017]">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#D4AF37]" />
            <h3 className="text-sm font-bold text-slate-100">Export Studio & Master Distribution</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close export dialog"
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Format Selector Tabs */}
        <div className="flex items-center gap-2 px-6 py-2.5 bg-[#0E1017] border-b border-[#1E202B] text-xs font-mono">
          <button
            onClick={() => setActiveTab('video')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
              activeTab === 'video'
                ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
            }`}
          >
            <FileVideo className="w-3.5 h-3.5" />
            <span>Video (MP4 / MKV)</span>
          </button>

          <button
            onClick={() => setActiveTab('audio')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
              activeTab === 'audio'
                ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
            }`}
          >
            <FileAudio className="w-3.5 h-3.5" />
            <span>Audio Only (MP3 / WAV)</span>
          </button>

          <button
            onClick={() => setActiveTab('nle')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
              activeTab === 'nle'
                ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
            }`}
          >
            <Film className="w-3.5 h-3.5" />
            <span>EDL & Chapters</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* TAB 1: VIDEO EXPORT (MP4, MKV, MOV, WebM, 4K/1080p, FPS) */}
          {activeTab === 'video' && (
            <div className="space-y-4">
              {/* Scope */}
              <div className="p-3.5 rounded-xl bg-[#161824] border border-[#23273D] space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block">
                  Export Video Target Range
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'kept-only', label: 'Clean Cuts Only', desc: 'All pauses excised' },
                    { id: 'entire', label: 'Full Raw Recording', desc: 'Original full length' },
                    {
                      id: 'selected-clip',
                      label: 'Selected Clip',
                      desc: selectedClip ? `${(selectedClip.endTime - selectedClip.startTime).toFixed(0)}s clip` : 'Select on timeline',
                    },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setVideoScope(item.id as any)}
                      className={`p-2.5 rounded-lg text-left border transition-all cursor-pointer ${
                        videoScope === item.id
                          ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-white'
                          : 'border-[#1E202B] bg-[#12131A] text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      <div className="text-xs font-semibold">{item.label}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{item.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Formats */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Container Format (.MP4, .MKV, .MOV, .WEBM)
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {(['mp4', 'mkv', 'mov', 'webm'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setVideoFormat(fmt)}
                      className={`py-2 text-center rounded-lg text-xs font-mono font-bold uppercase transition-all cursor-pointer border ${
                        videoFormat === fmt
                          ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A]'
                          : 'border-[#1E202B] bg-[#161824] text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      .{fmt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality & FPS */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                    Quality Resolution
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['4K', '1080p', '720p'] as const).map((res) => (
                      <button
                        key={res}
                        onClick={() => setResolution(res)}
                        className={`py-1.5 text-center rounded text-xs font-mono font-semibold transition-all cursor-pointer border ${
                          resolution === res
                            ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#D4AF37]'
                            : 'border-[#1E202B] bg-[#161824] text-slate-400'
                        }`}
                      >
                        {res}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                    Framerate (FPS)
                  </label>
                  <div className="grid grid-cols-4 gap-1">
                    {([24, 30, 60, 120] as const).map((rate) => (
                      <button
                        key={rate}
                        onClick={() => setFps(rate)}
                        className={`py-1.5 text-center rounded text-xs font-mono font-semibold transition-all cursor-pointer border ${
                          fps === rate
                            ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#D4AF37]'
                            : 'border-[#1E202B] bg-[#161824] text-slate-400'
                        }`}
                      >
                        {rate}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: AUDIO ONLY EXPORT (MP3, WAV, AAC, FLAC, specific part) */}
          {activeTab === 'audio' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-[#161824] border border-[#23273D] space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block">
                  Audio Range Selection (Podcast / Lecture Export)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'kept-only', label: 'Clean Audio (No Flubs)', desc: 'Excised pauses removed' },
                    {
                      id: 'selected-clip',
                      label: 'Selected Clip Only',
                      desc: selectedClip ? `${(selectedClip.endTime - selectedClip.startTime).toFixed(0)}s audio snippet` : 'Select clip on timeline',
                    },
                    { id: 'entire', label: 'Entire Master Track', desc: 'Raw master speech' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setAudioScope(item.id as any)}
                      className={`p-2.5 rounded-lg text-left border transition-all cursor-pointer ${
                        audioScope === item.id
                          ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-white'
                          : 'border-[#1E202B] bg-[#12131A] text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      <div className="text-xs font-semibold">{item.label}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{item.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Audio Format */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Audio Format & Codec
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { id: 'mp3', label: 'MP3 (320k)', sub: 'Podcast/YouTube' },
                    { id: 'wav', label: 'WAV 24-bit', sub: 'Studio Master' },
                    { id: 'aac', label: 'AAC / M4A', sub: 'High Efficiency' },
                    { id: 'flac', label: 'FLAC Lossless', sub: 'Archival' },
                  ].map((fmt) => (
                    <button
                      key={fmt.id}
                      onClick={() => setAudioFormat(fmt.id as any)}
                      className={`p-2.5 text-center rounded-lg border transition-all cursor-pointer ${
                        audioFormat === fmt.id
                          ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A] font-bold'
                          : 'border-[#1E202B] bg-[#161824] text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      <div className="text-xs font-mono font-bold uppercase">.{fmt.id}</div>
                      <div className="text-[9px] opacity-80 mt-0.5">{fmt.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-[#161824] border border-[#23273D] flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Audio Specs:</span>
                <span className="text-[#D4AF37]">48,000 Hz · Stereo 32-bit Float · Lossless NVENC</span>
              </div>
            </div>
          )}

          {/* TAB 3: EDL / CHAPTERS */}
          {activeTab === 'nle' && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                {[
                  { id: 'chapters', label: 'YouTube Chapters' },
                  { id: 'edl', label: 'Premiere / DaVinci EDL' },
                  { id: 'fcpxml', label: 'Final Cut FCPXML' },
                  { id: 'json', label: 'Raw JSON Cutlist' },
                ].map((fmt) => (
                  <button
                    key={fmt.id}
                    onClick={() => setNleFormat(fmt.id as any)}
                    className={`py-2 text-center rounded-lg text-xs font-medium border transition-all cursor-pointer ${
                      nleFormat === fmt.id
                        ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A] font-bold'
                        : 'border-[#1E202B] bg-[#161824] text-slate-400'
                    }`}
                  >
                    {fmt.label}
                  </button>
                ))}
              </div>

              <div className="p-3 rounded-lg bg-[#0E1017] border border-[#1E202B] text-xs font-mono text-slate-300 max-h-48 overflow-y-auto whitespace-pre-wrap select-all">
                {exportedNleText}
              </div>
            </div>
          )}

          {/* RENDER TRIGGER & DOWNLOAD */}
          <div className="pt-2 space-y-3 border-t border-[#1E202B]">
            <button
              onClick={handleStartRender}
              disabled={isRendering}
              className="w-full py-3 rounded-xl bg-[#D4AF37] hover:bg-[#e5c358] active:scale-98 text-[#12131A] font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-[#D4AF37]/20"
            >
              <Download className="w-4 h-4 stroke-[2.5]" />
              <span>
                {isRendering
                  ? `Rendering Master File... (${renderProgress}%)`
                  : activeTab === 'audio'
                  ? `Render Audio Master (.${audioFormat.toUpperCase()})`
                  : activeTab === 'video'
                  ? `Render Lossless Video (${resolution} @ ${fps}fps .${videoFormat.toUpperCase()})`
                  : `Export ${nleFormat.toUpperCase()} Metadata`}
              </span>
            </button>

            {/* Render Progress Bar */}
            {isRendering && (
              <div className="w-full bg-[#161824] h-2 rounded-full overflow-hidden border border-[#23273D]">
                <div
                  style={{ width: `${renderProgress}%` }}
                  className="bg-[#D4AF37] h-full transition-all duration-200"
                />
              </div>
            )}

            {/* Download Ready File Alert */}
            {downloadReady && (
              <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/60 flex items-center justify-between text-xs text-emerald-300 animate-in fade-in">
                <div className="flex items-center gap-2 truncate">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="font-mono truncate">{downloadReady}</span>
                </div>
                <button
                  onClick={handleDownloadFile}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-black font-bold transition-colors cursor-pointer shrink-0 ml-2"
                >
                  Download File
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-[#1E202B] bg-[#0E1017] text-xs font-mono">
          <div className="text-slate-400">
            <span>{stats.cutCount} segments excised · </span>
            <span className="text-[#D4AF37] font-semibold">{stats.timeSavedSeconds.toFixed(0)}s dead air saved</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(exportedNleText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161824] hover:bg-[#1E202B] border border-[#23273D] text-slate-200 transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy Text'}</span>
            </button>

            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#e5c358] text-[#12131A] font-bold transition-all cursor-pointer shadow-sm"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
