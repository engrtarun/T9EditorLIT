import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const shortcuts = [
    { key: 'Space', desc: 'Play / Pause video' },
    { key: 'J', desc: 'Rewind 10 seconds' },
    { key: 'L', desc: 'Forward 10 seconds' },
    { key: 'K', desc: 'Pause / Resume toggle' },
    { key: 'C', desc: 'Mark current transcript line as CUT' },
    { key: 'V or Enter', desc: 'Mark current transcript line as KEPT' },
    { key: '↑ / ↓', desc: 'Navigate to previous / next transcript line' },
    { key: 'M', desc: 'Mute / Unmute audio' },
    { key: 'Shift + C', desc: 'Auto-cut all detected stumbles & silences' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-[#14161F] border border-[#1E202B] rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1E202B]">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-[#D4AF37]" />
            <h3 className="text-sm font-semibold text-slate-100">Editor Keyboard Shortcuts</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close shortcuts dialog"
            className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-[#1E202B] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-2 text-xs font-mono">
          {shortcuts.map((sc, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-1.5 border-b border-[#1A1C28] last:border-none"
            >
              <span className="text-slate-400">{sc.desc}</span>
              <kbd className="px-2 py-0.5 rounded bg-[#161822] text-[#D4AF37] border border-[#1E202B] text-[11px] font-semibold">
                {sc.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="p-3 bg-[#0E1017] border-t border-[#1E202B] text-center text-[11px] font-mono text-slate-500">
          Tip: Quickly fly through tutorials with <span className="text-[#D4AF37]">J</span>, <span className="text-[#D4AF37]">L</span>, and <span className="text-red-400">C</span>.
        </div>
      </div>
    </div>
  );
};
