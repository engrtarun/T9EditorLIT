import React, { useState } from 'react';
import { Type, Sparkles, Check, Palette, Plus, Layout } from 'lucide-react';

interface TextCaptionsPanelProps {
  onAddHeading: (text: string, style: string) => void;
}

export const TextCaptionsPanel: React.FC<TextCaptionsPanelProps> = ({ onAddHeading }) => {
  const [customText, setCustomText] = useState('Step 1: Generic Constraints Explained');
  const [selectedStyle, setSelectedStyle] = useState('coder-army-bold');

  // Coder Army / Apna College / Tech Influencer Presets
  const titlePresets = [
    {
      id: 'coder-army-bold',
      name: 'Coder Army Bold Yellow',
      preview: 'bg-black text-[#FFE600] font-black tracking-wide border-2 border-[#FFE600] uppercase shadow-lg',
      category: 'Headings',
    },
    {
      id: 'apna-college-glow',
      name: 'Apna College Blue Neon',
      preview: 'bg-blue-950/80 text-cyan-300 font-bold border border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.4)]',
      category: 'Headings',
    },
    {
      id: 'nanami-gold-minimal',
      name: 'Nanami 7:3 Clean Gold',
      preview: 'bg-[#12131A] text-[#D4AF37] border border-[#D4AF37] font-mono font-semibold',
      category: 'Headings',
    },
    {
      id: 'terminal-badge',
      name: 'Terminal Command Tag',
      preview: 'bg-[#0B0C12] text-emerald-400 font-mono text-xs border border-emerald-500/40',
      category: 'Badges',
    },
    {
      id: 'leetcode-hard',
      name: 'LeetCode Hard Red',
      preview: 'bg-red-950/70 text-red-400 font-bold border border-red-500/50',
      category: 'Badges',
    },
    {
      id: 'minimal-lower-third',
      name: 'Studio Lower Third',
      preview: 'bg-slate-900/90 text-slate-100 border-l-4 border-l-[#D4AF37] text-left px-3',
      category: 'Lower Third',
    },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#1E202B] shrink-0 bg-[#14161F] space-y-1">
        <div className="flex items-center gap-2">
          <Type className="w-4 h-4 text-[#D4AF37]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
            Text & Tutorial Captions
          </h2>
        </div>
        <p className="text-[11px] text-slate-500 font-mono">
          Coder Army & Apna College style bold headings, lower thirds & code tags
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Custom Text Input */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 font-mono">
            Heading / Caption Text:
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              className="flex-1 bg-[#161822] border border-[#1E202B] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-[#D4AF37]"
              placeholder="Enter title text..."
            />
            <button
              onClick={() => onAddHeading(customText, selectedStyle)}
              className="px-3 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#e5c358] text-[#12131A] text-xs font-bold transition-colors cursor-pointer flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              <span>Apply</span>
            </button>
          </div>
        </div>

        {/* Coder Army / Popular Tutorial Presets (Veed Style Cards) */}
        <div className="space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block font-mono">
            Title & Banner Styles
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {titlePresets.map((preset) => {
              const isSelected = selectedStyle === preset.id;
              return (
                <div
                  key={preset.id}
                  onClick={() => {
                    setSelectedStyle(preset.id);
                    onAddHeading(customText, preset.id);
                  }}
                  className={`p-3.5 rounded-xl border flex flex-col justify-between gap-3 transition-all cursor-pointer group ${
                    isSelected
                      ? 'border-[#D4AF37] bg-[#D4AF37]/10 shadow-[0_0_12px_rgba(212,175,55,0.15)]'
                      : 'border-[#1E202B] bg-[#161822] hover:border-slate-700'
                  }`}
                >
                  <div
                    className={`p-3 rounded-lg text-center text-xs flex items-center justify-center min-h-[46px] ${preset.preview}`}
                  >
                    {customText.slice(0, 24)}...
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-slate-300 group-hover:text-[#D4AF37] transition-colors">
                      {preset.name}
                    </span>
                    <span className="text-[10px] text-slate-500">{preset.category}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Subtitle Animation Options */}
        <div className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-200 font-mono">
            Karaoke Auto-Highlight Captions
          </h3>
          <p className="text-[11px] text-slate-400">
            Highlight currently spoken words with Nanami Gold glow in real-time.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <span className="px-2 py-1 rounded bg-[#D4AF37] text-[#12131A] font-bold text-xs">
              ACTIVE
            </span>
            <span className="text-xs font-mono text-slate-400">Word-by-word synced to video</span>
          </div>
        </div>
      </div>
    </div>
  );
};
