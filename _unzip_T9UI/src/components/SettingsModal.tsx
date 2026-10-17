import React, { useState } from 'react';
import {
  X,
  Type,
  Palette,
  Image,
  Sliders,
  Volume2,
  Check,
  Upload,
  Sparkles,
  Zap,
} from 'lucide-react';
import { WallpaperConfig } from './WallpaperBackground';
import { WALLPAPER_PRESETS } from './WallpaperModal';

export interface EditorSettings {
  fontFamily: 'Inter' | 'Plus Jakarta Sans' | 'Outfit' | 'JetBrains Mono' | 'Fira Code';
  uiScale: 'compact' | 'normal' | 'spacious';
  accentColor: 'gold' | 'cyan' | 'emerald' | 'purple' | 'red';
  timelineMode: 'clipchamp' | 'pro-nle' | 'storyboard';
  enablePip: boolean;
  timelineSnapping: boolean;
  rippleDelete: boolean;
  autoSave: boolean;
  audioDucking: boolean;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: EditorSettings;
  onChangeSettings: (newSettings: EditorSettings) => void;
  wallpaperConfig: WallpaperConfig;
  onChangeWallpaper: (newWallpaper: WallpaperConfig) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onChangeSettings,
  wallpaperConfig,
  onChangeWallpaper,
}) => {
  const [activeTab, setActiveTab] = useState<'appearance' | 'wallpaper' | 'editing'>('appearance');

  if (!isOpen) return null;

  const fontOptions = [
    { id: 'Inter', label: 'Inter (Default)', desc: 'Clean, neutral SaaS typography', familyClass: 'font-inter' },
    { id: 'JetBrains Mono', label: 'JetBrains Mono', desc: 'Developer monospace IDE typography', familyClass: 'font-jetbrains' },
    { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', desc: 'Modern geometric display', familyClass: 'font-jakarta' },
    { id: 'Fira Code', label: 'Fira Code', desc: 'Programmer code font with ligatures', familyClass: 'font-fira' },
    { id: 'Outfit', label: 'Outfit', desc: 'High-contrast tech editorial', familyClass: 'font-outfit' },
  ];

  const accentOptions = [
    { id: 'gold', label: 'Nanami Gold', color: '#D4AF37', border: 'border-[#D4AF37]' },
    { id: 'cyan', label: 'Cyber Cyan', color: '#06B6D4', border: 'border-cyan-400' },
    { id: 'emerald', label: 'Emerald Hacker', color: '#10B981', border: 'border-emerald-400' },
    { id: 'purple', label: 'Royal Violet', color: '#8B5CF6', border: 'border-purple-400' },
    { id: 'red', label: 'Tokyo Crimson', color: '#EF4444', border: 'border-red-400' },
  ];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onChangeWallpaper({
            ...wallpaperConfig,
            id: 'custom-upload',
            name: file.name,
            type: 'image',
            url: event.target.result as string,
          });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl bg-[#141624] border border-[#23273D] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1E202B] bg-[#12131A]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#D4AF37]" />
            <h3 className="text-sm font-bold text-slate-100">Editor Settings & Preferences</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-[#1E202B] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-2 px-6 py-2.5 bg-[#0E1017] border-b border-[#1E202B] text-xs font-mono">
          {(
            [
              { id: 'appearance', label: 'Fonts & Theme', icon: <Type className="w-3.5 h-3.5" /> },
              { id: 'wallpaper', label: 'Wallpaper Background', icon: <Image className="w-3.5 h-3.5" /> },
              { id: 'editing', label: 'Timeline & Audio', icon: <Sliders className="w-3.5 h-3.5" /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#161822]'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* TAB 1: FONTS & ACCENT COLOR */}
          {activeTab === 'appearance' && (
            <div className="space-y-6">
              {/* Font Switcher */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300 block">
                    UI & Code Typography
                  </label>
                  <span className="text-[10px] font-mono text-[#D4AF37]">
                    Active: {settings.fontFamily}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-2.5">
                  {fontOptions.map((f) => {
                    const isSelected = settings.fontFamily === f.id;
                    return (
                      <div
                        key={f.id}
                        onClick={() =>
                          onChangeSettings({ ...settings, fontFamily: f.id as any })
                        }
                        className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'border-[#D4AF37] bg-[#D4AF37]/15 shadow-md shadow-[#D4AF37]/10'
                            : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                        }`}
                      >
                        <div>
                          <div className={`text-xs font-semibold text-slate-100 ${f.familyClass}`}>
                            {f.label}
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{f.desc}</div>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-[#D4AF37]" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Accent Color Themes */}
              <div className="space-y-3 pt-3 border-t border-[#1E202B]">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300 block">
                  Accent Color Theme
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {accentOptions.map((accent) => {
                    const isSelected = settings.accentColor === accent.id;
                    return (
                      <button
                        key={accent.id}
                        onClick={() =>
                          onChangeSettings({ ...settings, accentColor: accent.id as any })
                        }
                        className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 transition-all cursor-pointer ${
                          isSelected
                            ? `${accent.border} bg-white/10 shadow-md`
                            : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                        }`}
                      >
                        <div
                          style={{ backgroundColor: accent.color }}
                          className="w-5 h-5 rounded-full shadow-sm"
                        />
                        <span className="text-[10px] text-slate-300 font-medium">
                          {accent.label.split(' ')[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* UI Density Scaling */}
              <div className="space-y-2 pt-3 border-t border-[#1E202B]">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300 block">
                  Interface Density
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['compact', 'normal', 'spacious'] as const).map((scale) => (
                    <button
                      key={scale}
                      onClick={() => onChangeSettings({ ...settings, uiScale: scale })}
                      className={`py-2 text-center rounded-lg text-xs font-medium capitalize transition-all cursor-pointer border ${
                        settings.uiScale === scale
                          ? 'border-[#D4AF37] bg-[#D4AF37] text-[#12131A] font-bold'
                          : 'border-[#1E202B] bg-[#161822] text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {scale}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: WALLPAPER BACKGROUND */}
          {activeTab === 'wallpaper' && (
            <div className="space-y-5">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-300 block">
                Choose Wallpaper Preset
              </label>
              <div className="grid grid-cols-2 gap-3">
                {WALLPAPER_PRESETS.map((preset) => {
                  const isSelected = wallpaperConfig.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() =>
                        onChangeWallpaper({
                          ...wallpaperConfig,
                          id: preset.id,
                          name: preset.name,
                          type: preset.type,
                          url: undefined,
                        })
                      }
                      className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                        isSelected
                          ? 'border-[#D4AF37] bg-[#D4AF37]/10 shadow-sm'
                          : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                      }`}
                    >
                      <div className={`w-full h-8 rounded bg-gradient-to-r ${preset.preview} mb-2 border border-white/5`} />
                      <div className="text-xs font-bold text-slate-100">{preset.name}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5 line-clamp-1">{preset.desc}</div>
                    </button>
                  );
                })}
              </div>

              {/* Upload Custom Image */}
              <div className="pt-2 border-t border-[#1E202B]">
                <label className="flex items-center justify-center gap-2 p-3 rounded-xl bg-[#161822] hover:bg-[#1E2130] border border-dashed border-[#2B2F44] text-slate-300 hover:text-white text-xs font-medium transition-colors cursor-pointer">
                  <Upload className="w-4 h-4 text-[#D4AF37]" />
                  <span>Upload Local Wallpaper Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Sliders */}
              <div className="space-y-3 pt-2 border-t border-[#1E202B]">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-300">Wallpaper Opacity:</span>
                  <span className="text-[#D4AF37] font-bold">{Math.round(wallpaperConfig.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={wallpaperConfig.opacity}
                  onChange={(e) =>
                    onChangeWallpaper({ ...wallpaperConfig, opacity: parseFloat(e.target.value) })
                  }
                  className="w-full accent-[#D4AF37] cursor-pointer"
                />

                <div className="flex items-center justify-between text-xs font-mono pt-1">
                  <span className="text-slate-300">Backdrop Blur:</span>
                  <span className="text-[#D4AF37] font-bold">{wallpaperConfig.blur}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="24"
                  step="2"
                  value={wallpaperConfig.blur}
                  onChange={(e) =>
                    onChangeWallpaper({ ...wallpaperConfig, blur: parseInt(e.target.value, 10) })
                  }
                  className="w-full accent-[#D4AF37] cursor-pointer"
                />
              </div>
            </div>
          )}

          {/* TAB 3: TIMELINE & EDITING PREFERENCES */}
          {activeTab === 'editing' && (
            <div className="space-y-4">
              {/* Timeline Layout Engine (User requested: multiple timeline modes) */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] space-y-2.5">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">
                    Timeline Architecture & Layout Engine
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Select your preferred timeline editing experience (switchable on the fly)
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  {[
                    {
                      id: 'clipchamp',
                      name: 'Clipchamp Multi-Track (Recommended)',
                      desc: 'Layered tracks (Video/B-Roll, Audio dB Waveform, Captions Sync, Facecam PiP) with track mute and lock controls',
                    },
                    {
                      id: 'pro-nle',
                      name: 'Pro NLE Dense (DaVinci / Premiere)',
                      desc: 'SMPTE frame timecode (00:00:00:00), stereo audio VU peak decibel meters, and precision razor slicing',
                    },
                    {
                      id: 'storyboard',
                      name: 'Speech Storyboard (Veed / Descript)',
                      desc: 'Direct sentence speech blocks plotted on timeline with instant Keep/Cut status pills and silence skipping',
                    },
                  ].map((tMode) => {
                    const isSelected = settings.timelineMode === tMode.id;
                    return (
                      <div
                        key={tMode.id}
                        onClick={() =>
                          onChangeSettings({ ...settings, timelineMode: tMode.id as any })
                        }
                        className={`p-2.5 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'border-[#D4AF37] bg-[#D4AF37]/15'
                            : 'border-[#1E202B] bg-[#12141F] hover:border-slate-700'
                        }`}
                      >
                        <div>
                          <div className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                            <span>{tMode.name}</span>
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{tMode.desc}</div>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-[#D4AF37] shrink-0 ml-2" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Presenter Facecam / PiP Toggle (User requested: "pip aaager kisi user ko nahi chaiye toh ?") */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">Presenter Camera (Facecam PiP)</h4>
                  <p className="text-[11px] text-slate-400">
                    Show webcam overlay in corner (turn off for 100% clean full-screen code recording)
                  </p>
                </div>
                <button
                  onClick={() =>
                    onChangeSettings({ ...settings, enablePip: !settings.enablePip })
                  }
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    settings.enablePip ? 'bg-[#D4AF37]' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-[#12131A] transform transition-transform ${
                      settings.enablePip ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Timeline Snapping */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">Magnetic Timeline Snapping</h4>
                  <p className="text-[11px] text-slate-400">Playhead automatically snaps to sentence and clip boundaries</p>
                </div>
                <button
                  onClick={() =>
                    onChangeSettings({ ...settings, timelineSnapping: !settings.timelineSnapping })
                  }
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    settings.timelineSnapping ? 'bg-[#D4AF37]' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-[#12131A] transform transition-transform ${
                      settings.timelineSnapping ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Ripple Delete */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">Ripple Delete Mode</h4>
                  <p className="text-[11px] text-slate-400">Closing gaps automatically when split clips are excised</p>
                </div>
                <button
                  onClick={() =>
                    onChangeSettings({ ...settings, rippleDelete: !settings.rippleDelete })
                  }
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    settings.rippleDelete ? 'bg-[#D4AF37]' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-[#12131A] transform transition-transform ${
                      settings.rippleDelete ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Audio Ducking */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">Intelligent Audio Ducking</h4>
                  <p className="text-[11px] text-slate-400">Lowers background music automatically while speaking</p>
                </div>
                <button
                  onClick={() =>
                    onChangeSettings({ ...settings, audioDucking: !settings.audioDucking })
                  }
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    settings.audioDucking ? 'bg-[#D4AF37]' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-[#12131A] transform transition-transform ${
                      settings.audioDucking ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Auto Save */}
              <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-100">Auto-Save Project State</h4>
                  <p className="text-[11px] text-slate-400">Stores cut decisions and timestamps in browser storage</p>
                </div>
                <button
                  onClick={() =>
                    onChangeSettings({ ...settings, autoSave: !settings.autoSave })
                  }
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    settings.autoSave ? 'bg-[#D4AF37]' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-[#12131A] transform transition-transform ${
                      settings.autoSave ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-[#1E202B] bg-[#12131A] text-xs font-mono">
          <span className="text-slate-400">Changes apply instantly</span>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-[#D4AF37] hover:bg-[#e5c358] text-[#12131A] font-bold transition-all cursor-pointer shadow-sm"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
