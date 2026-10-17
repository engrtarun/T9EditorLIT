import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Check,
  Scissors,
  Type,
  Film,
  Camera,
  Compass,
  Settings,
  Download,
  Lightbulb,
} from 'lucide-react';

interface TourStep {
  selector: string;
  title: string;
  tagline: string;
  desc: string;
  tip: string;
  icon: React.ReactNode;
  positionPreference?: 'top' | 'bottom' | 'left' | 'right';
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="player"]',
    title: '1. 16:9 Code Tutorial Player & IDE',
    tagline: 'Code Syntax Highlighting Synced with Speech',
    desc: 'Watch your tutorial with live syntax-highlighted code, file tabs, and terminal output that synchronize with the instructor\'s voice.',
    tip: 'Press Spacebar to play/pause, or drag the scrubber needle.',
    icon: <Film className="w-5 h-5 text-[#D4AF37]" />,
    positionPreference: 'bottom',
  },
  {
    selector: '[data-tour="cam"]',
    title: '2. CAM 01 Presenter Facecam (PiP)',
    tagline: 'Multi-Cam Angle & Instructor Camera',
    desc: 'Why CAM 01? Tutorial viewers retain 42% more info when they see human facial cues. Click the CAM 01 badge anytime to switch between Facecam, Overhead Keyboard, Screen Only, or change PiP size.',
    tip: 'Click CAM 01 badge to open the camera switcher menu.',
    icon: <Camera className="w-5 h-5 text-emerald-400" />,
    positionPreference: 'left',
  },
  {
    selector: '[data-tour="split"]',
    title: '3. Manual Split Scissors Tool (Kainchi)',
    tagline: 'Precision NLE Timeline Slicing',
    desc: 'Want to slice a clip manually? Position the playhead anywhere and click Split (or simply press "S"). Select the split section and tap Delete to remove awkward fumbles.',
    tip: 'Hotkey: Press S to split clip instantly · Press Delete to remove.',
    icon: <Scissors className="w-5 h-5 text-[#D4AF37]" />,
    positionPreference: 'top',
  },
  {
    selector: '[data-tour="timeline"]',
    title: '4. NLE Time Ruler & Audio Waveforms',
    tagline: 'Visual Audio Spikes & Spatial Navigation',
    desc: 'The timeline ruler displays elapsed time, audio amplitude waveforms, and split clips. Click anywhere to scrub the playhead with millisecond precision.',
    tip: 'Look for flat waveform gaps to visually spot dead pauses before hearing them.',
    icon: <Sparkles className="w-5 h-5 text-cyan-400" />,
    positionPreference: 'top',
  },
  {
    selector: '[data-tour="transcript"]',
    title: '5. Fast Transcript Cutting (Keep / Cut)',
    tagline: 'Edit Video By Editing Words',
    desc: 'Instead of tedious waveform trimming, read the spoken sentences here. Click the green checkmark to keep, or red cross to cut. Auto-skip will jump over cuts during playback!',
    tip: 'Press C to cut active sentence · Press V to keep · Auto-skip jumps over cuts.',
    icon: <Check className="w-5 h-5 text-emerald-400" />,
    positionPreference: 'left',
  },
  {
    selector: '[data-tour="auto-cut"]',
    title: '6. Auto-Cut Flubs & Dead Silences',
    tagline: '1-Click Silence Elimination',
    desc: 'Click this button to instantly detect and excise all stutters, repeated retakes, and dead pauses longer than 1.2s across the entire project.',
    tip: 'Saves 45 minutes of manual razor cutting per video. Hotkey: Shift + C.',
    icon: <Scissors className="w-5 h-5 text-amber-400" />,
    positionPreference: 'bottom',
  },
  {
    selector: '[data-tour="sidebar"]',
    title: '7. Multi-Mode Tool Sidebar',
    tagline: 'Focused Tools for Every Editing Phase',
    desc: 'Switch between Cut & Script (1), Coder Army & Apna College Titles (2), Audio & Music (3), Elements & Stickers (4), and My Media Library.',
    tip: 'Use number keys 1 through 5 on your keyboard to switch modes fast.',
    icon: <Type className="w-5 h-5 text-[#FFE600]" />,
    positionPreference: 'right',
  },
  {
    selector: '[data-tour="settings"]',
    title: '8. Settings, Font Changer & Wallpaper',
    tagline: 'Ergonomic Workspace Customization',
    desc: 'Located in the sidebar. Change UI typography to JetBrains Mono, Inter, or Plus Jakarta Sans, select Nanami starry night wallpapers, and adjust timeline layout modes.',
    tip: 'Personalize your font and theme for comfortable long-session editing.',
    icon: <Settings className="w-5 h-5 text-slate-300" />,
    positionPreference: 'right',
  },
  {
    selector: '[data-tour="inspect"]',
    title: '9. Inspect View (UX & Psychology Rules)',
    tagline: 'Learn Why Every Element Is Designed This Way',
    desc: 'Turn on Inspect Mode to hover over ANY button and see its cognitive psychology rule (Fitts\'s Law, Hick\'s Law, Jakob\'s Law) and Reddit community demand.',
    tip: 'Click Inspect in header or press Shift + I anytime!',
    icon: <Compass className="w-5 h-5 text-cyan-400" />,
    positionPreference: 'bottom',
  },
  {
    selector: '[data-tour="export"]',
    title: '10. Lossless 4K, Audio Rip & Telegram Cloud',
    tagline: 'Multi-Format Render Studio',
    desc: 'Export 4K/1080p MP4, MKV, MOV, isolated Audio MP3/WAV/FLAC for Spotify/podcasts, YouTube description chapters, or send directly to Telegram.',
    tip: 'Select "Audio Only" to export just the speech track without video!',
    icon: <Download className="w-5 h-5 text-[#D4AF37]" />,
    positionPreference: 'bottom',
  },
];

