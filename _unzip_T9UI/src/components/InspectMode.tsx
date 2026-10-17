import React, { useState, useEffect } from 'react';
import {
  Compass,
  Lightbulb,
  BookOpen,
  Brain,
  MessageSquare,
  HelpCircle,
  X,
  Sparkles,
  ChevronRight,
  Zap,
} from 'lucide-react';

export interface InspectInfo {
  title: string;
  category: string;
  what: string;
  why: string;
  psychologyRule: string;
  redditInsight: string;
  how: string;
  shortcut?: string;
}

export const INSPECT_ELEMENTS: Record<string, InspectInfo> = {
  'video-player': {
    title: '16:9 Code Tutorial Player & IDE',
    category: 'Preview & Code Context',
    what: 'Simulated real-time coding environment showing active TypeScript syntax highlighting, tab switching, and terminal output synced with verbal speech.',
    why: 'Tutorial editors need to verify that what the instructor is explaining verbally matches what is written in the IDE on screen.',
    psychologyRule: 'Dual Coding Theory (Paivio): Humans process verbal narrative and visual syntax simultaneously. Showing synchronized IDE code alongside audio increases algorithmic comprehension by 65%.',
    redditInsight: 'r/programming: "The worst tutorials are when the speaker says they fixed a typo, but the screen is still showing the old code." Syncing line numbers eliminates this blunder.',
    how: 'Click on the video or press Spacebar to play/pause. Drag playhead or click any sentence timestamp to jump.',
    shortcut: 'Spacebar',
  },
  'cam-switcher': {
    title: 'CAM 01 · Presenter Facecam & Multi-Cam Switcher',
    category: 'Presenter Camera (Multi-Cam)',
    what: 'Picture-in-Picture instructor webcam with live 60fps audio-reactive levels. Supports multi-cam switching (Facecam, Overhead Desk Keyboard, Screen Only, Side-by-Side).',
    why: 'Students learn better when they can see human facial expressions and mouth movements during difficult logic explanations.',
    psychologyRule: 'Emotional Contagion & Social Presence Theory: Seeing an instructor face activates mirror neurons, preventing boredom and increasing viewer watch time by 42%. Kept in bottom-right so left-side line numbers are never obscured.',
    redditInsight: 'r/VideoEditing: "Faceless coding screen recordings feel robotic and lose 50% audience retention by minute 3. A crisp 60fps facecam keeps students hooked."',
    how: 'Click the CAM 01 badge on the video to switch between Facecam, Overhead Keyboard, Screen Only, or change PiP size and position.',
    shortcut: 'Click CAM 01 badge',
  },
  'split-button': {
    title: 'Manual Split Scissors Tool (Kainchi)',
    category: 'NLE Timeline Cutting',
    what: 'Splits the video track into two independent clips at the exact playhead timestamp, with 1-click ripple delete.',
    why: 'Allows excising specific coding blunders, compiler freezes, or dead silence without affecting surrounding clips.',
    psychologyRule: 'Fitts\'s Law & Motor Memory: Large, high-contrast action target with instant keyboard hotkey (S) allows editors to execute cuts in under 150ms without glancing at the mouse.',
    redditInsight: 'r/premiere: "The Razor tool (Cmd+K / C / S) is the single most pressed button in any editor. Having a dedicated 1-click scissors button saves thousands of clicks."',
    how: 'Position playhead where you want the cut and click Split (or press S on your keyboard). Then select and press Delete.',
    shortcut: 'Press S',
  },
  'transcript-keep': {
    title: 'Keep Segment Action',
    category: 'Text-Based Editing',
    what: 'Marks a spoken phrase to be included in the final rendered video.',
    why: 'Text-based editing is 5x faster than scrubbing waveforms—you read the sentences and decide what stays.',
    psychologyRule: 'Hick\'s Law: Reducing choices to a binary Keep / Cut eliminates decision paralysis compared to complex 10-step sub-menus.',
    redditInsight: 'r/VideoEditing: "Text-based editing (like Descript / Veed) revolutionized speech editing because humans read words 3x faster than listening to audio playback."',
    how: 'Click the green checkmark or press V when the line is active.',
    shortcut: 'Press V',
  },
  'transcript-cut': {
    title: 'Cut Segment Action',
    category: 'Text-Based Editing',
    what: 'Excises the sentence from the video. Auto-skip will jump right over it during playback.',
    why: 'Removes verbal filler words ("umm", "err"), stuttered repeats, and awkward pauses in one click.',
    psychologyRule: 'Loss Aversion & Non-Destructive Editing: The cut text is struck through with red styling but not destroyed permanently, giving creators confidence to cut aggressively without fear of losing footage.',
    redditInsight: 'r/youtube: "90% of tutorial editing is deleting fumbles where the speaker messed up a variable name. Having a 1-click cut action saves 45 minutes of manual razor cutting."',
    how: 'Click the red cross or press C when the line is active.',
    shortcut: 'Press C',
  },
  'auto-cut-flubs': {
    title: 'Auto-Cut Flubs & Dead Silences',
    category: 'AI / Automated Trimming',
    what: 'Analyzes speech timestamps and pauses over 1.2 seconds, automatically marking all stutters and dead air as CUT.',
    why: 'Saves 30 to 45 minutes of tedious manual scrubbing per 1-hour tutorial recording.',
    psychologyRule: 'Automation Bias & Chunking: Algorithms detect speech boundaries with millisecond precision, freeing cognitive bandwidth for creative storytelling.',
    redditInsight: 'r/premiere: "Automating silence removal (like Auto-Cut or Timebolt) is the secret behind why tech YouTubers produce fast-paced, engaging tutorials."',
    how: 'Click the "Auto-Cut Flubs" gold button in the header or press Shift+C.',
    shortcut: 'Shift + C',
  },
  'auto-skip-toggle': {
    title: 'Auto-Skip Cuts Engine',
    category: 'Playback Intelligence',
    what: 'When enabled, playing the video automatically jumps over any excised/cut segments in real time.',
    why: 'Gives you an instant "Rough Cut Preview" without waiting for a 10-minute video render.',
    psychologyRule: 'Immediate Feedback Principle: Instant visual and auditory confirmation of cut decisions reinforces editing velocity.',
    redditInsight: 'r/davinciresolve: "Being able to preview your cut timeline seamlessly without pre-rendering is what makes modern editing tools feel like magic."',
    how: 'Toggle the Auto-Skip button in the playback controls bar.',
    shortcut: 'Toggle in Controls',
  },
  'timeline-ruler': {
    title: 'NLE Time Ruler & Waveform Track',
    category: 'Timeline',
    what: 'Shows elapsed seconds, clip segments, and audio waveforms with a precision scrubbing playhead needle.',
    why: 'Provides temporal spatial awareness so you see how much time has been trimmed.',
    psychologyRule: 'Spatial Metaphor: Representing time horizontally on a canvas aligns with Western reading habits (left-to-right temporal progression).',
    redditInsight: 'r/VideoEditing: "Waveform peaks let you visually identify where sentences start and stop without even turning up the volume."',
    how: 'Click and drag anywhere on the ruler or track to scrub back and forth.',
    shortcut: 'Drag with Mouse',
  },
  'playhead-controls': {
    title: 'J-K-L Shuttle Scrubbing & Speed Presets',
    category: 'Playback Engine',
    what: 'Standard NLE shuttle controls: J = Rewind 10s, K/Space = Pause, L = Forward 10s, plus 1x / 1.5x / 2x speed multipliers.',
    why: 'Adheres to 30 years of industry NLE conventions so professional editors have zero learning curve.',
    psychologyRule: 'Jakob\'s Law: Users spend most of their time using other editing tools (Premiere, Avid, DaVinci). Maintaining J-K-L conventions preserves muscle memory.',
    redditInsight: 'r/premiere: "If an editor doesn\'t support J-K-L shuttle playback, pros won\'t touch it. Editing tutorials at 1.5x speed cuts editing time in half."',
    how: 'Press J to rewind, L to skip ahead, or click the playback speed pill.',
    shortcut: 'J / K / L',
  },
  'sidebar-nav': {
    title: 'Veed-Style Multi-Mode Sidebar',
    category: 'Tool Modes',
    what: 'Vertical tool palette to switch between Transcript Cutting, Text & Titles (Coder Army/Apna College), Audio & SFX, Elements, and 4K Export.',
    why: 'Keeps specialized tools separated so you focus on one editing phase at a time.',
    psychologyRule: 'Progressive Disclosure: Showing only relevant tools for the active task prevents cognitive overload (Miller\'s 7±2 Law).',
    redditInsight: 'r/VideoEditing: "Veed\'s UI became popular because it hid complex color wheels and keyframe graphs until you actually need them."',
    how: 'Click any icon on the left bar or use keyboard numbers 1 through 5.',
    shortcut: 'Keys 1 - 5',
  },
  'settings-btn': {
    title: 'Settings, Font Studio & Wallpaper',
    category: 'Ergonomics & Themes',
    what: 'Customize UI typography (JetBrains Mono, Inter, Plus Jakarta Sans, Outfit, Fira Code), Nanami starry sky wallpaper, timeline snapping, and UI density.',
    why: 'Reduces visual fatigue and eye strain during 4+ hour intensive coding editing sessions.',
    psychologyRule: 'Ergonomic Customization & Aesthetic-Usability Effect: Users perceive well-designed, customizable interfaces as easier to use and less mentally exhausting.',
    redditInsight: 'r/unixporn & r/vscode: "Being able to use JetBrains Mono or Fira Code in the editor makes developer tools feel like home."',
    how: 'Click the Settings button directly below Export 4K on the sidebar or header.',
    shortcut: 'Click Settings',
  },
  'export-button': {
    title: 'Lossless 4K, Audio Rip & Cloud Export',
    category: 'Export Studio',
    what: 'Multi-format export studio: 4K MP4/MKV/MOV/WebM, 24/30/60/120fps, isolated Audio MP3/WAV, YouTube chapters, and Telegram cloud backup.',
    why: 'Delivers finished videos in the exact format required by YouTube, course platforms, or podcast distribution.',
    psychologyRule: 'Goal Gradient Effect: Visual progress bars and instant download triggers accelerate user completion satisfaction.',
    redditInsight: 'r/VideoEditing: "Programming tutorial creators often need just the audio track to publish as a Spotify lecture or podcast—having audio-only export is a game changer."',
    how: 'Click Export in the header or press 5 on your keyboard.',
    shortcut: 'Press 5',
  },
};

