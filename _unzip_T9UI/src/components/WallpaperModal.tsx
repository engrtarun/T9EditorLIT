import React, { useState } from 'react';
import { X, Image, Sparkles, Sliders, Upload, Check } from 'lucide-react';
import { WallpaperConfig } from './WallpaperBackground';

interface WallpaperModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: WallpaperConfig;
  onChangeConfig: (newConfig: WallpaperConfig) => void;
}

export const WALLPAPER_PRESETS: {
  id: string;
  name: string;
  desc: string;
  type: 'canvas' | 'css' | 'image';
  preview: string;
}[] = [
  {
    id: 'nanami-starry',
    name: 'Nanami Starry Sky (Default)',
    desc: 'Deep cosmic night sky, stars, nebulae and 7:3 anime horizon',
    type: 'canvas',
    preview: 'from-blue-950 via-indigo-950 to-black',
  },
  {
    id: 'nanami-gold-mesh',
    name: 'Nanami 7:3 Gold Grid',
    desc: 'Deep charcoal background with gold dot mesh & ratio guidelines',
    type: 'css',
    preview: 'from-[#12131A] via-[#1a1710] to-[#12131A]',
  },
  {
    id: 'deep-charcoal',
    name: 'Studio Deep Charcoal',
    desc: 'Minimalist clean distraction-free dark theme (#12131A)',
    type: 'css',
    preview: 'from-[#12131A] to-[#12131A]',
  },
  {
    id: 'shibuya-cyber',
    name: 'Shibuya Midnight',
    desc: 'Dark blue & purple gradient with subtle neon depth',
    type: 'css',
    preview: 'from-slate-950 via-slate-900 to-indigo-950',
  },
];

export const WallpaperModal: React.FC<WallpaperModalProps> = ({
  isOpen,
  onClose,
  config,
  onChangeConfig,
}) => {
  const [customUrl, setCustomUrl] = useState('');

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onChangeConfig({
            ...config,
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

  const handleApplyUrl = () => {
    if (customUrl.trim()) {
      onChangeConfig({
        ...config,
        id: 'custom-url',
        name: 'Custom Wallpaper',
        type: 'image',
        url: customUrl.trim(),
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-[#14161F] border border-[#1E202B] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1E202B]">
          <div className="flex items-center gap-2">
            <Image className="w-4 h-4 text-[#D4AF37]" />
            <h3 className="text-sm font-semibold text-slate-100">Editor Wallpaper & Background</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close wallpaper settings"
            className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-[#1E202B] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* Preset Wallpapers */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block mb-2.5">
              Select Preset Wallpaper
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              {WALLPAPER_PRESETS.map((preset) => {
                const isSelected = config.id === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() =>
                      onChangeConfig({
                        ...config,
                        id: preset.id,
                        name: preset.name,
                        type: preset.type,
                        url: undefined,
                      })
                    }
                    className={`p-3 rounded-lg border text-left flex flex-col justify-between transition-all cursor-pointer relative overflow-hidden group ${
                      isSelected
                        ? 'border-[#D4AF37] bg-[#D4AF37]/10 shadow-[0_0_12px_rgba(212,175,55,0.2)]'
                        : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full mb-2">
                      <div className={`w-full h-8 rounded bg-gradient-to-r ${preset.preview} border border-white/5`} />
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[#D4AF37] text-[#12131A] flex items-center justify-center">
                          <Check className="w-3 h-3 stroke-[3]" />
                        </div>
                      )}
                    </div>
                    <span className="text-xs font-semibold text-slate-200 group-hover:text-[#D4AF37] transition-colors">
                      {preset.name}
                    </span>
                    <span className="text-[10px] text-slate-500 line-clamp-1 mt-0.5">{preset.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Upload or Image URL */}
          <div className="pt-2 border-t border-[#1E202B]">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block mb-2">
              Custom Wallpaper Image
            </label>
            <div className="flex items-center gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#161822] hover:bg-[#1E202B] border border-dashed border-[#282B3B] text-slate-300 hover:text-slate-100 text-xs font-mono transition-colors cursor-pointer">
                <Upload className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>Upload Custom Image</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Sliders for Opacity and Blur */}
          <div className="pt-2 border-t border-[#1E202B] space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400">Wallpaper Opacity:</span>
              <span className="text-[#D4AF37] font-semibold">{Math.round(config.opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={config.opacity}
              onChange={(e) =>
                onChangeConfig({ ...config, opacity: parseFloat(e.target.value) })
              }
              aria-label="Wallpaper Opacity Slider"
              className="w-full accent-[#D4AF37] cursor-pointer"
            />

            <div className="flex items-center justify-between text-xs font-mono pt-1">
              <span className="text-slate-400">Backdrop Blur:</span>
              <span className="text-[#D4AF37] font-semibold">{config.blur}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="24"
              step="2"
              value={config.blur}
              onChange={(e) =>
                onChangeConfig({ ...config, blur: parseInt(e.target.value, 10) })
              }
              aria-label="Backdrop Blur Slider"
              className="w-full accent-[#D4AF37] cursor-pointer"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[#1E202B] bg-[#12131A] text-xs font-mono">
          <span className="text-slate-500">Active: {config.name}</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-[#D4AF37] hover:bg-[#e5c358] text-[#12131A] font-semibold transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