interface TourGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TourGuide: React.FC<TourGuideProps> = ({ isOpen, onClose }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const step = TOUR_STEPS[currentStep];

  // Find target element and compute bounding rect
  useEffect(() => {
    if (!isOpen) return;

    const updateRect = () => {
      const el = document.querySelector(step.selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const rect = el.getBoundingClientRect();
        setTargetRect(rect);
      } else {
        setTargetRect(null);
      }
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, [isOpen, currentStep, step.selector]);

  if (!isOpen) return null;

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onClose();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  // Calculate card positioning relative to target
  let cardStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 60,
  };

  if (targetRect) {
    const pad = 16;
    const cardWidth = 380;
    const cardHeight = 260;

    // Default positioning based on preference or available viewport space
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const spaceAbove = targetRect.top;
    const spaceRight = window.innerWidth - targetRect.right;
    const spaceLeft = targetRect.left;

    let posX = targetRect.left;
    let posY = targetRect.bottom + pad;

    if (step.positionPreference === 'right' && spaceRight > cardWidth + pad) {
      posX = targetRect.right + pad;
      posY = Math.max(20, Math.min(window.innerHeight - cardHeight - 20, targetRect.top));
    } else if (step.positionPreference === 'left' && spaceLeft > cardWidth + pad) {
      posX = targetRect.left - cardWidth - pad;
      posY = Math.max(20, Math.min(window.innerHeight - cardHeight - 20, targetRect.top));
    } else if (step.positionPreference === 'top' && spaceAbove > cardHeight + pad) {
      posX = Math.max(20, Math.min(window.innerWidth - cardWidth - 20, targetRect.left));
      posY = targetRect.top - cardHeight - pad;
    } else if (spaceBelow > cardHeight + pad) {
      posX = Math.max(20, Math.min(window.innerWidth - cardWidth - 20, targetRect.left));
      posY = targetRect.bottom + pad;
    } else {
      // Centered fallback
      posX = (window.innerWidth - cardWidth) / 2;
      posY = (window.innerHeight - cardHeight) / 2;
    }

    // Clamp inside viewport
    posX = Math.max(16, Math.min(window.innerWidth - cardWidth - 16, posX));
    posY = Math.max(16, Math.min(window.innerHeight - cardHeight - 16, posY));

    cardStyle = {
      position: 'fixed',
      left: `${posX}px`,
      top: `${posY}px`,
      width: `${cardWidth}px`,
      zIndex: 60,
    };
  } else {
    // Center modal if target element not currently visible
    cardStyle = {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: '400px',
      zIndex: 60,
    };
  }

  return (
    <>
      {/* Dark overlay backdrop with click-through hole for target element */}
      <div
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs transition-opacity duration-300"
        onClick={onClose}
      />

      {/* Spotlight Ring around target element */}
      {targetRect && (
        <div
          style={{
            position: 'fixed',
            left: `${targetRect.left - 4}px`,
            top: `${targetRect.top - 4}px`,
            width: `${targetRect.width + 8}px`,
            height: `${targetRect.height + 8}px`,
            zIndex: 55,
            pointerEvents: 'none',
          }}
          className="rounded-xl border-2 border-[#D4AF37] shadow-[0_0_25px_rgba(212,175,55,0.85)] animate-pulse"
        >
          <div className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-[#D4AF37] text-[#12131A] font-bold text-xs flex items-center justify-center shadow-lg">
            {currentStep + 1}
          </div>
        </div>
      )}

      {/* Floating Tour Guide Popover Card */}
      <div
        style={cardStyle}
        className="bg-[#141624] border border-[#D4AF37]/60 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100 animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#23273D] bg-[#0E1017]">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40">
              STEP {currentStep + 1} OF {TOUR_STEPS.length}
            </span>
            <span className="text-xs text-slate-400 font-mono">Interactive Spotlight</span>
          </div>

          <button
            onClick={onClose}
            aria-label="Close tour"
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#1A1D2E] border border-[#2B304D] flex items-center justify-center shrink-0 shadow-md">
              {step.icon}
            </div>
            <div>
              <h3 className="text-sm font-bold text-white leading-tight">{step.title}</h3>
              <p className="text-[11px] text-[#D4AF37] font-medium mt-0.5">{step.tagline}</p>
            </div>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed bg-[#0F111D] p-3 rounded-xl border border-[#1E2135]">
            {step.desc}
          </p>

          <div className="flex items-center gap-1.5 p-2 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/30 text-[11px] font-mono text-[#D4AF37]">
            <Lightbulb className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
            <span className="truncate">{step.tip}</span>
          </div>
        </div>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#23273D] bg-[#0E1017] text-xs">
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors cursor-pointer font-mono text-[11px]"
          >
            Skip Tour
          </button>

          <div className="flex items-center gap-2">
            {currentStep > 0 && (
              <button
                onClick={handlePrev}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1A1D2E] hover:bg-[#252A42] text-slate-200 transition-colors cursor-pointer text-xs"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              onClick={handleNext}
              className="flex items-center gap-1 px-3.5 py-1 rounded-lg bg-[#D4AF37] hover:bg-[#e5c358] text-[#12131A] font-bold transition-all cursor-pointer shadow-md text-xs"
            >
              <span>{currentStep === TOUR_STEPS.length - 1 ? 'Start Cutting!' : 'Next'}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