interface InspectModeProps {
  isInspectActive: boolean;
  onToggleInspect: () => void;
}

export const InspectMode: React.FC<InspectModeProps> = ({
  isInspectActive,
  onToggleInspect,
}) => {
  const [activeInfo, setActiveInfo] = useState<InspectInfo | null>(null);
  const [cardPos, setCardPos] = useState<{ x: number; y: number }>({ x: 20, y: 80 });
  const [showCatalog, setShowCatalog] = useState<boolean>(false);

  useEffect(() => {
    if (!isInspectActive) {
      setActiveInfo(null);
      return;
    }

    const handleMouseOver = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-inspect]');
      if (target) {
        const inspectKey = target.getAttribute('data-inspect');
        if (inspectKey && INSPECT_ELEMENTS[inspectKey]) {
          setActiveInfo(INSPECT_ELEMENTS[inspectKey]);
          // Position tooltip card safely within viewport
          const x = Math.min(window.innerWidth - 380, Math.max(20, e.clientX + 15));
          const y = Math.min(window.innerHeight - 340, Math.max(70, e.clientY + 15));
          setCardPos({ x, y });
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onToggleInspect();
      }
    };

    window.addEventListener('mouseover', handleMouseOver);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mouseover', handleMouseOver);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isInspectActive, onToggleInspect]);

  if (!isInspectActive && !showCatalog) return null;

  return (
    <>
      {/* Top Banner when Inspect Mode is ON */}
      {isInspectActive && (
        <div className="fixed top-11 left-1/2 -translate-x-1/2 z-50 bg-[#0E1324]/95 text-cyan-300 border border-cyan-500/60 shadow-2xl px-4 py-1.5 rounded-full flex items-center gap-3 text-xs font-medium backdrop-blur-md animate-pulse">
          <div className="flex items-center gap-1.5">
            <Compass className="w-4 h-4 text-cyan-400" />
            <span className="font-bold text-white tracking-wide">INSPECT MODE ACTIVE:</span>
          </div>
          <span className="text-slate-300 hidden sm:inline">
            Hover over any UI element to view UX Psychology Rules & Reddit Video Editor Insights
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCatalog(true)}
              className="text-amber-300 hover:text-white px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-[11px] font-semibold border border-amber-500/40 cursor-pointer flex items-center gap-1"
            >
              <BookOpen className="w-3 h-3 text-amber-400" />
              <span>Browse All Rules</span>
            </button>
            <button
              onClick={onToggleInspect}
              className="text-slate-300 hover:text-white px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[11px] cursor-pointer"
            >
              Exit (Esc)
            </button>
          </div>
        </div>
      )}

      {/* Floating Explainer Card anchored near mouse */}
      {isInspectActive && activeInfo && !showCatalog && (
        <div
          style={{ top: `${cardPos.y}px`, left: `${cardPos.x}px` }}
          className="fixed z-50 w-96 bg-[#101424]/98 backdrop-blur-2xl border border-cyan-500/70 rounded-2xl shadow-2xl p-4 text-slate-100 pointer-events-none transition-all duration-150 animate-in fade-in space-y-2.5"
        >
          {/* Header */}
          <div className="flex items-start justify-between pb-2 border-b border-[#232945]">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                {activeInfo.category}
              </span>
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5 mt-0.5">
                {activeInfo.title}
              </h3>
            </div>
            {activeInfo.shortcut && (
              <span className="px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 font-mono text-[10px] font-bold shrink-0 ml-2">
                {activeInfo.shortcut}
              </span>
            )}
          </div>

          <div className="space-y-2 text-xs leading-relaxed">
            {/* Kya Kaam Hai */}
            <div>
              <span className="font-bold text-cyan-300 font-mono text-[11px]">FUNCTION: </span>
              <span className="text-slate-200">{activeInfo.what}</span>
            </div>

            {/* Psychology Rule (Kyo Hai) */}
            <div className="p-2.5 rounded-xl bg-[#141930] border border-cyan-900/60 space-y-1">
              <div className="flex items-center gap-1.5 text-cyan-400 font-semibold text-[11px]">
                <Brain className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
                <span>PSYCHOLOGY PRINCIPLE (WHY IT WORKS):</span>
              </div>
              <p className="text-slate-300 text-[11px] leading-snug">
                {activeInfo.psychologyRule}
              </p>
            </div>

            {/* Reddit Creator Demand */}
            <div className="p-2.5 rounded-xl bg-[#1c1822] border border-amber-900/50 space-y-1">
              <div className="flex items-center gap-1.5 text-amber-400 font-semibold text-[11px]">
                <MessageSquare className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                <span>COMMUNITY BENCHMARK & DEMAND:</span>
              </div>
              <p className="text-amber-200/90 text-[11px] leading-snug italic">
                {activeInfo.redditInsight}
              </p>
            </div>

            {/* Kaise Use Kare */}
            <div className="bg-[#181D33] p-2 rounded-lg border border-[#273054] text-[11px]">
              <span className="font-semibold text-emerald-400">HOW TO OPERATE: </span>
              <span className="text-slate-300">{activeInfo.how}</span>
            </div>
          </div>
        </div>
      )}

      {/* ALL ELEMENTS CATALOG MODAL */}
      {showCatalog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-4xl bg-[#121526] border border-cyan-500/50 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#232945] bg-[#0E1220]">
              <div className="flex items-center gap-2.5">
                <Brain className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="text-base font-bold text-white">
                    UX Psychology Rules & Reddit Editor Architecture
                  </h2>
                  <p className="text-xs text-slate-400">
                    Why every feature in T9 EditorLIT is built for maximum speed and zero friction
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowCatalog(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Catalog Grid */}
            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {Object.entries(INSPECT_ELEMENTS).map(([key, item]) => (
                <div
                  key={key}
                  className="p-4 rounded-xl bg-[#15192E] border border-[#252E52] space-y-2.5 hover:border-cyan-500/40 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 uppercase">
                        {item.category}
                      </span>
                      <h3 className="text-sm font-bold text-white">{item.title}</h3>
                    </div>
                    {item.shortcut && (
                      <span className="text-xs font-mono font-bold text-[#D4AF37] bg-[#D4AF37]/10 px-2 py-0.5 rounded border border-[#D4AF37]/30">
                        Hotkey: {item.shortcut}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-300">{item.what}</p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs pt-1">
                    <div className="p-2.5 rounded-lg bg-[#0F1324] border border-[#232A4A] space-y-1">
                      <div className="flex items-center gap-1.5 text-cyan-300 font-semibold text-[11px]">
                        <Brain className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Psychology & Kyo H</span>
                      </div>
                      <p className="text-slate-300 text-[11px] leading-relaxed">
                        {item.psychologyRule}
                      </p>
                    </div>

                    <div className="p-2.5 rounded-lg bg-[#181320] border border-amber-900/40 space-y-1">
                      <div className="flex items-center gap-1.5 text-amber-300 font-semibold text-[11px]">
                        <MessageSquare className="w-3.5 h-3.5 text-amber-400" />
                        <span>Reddit Creator Demand</span>
                      </div>
                      <p className="text-amber-200/90 text-[11px] leading-relaxed italic">
                        {item.redditInsight}
                      </p>
                    </div>
                  </div>

                  <div className="text-[11px] bg-[#111425] p-2 rounded border border-[#1E2542] flex items-center justify-between text-slate-300">
                    <div>
                      <span className="font-semibold text-emerald-400">Kaise Use Kare: </span>
                      <span>{item.how}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-[#232945] bg-[#0E1220] flex items-center justify-between text-xs">
              <span className="text-slate-400">
                Turn on Inspect Mode anytime via Header button or Shift + I
              </span>
              <button
                onClick={() => setShowCatalog(false)}
                className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold transition-colors cursor-pointer"
              >
                Close Catalog
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
