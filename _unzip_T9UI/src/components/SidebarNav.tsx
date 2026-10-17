import React from 'react';
import {
  Home,
  Scissors,
  Type,
  Music2,
  Shapes,
  FolderOpen,
  Settings,
  Sparkles,
} from 'lucide-react';

export type EditorMode = 'media' | 'cut' | 'text' | 'audio' | 'elements';

interface SidebarNavProps {
  currentMode: EditorMode;
  onSelectMode: (mode: EditorMode) => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  currentMode,
  onSelectMode,
  onGoHome,
  onOpenSettings,
}) => {
  const modes: {
    id: EditorMode;
    label: string;
    icon: React.ReactNode;
    shortcut: string;
    description: string;
  }[] = [
    {
      id: 'media',
      label: 'My Media',
      icon: <FolderOpen className="w-4 h-4 transition-transform group-hover:scale-110" />,
      shortcut: '1',
      description: 'Upload video clips, B-Roll, and audio to splice at playhead',
    },
    {
      id: 'cut',
      label: 'Cut & Script',
      icon: <Scissors className="w-4 h-4 transition-transform group-hover:scale-110" />,
      shortcut: '2',
      description: 'Transcript-based video cutting & pause removal',
    },
    {
      id: 'text',
      label: 'Text & Subs',
      icon: <Type className="w-4 h-4 transition-transform group-hover:scale-110" />,
      shortcut: '3',
      description: 'Coder Army & Apna College bold titles & captions',
    },
    {
      id: 'audio',
      label: 'Audio & SFX',
      icon: <Music2 className="w-4 h-4 transition-transform group-hover:scale-110" />,
      shortcut: '4',
      description: 'Background beats, noise reduction & typing ASMR',
    },
    {
      id: 'elements',
      label: 'Elements',
      icon: <Shapes className="w-4 h-4 transition-transform group-hover:scale-110" />,
      shortcut: '5',
      description: 'Code badges, terminal callouts & focus boxes',
    },
  ];

  return (
    <aside
      aria-label="Sidebar Navigation"
      data-tour="sidebar"
      data-inspect="sidebar-nav"
      className="w-16 lg:w-18 bg-[#0E1017]/95 border-r border-[#1E202B] flex flex-col items-center justify-between py-3 shrink-0 select-none z-20 backdrop-blur-md"
    >
      {/* Top: Home Button & Modes List */}
      <div className="flex flex-col items-center gap-2 w-full">
        {/* Home / Back to Dashboard */}
        <div className="relative group w-full px-2">
          <button
            onClick={onGoHome}
            aria-label="Home Dashboard"
            className="w-full py-2.5 rounded-xl bg-[#161822] hover:bg-[#1E2130] active:scale-95 text-slate-300 hover:text-[#D4AF37] border border-[#1E202B] flex flex-col items-center justify-center transition-all cursor-pointer shadow-sm"
          >
            <Home className="w-4 h-4 text-[#D4AF37] group-hover:scale-110 transition-transform" />
            <span className="text-[10px] font-medium text-slate-300 mt-1">Home</span>
          </button>
          {/* Tooltip */}
          <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2.5 py-1 bg-[#1A1C28] text-white text-xs rounded-md shadow-xl border border-[#2B2F42] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
            Return to Projects Dashboard (H)
          </div>
        </div>

        <div className="w-8 h-[1px] bg-[#1E202B] my-0.5" />

        {/* Editor Modes */}
        <nav className="flex flex-col items-center gap-1.5 w-full px-2">
          {modes.map((item) => {
            const isActive = currentMode === item.id;
            return (
              <div key={item.id} className="relative group w-full">
                <button
                  onClick={() => onSelectMode(item.id)}
                  aria-label={item.label}
                  aria-pressed={isActive}
                  className={`w-full py-2.5 px-1 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer relative active:scale-95 ${
                    isActive
                      ? 'bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/50 shadow-sm font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-[#161824]'
                  }`}
                >
                  {isActive && (
                    <div className="absolute left-0 top-2 bottom-2 w-1 bg-[#D4AF37] rounded-r-full" />
                  )}
                  <div>{item.icon}</div>
                  <span className="text-[10px] tracking-tight text-center leading-none">
                    {item.label}
                  </span>
                </button>

                {/* Rich Tooltip */}
                <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2.5 py-1.5 bg-[#1A1C28] text-slate-100 text-xs rounded-md shadow-xl border border-[#2B2F42] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <span>{item.label}</span>
                    <span className="text-[10px] font-mono text-[#D4AF37] bg-[#D4AF37]/10 px-1 rounded border border-[#D4AF37]/30">
                      [{item.shortcut}]
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400">{item.description}</div>
                </div>
              </div>
            );
          })}
        </nav>
      </div>

      {/* Bottom: Settings & Wallpaper Button (Exclusive, single home for settings) */}
      <div className="w-full px-2">
        <div
          data-tour="settings"
          data-inspect="settings-btn"
          className="relative group w-full pt-1.5 border-t border-[#1E202B]"
        >
          <button
            onClick={onOpenSettings}
            aria-label="Settings & Wallpaper"
            className="w-full py-2.5 px-1 rounded-xl bg-[#161822] hover:bg-[#1E2130] active:scale-95 text-slate-300 hover:text-[#D4AF37] border border-[#1E202B] flex flex-col items-center justify-center gap-1 transition-all cursor-pointer shadow-sm group"
          >
            <Settings className="w-4 h-4 text-slate-400 group-hover:text-[#D4AF37] group-hover:rotate-90 transition-transform duration-300" />
            <span className="text-[10px] tracking-tight text-center leading-none text-slate-300 group-hover:text-white">
              Settings
            </span>
          </button>

          {/* Tooltip */}
          <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2.5 py-1.5 bg-[#1A1C28] text-slate-100 text-xs rounded-md shadow-xl border border-[#2B2F42] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
            <div className="font-semibold text-white flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#D4AF37]" />
              <span>Settings & Theme</span>
            </div>
            <div className="text-[10px] text-slate-400">
              Font switcher, PiP facecam, timeline mode & wallpaper
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
