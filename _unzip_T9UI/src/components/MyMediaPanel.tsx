import React, { useState, useRef } from 'react';
import {
  FolderOpen,
  Upload,
  Play,
  Pause,
  Plus,
  Film,
  Music2,
  FileVideo,
  FileCode,
  Image,
  Check,
  Sparkles,
  Scissors,
  Trash2,
  Volume2,
} from 'lucide-react';
import { formatTimestamp } from '../utils/editor';

export interface MediaAsset {
  id: string;
  name: string;
  category: 'video' | 'audio' | 'broll';
  duration: number; // in seconds
  description: string;
  badge: string;
  url?: string;
  previewThumbnail?: string;
}

const STOCK_MEDIA_ASSETS: MediaAsset[] = [
  {
    id: 'broll-vscode-typing',
    name: 'VS Code Fast Typing Timelapse',
    category: 'broll',
    duration: 8.0,
    description: 'High-speed code refactoring & TypeScript generics typing',
    badge: '1080p 60FPS',
  },
  {
    id: 'broll-terminal-build',
    name: 'Terminal Fast Build & Vitest Pass',
    category: 'broll',
    duration: 5.5,
    description: 'Green test suites passing & Docker container startup logs',
    badge: 'TERMINAL',
  },
  {
    id: 'broll-architecture-diagram',
    name: 'System Architecture Blueprint',
    category: 'broll',
    duration: 6.0,
    description: 'Animated event-driven microservices data flow chart',
    badge: 'DIAGRAM',
  },
  {
    id: 'broll-keyboard-asmr',
    name: 'Mechanical Keyboard ASMR B-Roll',
    category: 'broll',
    duration: 7.2,
    description: 'Cinematic close-up of tactile mechanical switches in action',
    badge: '4K B-ROLL',
  },
  {
    id: 'broll-git-graph',
    name: 'Git Rebase Branching Graph',
    category: 'broll',
    duration: 4.8,
    description: 'Visual commit tree merge animation for tutorial explanation',
    badge: 'GIT FLOW',
  },
  {
    id: 'broll-cloud-deploy',
    name: 'Cloud Production Deployment',
    category: 'broll',
    duration: 5.0,
    description: 'Zero-downtime deployment health check dashboard',
    badge: 'CLOUD',
  },
  {
    id: 'audio-keyboard-click',
    name: 'ASMR Mechanical Typing Loop',
    category: 'audio',
    duration: 6.0,
    description: 'Subtle background tactile click sound for focus sections',
    badge: 'SFX',
  },
  {
    id: 'audio-success-chime',
    name: 'Code Passing Notification Chime',
    category: 'audio',
    duration: 1.5,
    description: 'Crisp audio chime when tests pass or build succeeds',
    badge: 'SFX',
  },
  {
    id: 'audio-whoosh-transition',
    name: 'Fast Swoosh Cut Transition',
    category: 'audio',
    duration: 0.8,
    description: 'Modern quick whoosh transition for clip splices',
    badge: 'SFX',
  },
  {
    id: 'audio-lofi-beat',
    name: 'Lofi Coding Study Beat',
    category: 'audio',
    duration: 30.0,
    description: 'Mellow chillhop instrumental background beat',
    badge: 'MUSIC',
  },
];

interface MyMediaPanelProps {
  currentTime: number;
  onInsertMediaAtPlayhead: (media: MediaAsset) => void;
  onAppendMedia: (media: MediaAsset) => void;
}

