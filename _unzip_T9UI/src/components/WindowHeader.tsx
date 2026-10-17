import React from 'react';
import {
  Download,
  HelpCircle,
  Film,
  RefreshCw,
  Scissors,
  LayoutGrid,
  Compass,
} from 'lucide-react';
import { TutorialProject } from '../data/sampleTutorials';

interface WindowHeaderProps {
  currentProject: TutorialProject;
  projects: TutorialProject[];
  onSelectProject: (p: TutorialProject) => void;
  onOpenExport: () => void;
  onOpenShortcuts: () => void;
  onAutoCutFlubs: () => void;
  onResetCuts: () => void;
  onGoHome: () => void;
  onStartTour: () => void;
  isInspectActive: boolean;
  onToggleInspect: () => void;
  flubCount: number;
}

export const WindowHeader: React.FC<WindowHeaderProps> = ({
  currentProject,
  projects,
  onSelectProject,
  onOpenExport,
  onOpenShortcuts,
  onAutoCutFlubs,
  onResetCuts,
  onGoHome,
  onStartTour,
  isInspectActive,
  onToggleInspect,
  flubCount,
}) => {
  return (
    <header className="h-10 bg-[#0E1017]/95 border-b border-[#1E202B] flex items-center justify-between px-3 select-none shrink-0 z-30 backdrop-blur-md">
      {/* Window Controls & Brand */}
      <div className="flex items-center gap-2.5">
        {/* macOS Traffic Lights */}
        <div className="flex items-center gap-1.5 group">
          <span
            className="w-3 h-3 rounded-full bg-[#FF5F56] border border-[#E0443E] inline-flex items-center justify-center text-[8px] text-black/60 opacity-90 group-hover:opacity-100 cursor-pointer"
            title="Close Window"
          />
          <span
            className="w-3 h-3 rounded-full bg-[#FFBD2E] border border-[#DEA123] inline-flex items-center justify-center text-[8px] text-black/60 opacity-90 group-hover:opacity-100 cursor-pointer"
            title="Minimize"
          />
          <span
            className="w-3 h-3 rounded-full bg-[#27C93F] border border-[#1AAB29] inline-flex items-center justify-center text-[8px] text-black/60 opacity-90 group-hover:opacity-100 cursor-pointer"
            title="Maximize"
          />
        </div>

        <div className="h-4 w-[1px] bg-[#1E202B] mx-1" />

        {/* Back to Dashboard */}
        <button
          onClick={onGoHome}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-[#161822] hover:bg-[#1E202B] text-slate-300 hover:text-[#D4AF37] border border-[#1E202B] transition-colors cursor-pointer"
          title="Return to Projects Dashboard (H)"
        >
          <LayoutGrid className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span className="hidden xs:inline">Dashboard</span>
        </button>

        {/* Brand: T9 EditorLIT */}
        <div className="flex items-center gap-1.5 ml-1">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[#D4AF37] to-[#997C23] flex items-center justify-center shadow-sm">
            <span className="text-[10px] font-black text-[#12131A] tracking-tighter">T9</span>
          </div>
          <span className="text-xs font-bold tracking-tight text-slate-100">T9 EditorLIT</span>
          <span className="text-[9px] font-medium text-slate-400 px-1.5 py-0.2 rounded bg-white/5 border border-white/10 hidden sm:inline">
            Studio
          </span>
        </div>

        {/* Active Project Switcher Dropdown */}
        <div className="hidden md:flex items-center gap-1.5 ml-2 text-xs text-slate-400 bg-[#161822] px-2.5 py-1 rounded-md border border-[#1E202B]">
          <Film className="w-3.5 h-3.5 text-[#D4AF37]" />
          <select
            value={currentProject.id}
            onChange={(e) => {
              const found = projects.find((p) => p.id === e.target.value);
              if (found) onSelectProject(found);
            }}
            aria-label="Select Tutorial Project"
            className="bg-transparent text-slate-200 text-xs focus:outline-none cursor-pointer pr-1"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#161822] text-slate-200">
                {p.fileName} ({p.resolution})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Right Top Actions */}
      <div className="flex items-center gap-2">
        {flubCount > 0 && (
          <button
            onClick={onAutoCutFlubs}
            data-tour="auto-cut"
            data-inspect="auto-cut-flubs"
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-[#D4AF37]/15 hover:bg-[#D4AF37]/25 border border-[#D4AF37]/50 text-[#D4AF37] transition-all cursor-pointer animate-pulse"
            title="Automatically cut pauses and verbal stumbles (Shift+C)"
          >
            <Scissors className="w-3 h-3" />
            <span className="hidden sm:inline">Auto-Cut Flubs</span>
            <span className="bg-[#D4AF37]/30 text-white px-1 rounded-sm text-[9px] font-mono">{flubCount}</span>
          </button>
        )}

        {/* Inspect View Toggle */}
        <button
          onClick={onToggleInspect}
          data-tour="inspect"
          className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md transition-all cursor-pointer border ${
            isInspectActive
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.5)] animate-pulse'
              : 'bg-[#161822] hover:bg-[#1E202B] text-slate-300 hover:text-cyan-400 border-[#1E202B]'
          }`}
          title="Inspect Mode (Shift+I) - View UX Psychology Rules & Community Benchmarks"
        >
          <Compass className={`w-3.5 h-3.5 ${isInspectActive ? 'text-cyan-400 rotate-45' : 'text-slate-400'} transition-transform`} />
          <span className="hidden sm:inline">Inspect View</span>
        </button>

        {/* Interactive Tour Guide Button */}
        <button
          onClick={onStartTour}
          className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-300 hover:text-[#D4AF37] transition-colors cursor-pointer"
          title="Start Interactive Tour Guide"
        >
          <HelpCircle className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span className="hidden sm:inline">Tour Guide</span>
        </button>

        {/* Reset Cuts Button */}
        <button
          onClick={onResetCuts}
          className="text-slate-400 hover:text-slate-200 p-1.5 rounded-md hover:bg-[#1E202B] transition-colors cursor-pointer"
          title="Reset All Cuts"
        >
          <RefreshCw className="w-3.5 h-3.5 hover:rotate-180 transition-transform duration-500" />
        </button>

        {/* Main Lossless Export Button */}
        <button
          onClick={onOpenExport}
          data-tour="export"
          data-inspect="export-button"
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-md bg-[#D4AF37] hover:bg-[#e5c358] active:scale-95 text-[#12131A] transition-all cursor-pointer shadow-sm animate-pulse-gold"
          title="Export Video (4K, MKV, Audio MP3, EDL)"
        >
          <Download className="w-3.5 h-3.5 stroke-[2.5]" />
          <span>Export 4K</span>
        </button>
      </div>
    </header>
  );
};
