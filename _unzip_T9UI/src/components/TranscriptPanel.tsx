import React, { useState, useRef, useEffect } from 'react';
import {
  Check,
  X,
  Search,
  CheckCheck,
  Scissors,
  HelpCircle,
} from 'lucide-react';
import {
  TranscriptLine,
  CutStatus,
  formatTimestamp,
  CutStats,
} from '../utils/editor';

interface TranscriptPanelProps {
  lines: TranscriptLine[];
  currentTime: number;
  activeLineIndex: number;
  stats: CutStats;
  onSeek: (time: number) => void;
  onSetLineStatus: (id: string, status: CutStatus) => void;
  onToggleKeep: (id: string) => void;
  onToggleCut: (id: string) => void;
  onKeepAll: () => void;
  onCutFlubs: () => void;
}

function renderFormattedText(text: string, isCut: boolean) {
  if (!text.includes('`')) {
    return text;
  }

  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = part.slice(1, -1);
      return (
        <span
          key={index}
          className={`font-mono text-[11px] px-1 py-0.2 rounded border ${
            isCut
              ? 'bg-red-950/30 text-red-300 border-red-900/30'
              : 'bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/30'
          }`}
        >
          {code}
        </span>
      );
    }
    return part;
  });
}

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  lines,
  currentTime,
  activeLineIndex,
  stats,
  onSeek,
  onToggleKeep,
  onToggleCut,
  onKeepAll,
  onCutFlubs,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<
    'all' | 'unreviewed' | 'kept' | 'cut' | 'flubs'
  >('all');
  const [autoScroll, setAutoScroll] = useState(true);

  const activeRowRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && activeRowRef.current && listContainerRef.current) {
      const container = listContainerRef.current;
      const row = activeRowRef.current;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();

      if (
        rowRect.top < containerRect.top + 60 ||
        rowRect.bottom > containerRect.bottom - 60
      ) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [activeLineIndex, autoScroll]);

  const filteredLines = lines.filter((line) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchesText = line.text.toLowerCase().includes(q);
      const matchesTime = formatTimestamp(line.startTime).includes(q);
      if (!matchesText && !matchesTime) return false;
    }

    if (filterStatus === 'all') return true;
    if (filterStatus === 'unreviewed') return line.status === 'unreviewed';
    if (filterStatus === 'kept') return line.status === 'kept';
    if (filterStatus === 'cut') return line.status === 'cut';
    if (filterStatus === 'flubs') return line.isFlubOrSilence;
    return true;
  });

  return (
    <div
      id="tour-transcript"
      data-tour="transcript"
      data-inspect="transcript-keep"
      className="w-full h-full flex flex-col bg-[#12131A] select-none text-slate-200 overflow-hidden"
    >
      {/* Panel Top Header */}
      <div className="p-3.5 border-b border-[#1E202B] shrink-0 space-y-2.5 bg-[#14161F]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Transcript & Cuts
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              ({lines.length} lines)
            </span>
          </div>

          {/* Quick Batch Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onCutFlubs}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-800/40 text-red-300 transition-colors cursor-pointer whitespace-nowrap"
              title="Cut all verbal stumbles and silences (Shift+C)"
            >
              <Scissors className="w-3 h-3" />
              <span>Cut Flubs</span>
            </button>
            <button
              onClick={onKeepAll}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-[#161822] hover:bg-[#1E202B] border border-[#1E202B] text-slate-300 hover:text-slate-100 transition-colors cursor-pointer whitespace-nowrap"
              title="Mark all pending lines as kept"
            >
              <CheckCheck className="w-3 h-3 text-emerald-400" />
              <span>Keep All</span>
            </button>
          </div>
        </div>

        {/* Search & Follow Bar */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 transform -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search words or timestamp..."
              className="w-full bg-[#12131A] border border-[#1E202B] rounded-md text-xs pl-8 pr-2 py-1.5 text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-md border transition-colors cursor-pointer shrink-0 ${
              autoScroll
                ? 'bg-[#D4AF37]/15 text-[#D4AF37] border-[#D4AF37]/40'
                : 'bg-[#12131A] text-slate-500 border-[#1E202B]'
            }`}
            title="Auto-scroll with playback"
          >
            Follow
          </button>
        </div>

        {/* Filter Segmented Controls */}
        <div className="flex items-center gap-1 text-[11px] overflow-x-auto no-scrollbar pt-0.5">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'unreviewed', label: `Pending (${stats.unreviewedCount})` },
              { id: 'kept', label: `Kept (${stats.keptCount})` },
              { id: 'cut', label: `Cut (${stats.cutCount})` },
              { id: 'flubs', label: 'Flubs/Pauses' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterStatus(tab.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] whitespace-nowrap transition-colors cursor-pointer font-medium ${
                filterStatus === tab.id
                  ? 'bg-[#D4AF37] text-[#12131A] font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#1E202B]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable List of Transcript Lines */}
      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto divide-y divide-[#1A1C28] bg-[#12131A]"
      >
        {filteredLines.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs">
            No matching transcript lines found.
          </div>
        ) : (
          filteredLines.map((line) => {
            const isActive =
              currentTime >= line.startTime && currentTime < line.endTime;
            const isCut = line.status === 'cut';
            const isKept = line.status === 'kept';

            return (
              <div
                key={line.id}
                ref={isActive ? activeRowRef : null}
                className={`flex items-start justify-between gap-3 px-3.5 py-2.5 transition-colors group relative ${
                  isActive
                    ? 'bg-[#191C28] border-l-2 border-l-[#D4AF37]'
                    : isCut
                    ? 'bg-[#12131A]/60 opacity-60 hover:opacity-90'
                    : 'hover:bg-[#161824]'
                }`}
              >
                {/* Left: Clickable Timestamp */}
                <button
                  onClick={() => onSeek(line.startTime)}
                  aria-label={`Jump to ${formatTimestamp(line.startTime)}`}
                  className={`font-mono text-xs tabular-nums mt-0.5 shrink-0 px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                    isActive
                      ? 'text-[#D4AF37] font-semibold bg-[#D4AF37]/10'
                      : 'text-slate-400 hover:text-[#D4AF37] hover:bg-[#1E202B]'
                  }`}
                  title="Click to seek video"
                >
                  {formatTimestamp(line.startTime)}
                </button>

                {/* Middle: Transcript Text */}
                <div
                  onClick={() => onSeek(line.startTime)}
                  className="flex-1 min-w-0 cursor-pointer pt-0.5 select-text"
                >
                  <p
                    className={`text-xs leading-relaxed transition-all ${
                      isCut
                        ? 'text-slate-500 line-through'
                        : isActive
                        ? 'text-slate-100 font-medium'
                        : 'text-slate-300'
                    }`}
                  >
                    {renderFormattedText(line.text, isCut)}
                  </p>

                  {/* Metadata Tags */}
                  <div className="flex items-center gap-2 mt-1">
                    {line.isFlubOrSilence && (
                      <span className="text-[9px] font-mono text-red-400 bg-red-950/40 px-1.5 py-0.2 rounded border border-red-900/40">
                        {line.category === 'pause' ? 'Silence' : 'Stumble/Flub'}
                      </span>
                    )}
                    {line.category === 'coding' && (
                      <span className="text-[9px] font-mono text-[#D4AF37] bg-[#D4AF37]/10 px-1.5 py-0.2 rounded">
                        code
                      </span>
                    )}
                    {line.category === 'terminal' && (
                      <span className="text-[9px] font-mono text-slate-300 bg-slate-800/40 px-1.5 py-0.2 rounded">
                        terminal
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-slate-500">
                      {(line.endTime - line.startTime).toFixed(1)}s
                    </span>
                  </div>
                </div>

                {/* Far-Right: Keep and Cut buttons */}
                <div className="flex items-center gap-1 shrink-0 ml-2 pt-0.5">
                  {/* Keep Button */}
                  <div className="relative group/tooltip" data-inspect="transcript-keep">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleKeep(line.id);
                      }}
                      aria-label={`Keep segment at ${formatTimestamp(line.startTime)}`}
                      aria-pressed={isKept}
                      className={`p-1.5 rounded-lg transition-all cursor-pointer hover:scale-110 active:scale-90 ${
                        isKept
                          ? 'bg-emerald-500/25 text-emerald-400 border border-emerald-500/50 shadow-md shadow-emerald-500/20'
                          : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-950/30'
                      }`}
                    >
                      <Check className="w-4 h-4 stroke-[2.5]" />
                    </button>
                    <div className="absolute right-0 bottom-full mb-1 px-2 py-1 bg-[#1A1C28] text-white text-[10px] rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/tooltip:opacity-100 transition-opacity z-40 border border-[#2A2E40]">
                      Keep in final video (V)
                    </div>
                  </div>

                  {/* Cut Button */}
                  <div className="relative group/tooltip" data-inspect="transcript-cut">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCut(line.id);
                      }}
                      aria-label={`Cut segment at ${formatTimestamp(line.startTime)}`}
                      aria-pressed={isCut}
                      className={`p-1.5 rounded-lg transition-all cursor-pointer hover:scale-110 active:scale-90 ${
                        isCut
                          ? 'bg-red-500/25 text-red-400 border border-red-500/50 shadow-md shadow-red-500/20'
                          : 'text-slate-500 hover:text-red-400 hover:bg-red-950/30'
                      }`}
                    >
                      <X className="w-4 h-4 stroke-[2.5]" />
                    </button>
                    <div className="absolute right-0 bottom-full mb-1 px-2 py-1 bg-[#1A1C28] text-white text-[10px] rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/tooltip:opacity-100 transition-opacity z-40 border border-[#2A2E40]">
                      Cut from video (C)
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Bottom Summary Bar */}
      <div className="p-3 bg-[#14161F] border-t border-[#1E202B] shrink-0 text-xs font-mono space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-[#D4AF37] font-semibold">Kept Duration:</span>
            <span className="text-slate-200 font-bold tabular-nums">
              {formatTimestamp(stats.keptDuration)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-red-400 font-semibold">Cut Time:</span>
            <span className="text-slate-400 tabular-nums">
              {formatTimestamp(stats.cutDuration)}
            </span>
          </div>

          <div className="text-[11px] bg-[#D4AF37]/15 text-[#D4AF37] px-2 py-0.5 rounded border border-[#D4AF37]/30 font-semibold">
            Saved {stats.timeSavedPercentage}%
          </div>
        </div>

        {/* Efficiency Bar */}
        <div className="w-full h-1.5 bg-[#1E202B] rounded-full overflow-hidden flex">
          <div
            style={{
              width: `${
                stats.totalDuration > 0
                  ? (stats.keptDuration / stats.totalDuration) * 100
                  : 100
              }%`,
            }}
            className="bg-[#D4AF37] h-full transition-all duration-300"
            title="Kept content"
          />
          <div
            style={{
              width: `${
                stats.totalDuration > 0
                  ? (stats.cutDuration / stats.totalDuration) * 100
                  : 0
              }%`,
            }}
            className="bg-red-800/80 h-full transition-all duration-300"
            title="Cut content"
          />
        </div>
      </div>
    </div>
  );
};