export const MyMediaPanel: React.FC<MyMediaPanelProps> = ({
  currentTime,
  onInsertMediaAtPlayhead,
  onAppendMedia,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'broll' | 'audio' | 'uploads'>('all');
  const [userUploads, setUserUploads] = useState<MediaAsset[]>([]);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [justInsertedId, setJustInsertedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newAssets: MediaAsset[] = [];
    Array.from(files).forEach((file, idx) => {
      const isAudio = file.type.startsWith('audio/');
      const isVideo = file.type.startsWith('video/');
      const objectUrl = URL.createObjectURL(file);

      newAssets.push({
        id: `upload-${Date.now()}-${idx}`,
        name: file.name.replace(/\.[^/.]+$/, ''),
        category: isAudio ? 'audio' : 'video',
        duration: isAudio ? 12.0 : 8.5,
        description: `Custom ${isAudio ? 'Audio' : 'Video'} file · ${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        badge: isAudio ? 'AUDIO FILE' : 'VIDEO FILE',
        url: objectUrl,
      });
    });

    setUserUploads((prev) => [...newAssets, ...prev]);
    setActiveTab('uploads');
  };

  const allAssets = [...userUploads, ...STOCK_MEDIA_ASSETS];
  const filteredAssets =
    activeTab === 'all'
      ? allAssets
      : activeTab === 'uploads'
      ? userUploads
      : allAssets.filter((a) => a.category === activeTab);

  const handleInsert = (asset: MediaAsset) => {
    onInsertMediaAtPlayhead(asset);
    setJustInsertedId(asset.id);
    setTimeout(() => setJustInsertedId(null), 2500);
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden font-sans">
      {/* Header */}
      <div className="p-4 border-b border-[#1E202B] shrink-0 bg-[#14161F] flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-[#D4AF37]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              My Media Library
            </h2>
          </div>
          <p className="text-[11px] text-slate-400 font-mono">
            Insert video clips & B-Roll directly at current playhead [{formatTimestamp(currentTime)}]
          </p>
        </div>

        {/* Upload Button */}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#e5c358] active:scale-95 text-[#12131A] text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload File</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 p-3 border-b border-[#1E202B] text-xs font-mono bg-[#0E1017] shrink-0">
        {(
          [
            { id: 'all', label: 'All Assets' },
            { id: 'broll', label: 'Coding B-Roll' },
            { id: 'audio', label: 'Audio & SFX' },
            { id: 'uploads', label: `My Uploads (${userUploads.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1 rounded-full text-[11px] transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-xs'
                : 'bg-[#161822] text-slate-400 hover:text-slate-200 hover:bg-[#1E202B]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Media Items Grid */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filteredAssets.length === 0 ? (
          <div className="text-center py-12 px-4 border-2 border-dashed border-[#1E202B] rounded-2xl bg-[#141620]">
            <Upload className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <h3 className="text-xs font-bold text-slate-300">No custom uploads yet</h3>
            <p className="text-[11px] text-slate-500 mt-1 max-w-xs mx-auto">
              Drag & drop MP4, MOV, or audio clips here to splice them into your programming tutorial.
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 px-3 py-1.5 rounded-lg bg-[#1E2130] hover:bg-[#2A2E44] text-[#D4AF37] text-xs font-semibold cursor-pointer border border-[#2B2F42]"
            >
              Choose Video or Audio File
            </button>
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const isPreviewing = previewingId === asset.id;
            const wasJustInserted = justInsertedId === asset.id;

            return (
              <div
                key={asset.id}
                className={`p-3.5 rounded-xl border transition-all bg-[#161824] hover:bg-[#1B1E2D] ${
                  wasJustInserted
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/20'
                    : 'border-[#1E202B] hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Left: Thumbnail Icon & Info */}
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-12 h-12 rounded-lg bg-[#0E1017] border border-white/5 flex flex-col items-center justify-center shrink-0 text-slate-400 relative overflow-hidden group">
                      {asset.category === 'audio' ? (
                        <Music2 className="w-5 h-5 text-amber-400" />
                      ) : (
                        <FileVideo className="w-5 h-5 text-cyan-400" />
                      )}
                      <span className="text-[8px] font-mono text-slate-500 mt-0.5">
                        {asset.duration.toFixed(1)}s
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-semibold text-slate-100 truncate">
                          {asset.name}
                        </h4>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-black/50 text-[#D4AF37] border border-[#D4AF37]/30 shrink-0">
                          {asset.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                        {asset.description}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 mt-1">
                        <span>Duration: {asset.duration.toFixed(1)}s</span>
                        <span>·</span>
                        <span>Format: {asset.category.toUpperCase()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Right Action: Insert at Playhead */}
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button
                      onClick={() => handleInsert(asset)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm active:scale-95 ${
                        wasJustInserted
                          ? 'bg-emerald-600 text-white'
                          : 'bg-[#D4AF37]/20 hover:bg-[#D4AF37] text-[#D4AF37] hover:text-[#12131A] border border-[#D4AF37]/50'
                      }`}
                      title={`Insert this clip at ${formatTimestamp(currentTime)} on the timeline`}
                    >
                      {wasJustInserted ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Inserted!</span>
                        </>
                      ) : (
                        <>
                          <Scissors className="w-3.5 h-3.5" />
                          <span>Insert at Playhead</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => onAppendMedia(asset)}
                      className="text-[10px] text-slate-400 hover:text-slate-200 py-0.5 text-center transition-colors cursor-pointer"
                    >
                      + Append to End
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Helper Note */}
      <div className="p-3 bg-[#0E1017] border-t border-[#1E202B] text-[11px] font-mono text-slate-400 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span>Splicing splits the video at the playhead and inserts your clip seamlessly.</span>
        </div>
        <span className="text-[#D4AF37] font-bold">Playhead: {formatTimestamp(currentTime)}</span>
      </div>
    </div>
  );
};
