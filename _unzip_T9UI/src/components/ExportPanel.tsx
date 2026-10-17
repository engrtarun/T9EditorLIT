import React, { useState } from 'react';
import {
  CloudUpload,
  Download,
  Copy,
  Check,
  Send,
  Film,
  Music,
  Sliders,
  Sparkles,
  FileAudio,
  FileVideo,
  Scissors,
} from 'lucide-react';
import { exportCutList, TranscriptLine, CutStats, VideoTimelineClip, formatTimestamp } from '../utils/editor';

interface ExportPanelProps {
  lines: TranscriptLine[];
  stats: CutStats;
  selectedClip?: VideoTimelineClip | null;
}

export const ExportPanel: React.FC<ExportPanelProps> = ({
  lines,
  stats,
  selectedClip,
}) => {
  const [exportType, setExportType] = useState<'video' | 'audio' | 'chapters'>('video');
  const [videoFormat, setVideoFormat] = useState<'mp4' | 'mkv' | 'mov' | 'webm'>('mp4');
  const [resolution, setResolution] = useState<'4K' | '1080p' | '720p'>('4K');
  const [fps, setFps] = useState<number>(60);
  const [videoScope, setVideoScope] = useState<'kept-only' | 'entire' | 'selected-clip'>('kept-only');

  // Audio specific
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav' | 'aac' | 'flac'>('mp3');
  const [audioScope, setAudioScope] = useState<'kept-only' | 'selected-clip' | 'entire'>('kept-only');
  const [audioBitrate, setAudioBitrate] = useState<'320k' | '192k' | 'lossless'>('320k');

  // Statuses
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [downloadReady, setDownloadReady] = useState<string | null>(null);
  const [telegramSent, setTelegramSent] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const chapters = exportCutList(lines, 'chapters');
  const edl = exportCutList(lines, 'edl');

  const handleStartExport = () => {
    setIsExporting(true);
    setExportProgress(10);
    setDownloadReady(null);

    const interval = setInterval(() => {
      setExportProgress((p) => {
        if (p >= 100) {
          clearInterval(interval);
          setIsExporting(false);
          const ext = exportType === 'audio' ? audioFormat : videoFormat;
          setDownloadReady(`tutorial_${videoScope}_export_${Date.now()}.${ext}`);
          return 100;
        }
        return p + 20;
      });
    }, 300);
  };

  const handleDownloadFile = () => {
    if (!downloadReady) return;
    const dummyContent = exportType === 'audio' ? 'Simulated Audio Stream' : chapters;
    const blob = new Blob([dummyContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadReady;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleTelegramBackup = () => {
    setTelegramSent(true);
    setTimeout(() => setTelegramSent(false), 3000);
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden font-sans">
      {/* Header */}
      <div className="p-4 border-b border-[#1E202B] shrink-0 bg-[#14161F] space-y-1">
        <div className="flex items-center gap-2">
          <CloudUpload className="w-4 h-4 text-[#D4AF37]" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Export Studio & Distribution
          </h2>
        </div>
        <p className="text-[11px] text-slate-400">
          Render custom video, isolate audio tracks, or backup to Telegram cloud
        </p>
      </div>

      {/* Main Tab Switcher: Video vs Audio vs Project Data */}
      <div className="flex items-center gap-1 p-3 border-b border-[#1E202B] bg-[#0E1017]">
        <button
          onClick={() => setExportType('video')}
          className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            exportType === 'video'
              ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
          }`}
        >
          <FileVideo className="w-3.5 h-3.5" />
          <span>Video Export</span>
        </button>

        <button
          onClick={() => setExportType('audio')}
          className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            exportType === 'audio'
              ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
          }`}
        >
          <FileAudio className="w-3.5 h-3.5" />
          <span>Audio Only</span>
        </button>

        <button
          onClick={() => setExportType('chapters')}
          className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            exportType === 'chapters'
              ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
          }`}
        >
          <Film className="w-3.5 h-3.5" />
          <span>EDL / Chapters</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* VIDEO EXPORT OPTIONS */}
        {exportType === 'video' && (
          <div className="space-y-4">
            {/* Scope / Target Selector */}
            <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block">
                Export Target Range
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'kept-only', label: 'Clean Cuts Only', desc: 'All excised pauses removed' },
                  { id: 'entire', label: 'Entire Timeline', desc: 'Raw unedited full length' },
                  {
                    id: 'selected-clip',
                    label: 'Selected Clip',
                    desc: selectedClip ? `${(selectedClip.endTime - selectedClip.startTime).toFixed(0)}s clip` : 'Select on timeline',
                  },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setVideoScope(item.id as any)}
                    className={`p-2 rounded-lg text-left border transition-all cursor-pointer ${
                      videoScope === item.id
                        ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-white'
                        : 'border-[#1E202B] bg-[#12131A] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs font-semibold">{item.label}</div>
                    <div className="text-[9px] text-slate-500 mt-0.5 line-clamp-1">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Video Formats (MP4, MKV, MOV, WebM) */}
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Container Format
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(['mp4', 'mkv', 'mov', 'webm'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setVideoFormat(fmt)}
                    className={`py-2 px-1 text-center rounded-lg text-xs font-mono font-bold uppercase transition-all cursor-pointer border ${
                      videoFormat === fmt
                        ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A]'
                        : 'border-[#1E202B] bg-[#161822] text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    .{fmt}
                  </button>
                ))}
              </div>
            </div>

            {/* Resolution & FPS */}
            <div className="grid grid-cols-2 gap-3">
              {/* Resolution */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Resolution
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['4K', '1080p', '720p'] as const).map((res) => (
                    <button
                      key={res}
                      onClick={() => setResolution(res)}
                      className={`py-1.5 text-center rounded text-xs font-mono font-semibold transition-all cursor-pointer border ${
                        resolution === res
                          ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#D4AF37]'
                          : 'border-[#1E202B] bg-[#161822] text-slate-400'
                      }`}
                    >
                      {res}
                    </button>
                  ))}
                </div>
              </div>

              {/* Framerate FPS */}
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
                          : 'border-[#1E202B] bg-[#161822] text-slate-400'
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

        {/* AUDIO ONLY EXPORT (Requested by user: "audio me export karna ya koi specific part ki audio export karna") */}
        {exportType === 'audio' && (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block">
                Audio Range Selection
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'kept-only', label: 'Clean Audio (No Flubs)', desc: 'Excised pauses removed' },
                  {
                    id: 'selected-clip',
                    label: 'Selected Clip Only',
                    desc: selectedClip ? `${(selectedClip.endTime - selectedClip.startTime).toFixed(0)}s audio snippet` : 'Select clip on timeline',
                  },
                  { id: 'entire', label: 'Entire Master Track', desc: 'Raw master audio' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setAudioScope(item.id as any)}
                    className={`p-2.5 rounded-lg text-left border transition-all cursor-pointer ${
                      audioScope === item.id
                        ? 'border-[#D4AF37] bg-[#D4AF37]/10 text-white'
                        : 'border-[#1E202B] bg-[#12131A] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs font-semibold">{item.label}</div>
                    <div className="text-[9px] text-slate-500 mt-0.5 line-clamp-1">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Audio Formats (MP3, WAV, AAC, FLAC) */}
            <div className="space-y-2">
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
                    className={`p-2 text-center rounded-lg border transition-all cursor-pointer ${
                      audioFormat === fmt.id
                        ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A] font-bold'
                        : 'border-[#1E202B] bg-[#161822] text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <div className="text-xs font-mono font-bold uppercase">.{fmt.id}</div>
                    <div className="text-[8px] opacity-80 mt-0.5">{fmt.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Audio Bitrate */}
            <div className="p-3 rounded-lg bg-[#161822] border border-[#1E202B] flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400">Sample Rate:</span>
              <span className="text-[#D4AF37]">48,000 Hz · Stereo 32-bit Float</span>
            </div>
          </div>
        )}

        {/* CHAPTERS / EDL EXPORT */}
        {exportType === 'chapters' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300">
                YouTube Formatted Chapters
              </label>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(chapters);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="text-xs text-[#D4AF37] hover:underline font-mono flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy Chapters'}</span>
              </button>
            </div>
            <div className="p-3 rounded-lg bg-[#0E1017] border border-[#1E202B] text-xs font-mono text-slate-300 max-h-48 overflow-y-auto whitespace-pre-wrap select-all">
              {chapters}
            </div>
          </div>
        )}

        {/* RENDER / EXPORT TRIGGER BUTTON */}
        <div className="pt-2 space-y-3 border-t border-[#1E202B]">
          <button
            onClick={handleStartExport}
            disabled={isExporting}
            className="w-full py-3 rounded-xl bg-[#D4AF37] hover:bg-[#e5c358] active:scale-98 text-[#12131A] font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-[#D4AF37]/20"
          >
            <Download className="w-4 h-4 stroke-[2.5]" />
            <span>
              {isExporting
                ? `Rendering Export... (${exportProgress}%)`
                : exportType === 'audio'
                ? `Export Audio Track (.${audioFormat.toUpperCase()})`
                : `Export Video (${resolution} @ ${fps}fps .${videoFormat.toUpperCase()})`}
            </span>
          </button>

          {/* Progress Bar */}
          {isExporting && (
            <div className="w-full bg-[#161824] h-2 rounded-full overflow-hidden border border-[#23273D]">
              <div
                style={{ width: `${exportProgress}%` }}
                className="bg-[#D4AF37] h-full transition-all duration-300"
              />
            </div>
          )}

          {/* Download Ready File Alert */}
          {downloadReady && (
            <div className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-500/50 flex items-center justify-between text-xs text-emerald-300 animate-in fade-in">
              <span className="font-mono truncate">{downloadReady}</span>
              <button
                onClick={handleDownloadFile}
                className="px-3 py-1 rounded bg-emerald-500 text-black font-bold hover:bg-emerald-400 transition-colors cursor-pointer shrink-0 ml-2"
              >
                Save File
              </button>
            </div>
          )}
        </div>

        {/* Telegram Cloud Backup Button */}
        <div className="p-3.5 rounded-xl bg-gradient-to-br from-[#121929] to-[#161822] border border-[#223354] flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-bold text-slate-200">Telegram Cloud Channel Backup</h4>
            <p className="text-[10px] text-slate-400">Directly stream rendered file to your channel</p>
          </div>
          <button
            onClick={handleTelegramBackup}
            className="px-3 py-1.5 rounded-lg bg-[#24A1DE] hover:bg-[#2092ca] text-white font-medium text-xs transition-all cursor-pointer flex items-center gap-1.5 shrink-0 shadow-sm"
          >
            {telegramSent ? <Check className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
            <span>{telegramSent ? 'Sent!' : 'Telegram'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
