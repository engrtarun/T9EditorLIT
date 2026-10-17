import React, { useState } from 'react';
import {
  Plus,
  UploadCloud,
  Film,
  Scissors,
  Search,
  ChevronRight,
  Code2,
  FolderOpen,
  HelpCircle,
  Settings,
} from 'lucide-react';
import { TutorialProject } from '../data/sampleTutorials';

interface DashboardViewProps {
  projects: TutorialProject[];
  onOpenProject: (project: TutorialProject) => void;
  onNewProject: (file?: File) => void;
  onDeleteProject: (id: string) => void;
  onOpenSettings: () => void;
  onStartTour: () => void;
  activeWallpaperName: string;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  onOpenProject,
  onNewProject,
  onDeleteProject,
  onOpenSettings,
  onStartTour,
  activeWallpaperName,
}) => {
  const [search, setSearch] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const filteredProjects = projects.filter(
    (p) =>
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.fileName.toLowerCase().includes(search.toLowerCase())
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onNewProject(files[0]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onNewProject(files[0]);
    }
  };

  return (
    <div className="flex-1 w-full h-full overflow-y-auto bg-[#12131A]/85 backdrop-blur-md flex flex-col select-none">
      {/* Top Bar (Veed Style) */}
      <header className="h-16 border-b border-[#1E202B] px-6 lg:px-8 flex items-center justify-between shrink-0 bg-[#12131A]/95 backdrop-blur-lg sticky top-0 z-20">
        {/* Left Logo */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#D4AF37] to-[#8C6D1F] flex items-center justify-center shadow-lg shadow-[#D4AF37]/20">
            <span className="font-mono font-black text-xs text-[#12131A] tracking-tighter">T9</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-slate-100">T9 EditorLIT</h1>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30">
                Studio
              </span>
            </div>
            <p className="text-[11px] text-slate-400">High-Velocity Tutorial Cutting Engine</p>
          </div>
        </div>

        {/* Center Search Input */}
        <div className="hidden md:flex items-center max-w-md w-full mx-8">
          <div className="relative w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tutorial recordings..."
              className="w-full bg-[#161824] border border-[#232636] rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            />
          </div>
        </div>

        {/* Right Actions & User Profile */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Interactive Tour Guide Button */}
          <button
            onClick={onStartTour}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161824] hover:bg-[#1E2130] border border-[#232636] text-xs font-medium text-slate-300 hover:text-[#D4AF37] transition-colors cursor-pointer"
            title="Start Interactive Tour Guide"
          >
            <HelpCircle className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="hidden sm:inline">Tour Guide</span>
          </button>

          {/* Settings & Wallpaper */}
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161824] hover:bg-[#1E2130] border border-[#232636] text-xs font-medium text-slate-300 hover:text-[#D4AF37] transition-colors cursor-pointer"
            title="Change Wallpaper & Background"
          >
            <Settings className="w-3.5 h-3.5 text-slate-400" />
            <span className="hidden sm:inline">Settings</span>
          </button>

          {/* User Profile */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#161824] border border-[#232636]">
            <div className="w-6 h-6 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/50 flex items-center justify-center text-[10px] font-bold text-[#D4AF37]">
              TK
            </div>
            <span className="text-xs font-medium text-slate-300 hidden sm:inline">Tarun Kumar</span>
          </div>

          {/* Big + New Project Button */}
          <label className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#e5c358] active:scale-95 text-[#12131A] text-xs font-bold shadow-lg shadow-[#D4AF37]/25 transition-all cursor-pointer whitespace-nowrap">
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>New Project</span>
            <input
              type="file"
              accept="video/*"
              onChange={handleFileInput}
              className="hidden"
            />
          </label>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="p-6 lg:p-10 max-w-7xl w-full mx-auto space-y-8">
        {/* Drop Zone: Up to 5GB Raw Video Drop Area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all overflow-hidden ${
            isDragging
              ? 'border-[#D4AF37] bg-[#D4AF37]/10 scale-[1.01]'
              : 'border-[#232636] bg-[#141622]/80 hover:border-[#D4AF37]/40 hover:bg-[#161826]'
          }`}
        >
          <div className="flex flex-col items-center justify-center max-w-lg mx-auto space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37] shadow-lg shadow-[#D4AF37]/10">
              <UploadCloud className="w-7 h-7" />
            </div>

            <div className="space-y-1">
              <h2 className="text-base sm:text-lg font-bold text-slate-100">
                Drop your raw programming tutorial video here
              </h2>
              <p className="text-xs text-slate-400">
                Supports up to 5GB raw files (MP4, MOV, MKV, WebM) at 4K 60FPS. Instant transcript & cut generation.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <label className="px-4 py-2 rounded-lg bg-[#1E2130] hover:bg-[#25293C] border border-[#2C3044] text-xs font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer flex items-center gap-2">
                <FolderOpen className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>Browse Files</span>
                <input
                  type="file"
                  accept="video/*"
                  onChange={handleFileInput}
                  className="hidden"
                />
              </label>
              <button
                onClick={() => onOpenProject(projects[0])}
                className="px-4 py-2 rounded-lg bg-[#D4AF37]/15 hover:bg-[#D4AF37]/25 border border-[#D4AF37]/40 text-xs font-semibold text-[#D4AF37] transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Load Sample TS 5.6 Project</span>
              </button>
            </div>
          </div>
        </div>

        {/* Recent Projects Header & Filters */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                Recent Projects ({filteredProjects.length})
              </h3>
              <p className="text-xs text-slate-500">
                Click any project card to enter the multi-mode studio editor
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="hidden sm:inline">Wallpaper: {activeWallpaperName}</span>
              <button
                onClick={onOpenSettings}
                className="text-[#D4AF37] hover:underline cursor-pointer"
              >
                Change
              </button>
            </div>
          </div>

          {/* Projects Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredProjects.map((project) => {
              const cutLinesCount = project.lines.filter((l) => l.status === 'cut').length;
              const totalLines = project.lines.length;
              const cutRatio = totalLines > 0 ? Math.round((cutLinesCount / totalLines) * 100) : 0;

              return (
                <div
                  key={project.id}
                  onClick={() => onOpenProject(project)}
                  className="group bg-[#141622] hover:bg-[#181B2B] border border-[#1E2130] hover:border-[#D4AF37]/50 rounded-xl overflow-hidden shadow-lg transition-all duration-200 flex flex-col cursor-pointer hover:shadow-2xl hover:shadow-[#D4AF37]/10"
                >
                  {/* Thumbnail Simulated Player */}
                  <div className="relative aspect-video bg-[#0E1017] flex items-center justify-center overflow-hidden border-b border-[#1E2130] group-hover:scale-[1.01] transition-transform">
                    {/* Simulated code preview in thumbnail */}
                    <div className="absolute inset-0 p-3 opacity-40 font-mono text-[9px] text-slate-400 select-none overflow-hidden">
                      <div className="text-[#D4AF37]">export class TypedEventBus&lt;T&gt; &#123;</div>
                      <div className="text-slate-500 pl-2">// strict type mappings</div>
                      <div className="text-slate-300 pl-2">on(event, handler) &#123; ... &#125;</div>
                    </div>

                    {/* Play Hover Overlay */}
                    <div className="w-12 h-12 rounded-full bg-[#12131A]/85 border border-[#D4AF37] text-[#D4AF37] flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform z-10">
                      <Film className="w-5 h-5 fill-current" />
                    </div>

                    {/* Duration Badge */}
                    <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 font-mono text-[10px] text-slate-200 border border-white/10">
                      {Math.floor(project.duration / 60)}:{(project.duration % 60).toString().padStart(2, '0')}
                    </div>

                    {/* Resolution / FPS badge */}
                    <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/70 font-mono text-[9px] text-[#D4AF37] border border-[#D4AF37]/30">
                      {project.resolution} · {project.fps}fps
                    </div>
                  </div>

                  {/* Card Body */}
                  <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold text-slate-100 group-hover:text-[#D4AF37] transition-colors line-clamp-1">
                        {project.title}
                      </h4>
                      <p className="text-xs text-slate-500 font-mono line-clamp-1">
                        {project.fileName}
                      </p>
                    </div>

                    {/* Progress / Cut Stats */}
                    <div className="pt-2 border-t border-[#1E2130] flex items-center justify-between text-xs font-mono">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Scissors className="w-3 h-3 text-[#D4AF37]" />
                        <span>{cutLinesCount} cuts ({cutRatio}%)</span>
                      </div>

                      <div className="flex items-center gap-1 text-[#D4AF37] font-semibold group-hover:translate-x-0.5 transition-transform">
                        <span>Open Editor</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
};
