import React, { useState } from 'react';
import {
  Shapes,
  Terminal,
  Bug,
  Flame,
  ArrowUpRight,
  Box,
  Activity,
  Code2,
  FileCode,
  Sparkles,
} from 'lucide-react';

export const ElementsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'all' | 'stickers' | 'shapes' | 'code'>('all');

  const elements = [
    {
      name: 'Terminal Callout',
      type: 'code',
      icon: <Terminal className="w-6 h-6 text-cyan-400" />,
      desc: 'Floating bash/zsh window overlay',
      badge: 'BASH',
    },
    {
      name: 'Bug Alert Stamp',
      type: 'stickers',
      icon: <Bug className="w-6 h-6 text-red-400" />,
      desc: 'Red alert banner for syntax gotchas',
      badge: 'FIX',
    },
    {
      name: 'Clean Code Badge',
      type: 'stickers',
      icon: <Flame className="w-6 h-6 text-amber-400" />,
      desc: 'Highlight performant O(1) implementations',
      badge: 'HOT',
    },
    {
      name: 'Attention Pointer',
      type: 'shapes',
      icon: <ArrowUpRight className="w-6 h-6 text-[#D4AF37]" />,
      desc: 'Gold directional pointer to cursor line',
      badge: 'FOCUS',
    },
    {
      name: 'Spotlight Focus Box',
      type: 'shapes',
      icon: <Box className="w-6 h-6 text-emerald-400" />,
      desc: 'Dim non-active lines and focus logic block',
      badge: 'BOX',
    },
    {
      name: 'Audio Visualizer Wave',
      type: 'shapes',
      icon: <Activity className="w-6 h-6 text-purple-400" />,
      desc: 'Reactive sound wave for speech emphasis',
      badge: 'AUDIO',
    },
  ];

  const filtered = activeTab === 'all' ? elements : elements.filter((e) => e.type === activeTab);

  return (
    <div className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#1E202B] shrink-0 bg-[#14161F] space-y-1">
        <div className="flex items-center gap-2">
          <Shapes className="w-4 h-4 text-[#D4AF37]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
            Tutorial Elements & Overlays
          </h2>
        </div>
        <p className="text-[11px] text-slate-500 font-mono">
          Code callouts, syntax focus boxes, bug badges & directional pointers
        </p>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 p-3 border-b border-[#1E202B] text-xs font-mono overflow-x-auto">
        {(['all', 'code', 'shapes', 'stickers'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1 rounded-full text-[11px] capitalize transition-colors cursor-pointer ${
              activeTab === tab
                ? 'bg-[#D4AF37] text-[#12131A] font-bold'
                : 'bg-[#161822] text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Elements Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3">
          {filtered.map((item, idx) => (
            <div
              key={idx}
              className="p-3.5 rounded-xl bg-[#161822] border border-[#1E202B] hover:border-[#D4AF37]/50 hover:bg-[#1A1C29] transition-all cursor-pointer group flex flex-col items-center text-center justify-between min-h-[115px]"
            >
              <div className="my-2 p-2 rounded-lg bg-[#0E1017] border border-white/5 group-hover:scale-110 group-hover:border-[#D4AF37]/40 transition-all">
                {item.icon}
              </div>
              <div className="w-full">
                <div className="flex items-center justify-center gap-1.5">
                  <h4 className="text-xs font-semibold text-slate-200 group-hover:text-[#D4AF37]">
                    {item.name}
                  </h4>
                </div>
                <p className="text-[9px] text-slate-500 line-clamp-1 mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
