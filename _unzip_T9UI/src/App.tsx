/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WindowHeader } from './components/WindowHeader';
import { VideoPlayer } from './components/VideoPlayer';
import { VeedTimeline, TimelineMode } from './components/VeedTimeline';
import { TranscriptPanel } from './components/TranscriptPanel';
import { TextCaptionsPanel } from './components/TextCaptionsPanel';
import { AudioPanel } from './components/AudioPanel';
import { ElementsPanel } from './components/ElementsPanel';
import { MyMediaPanel, MediaAsset } from './components/MyMediaPanel';
import { ExportPanel } from './components/ExportPanel';
import { ExportModal } from './components/ExportModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { DashboardView } from './components/DashboardView';
import { SidebarNav, EditorMode } from './components/SidebarNav';
import { WallpaperBackground, WallpaperConfig } from './components/WallpaperBackground';
import { WallpaperModal } from './components/WallpaperModal';
import { SettingsModal, EditorSettings } from './components/SettingsModal';
import { InspectMode } from './components/InspectMode';
import { TourGuide } from './components/TourGuide';
import { SAMPLE_TUTORIALS, TutorialProject } from './data/sampleTutorials';
import {
  calculateCutStats,
  findActiveLineIndex,
  findNextUnreviewedIndex,
  getNextKeptSegmentTime,
  splitClipAtTime,
  TranscriptLine,
  CutStatus,
  VideoTimelineClip,
} from './utils/editor';
import { X } from 'lucide-react';

export default function App() {
  // Navigation View: 'dashboard' (Home) or 'editor'
  const [view, setView] = useState<'dashboard' | 'editor'>('dashboard');

  // Multi-Mode Editor: 'media' | 'cut' | 'text' | 'audio' | 'elements'
  const [editorMode, setEditorMode] = useState<EditorMode>('cut');

  // Wallpaper / Background (Nanami Starry Sky by default)
  const [wallpaperConfig, setWallpaperConfig] = useState<WallpaperConfig>({
    id: 'nanami-starry',
    name: 'Nanami Starry Sky (Default)',
    type: 'canvas',
    opacity: 0.35,
    blur: 2,
  });

  // Editor Settings (Fonts, Timeline Mode, Facecam PiP, Snapping, Ripple Delete)
  const [settings, setSettings] = useState<EditorSettings>({
    fontFamily: 'Inter',
    uiScale: 'normal',
    accentColor: 'gold',
    timelineMode: 'clipchamp',
    enablePip: true,
    timelineSnapping: true,
    rippleDelete: true,
    autoSave: true,
    audioDucking: true,
  });

  // Projects list
  const [projects, setProjects] = useState<TutorialProject[]>(SAMPLE_TUTORIALS);
  const [currentProject, setCurrentProject] = useState<TutorialProject>(SAMPLE_TUTORIALS[0]);
  const [lines, setLines] = useState<TranscriptLine[]>(SAMPLE_TUTORIALS[0].lines);

  // Timeline Clips for Manual Split Scissors Tool
  const [clips, setClips] = useState<VideoTimelineClip[]>([
    { id: 'c1', startTime: 0, endTime: 146, isCut: false, label: '01. Intro & EventMap' },
    { id: 'c2', startTime: 146, endTime: 320, isCut: false, label: '02. Bus Implementation' },
    { id: 'c3', startTime: 320, endTime: SAMPLE_TUTORIALS[0].duration, isCut: false, label: '03. Vitest Verification' },
  ]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Video playback state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [autoSkipCuts, setAutoSkipCuts] = useState<boolean>(true);

  // Modals, Inspect Mode & Tour Guide
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);
  const [showWallpaperModal, setShowWallpaperModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showTourGuide, setShowTourGuide] = useState<boolean>(false);
  const [isInspectActive, setIsInspectActive] = useState<boolean>(false);

  // Active overlay heading banner
  const [activeHeading, setActiveHeading] = useState<{ text: string; style: string } | null>(null);

  // State refs for animation loop
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const autoSkipCutsRef = useRef(autoSkipCuts);
  autoSkipCutsRef.current = autoSkipCuts;

  const linesRef = useRef(lines);
  linesRef.current = lines;

  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  const duration = currentProject.duration;

  // Playback timer loop
  useEffect(() => {
    let lastTimestamp = performance.now();
    let animId: number;

    const tick = (now: number) => {
      const deltaSec = (now - lastTimestamp) / 1000;
      lastTimestamp = now;

      if (isPlayingRef.current) {
        let nextTime = currentTimeRef.current + deltaSec * playbackRateRef.current;

        // Auto-skip cuts check
        if (autoSkipCutsRef.current) {
          const skipTarget = getNextKeptSegmentTime(linesRef.current, nextTime);
          if (skipTarget !== null && skipTarget > nextTime) {
            nextTime = skipTarget;
          }
        }

        if (nextTime >= duration) {
          setIsPlaying(false);
          setCurrentTime(duration);
        } else {
          setCurrentTime(nextTime);
        }
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [duration]);

  // Derived current active line
  const activeLineIndex = findActiveLineIndex(lines, currentTime);
  const activeLine = activeLineIndex >= 0 ? lines[activeLineIndex] : null;

  // Selected clip object
  const selectedClip = clips.find((c) => c.id === selectedClipId) || null;

  // Cut Statistics
  const stats = calculateCutStats(lines, duration);
  const flubCount = lines.filter((l) => l.isFlubOrSilence && l.status !== 'cut').length;

  // Project Switching
  const handleSelectProject = (project: TutorialProject) => {
    setCurrentProject(project);
    setLines(project.lines);
    setCurrentTime(0);
    setIsPlaying(false);
    setSelectedClipId(null);
    setClips([
      { id: `${project.id}-c1`, startTime: 0, endTime: project.duration * 0.35, isCut: false, label: '01. Intro & Concepts' },
      { id: `${project.id}-c2`, startTime: project.duration * 0.35, endTime: project.duration * 0.75, isCut: false, label: '02. Live Code Implementation' },
      { id: `${project.id}-c3`, startTime: project.duration * 0.75, endTime: project.duration, isCut: false, label: '03. Test Verification' },
    ]);
  };

  const handleOpenProject = (project: TutorialProject) => {
    handleSelectProject(project);
    setView('editor');
  };

  const handleNewProject = () => {
    const newId = `project-${Date.now()}`;
    const newProject: TutorialProject = {
      id: newId,
      title: 'New Coding Tutorial Session',
      fileName: 'live-coding-session.mp4',
      duration: 300,
      resolution: '4K UHD',
      fps: 60,
      codeSnippets: {
        intro: {
          file: 'src/main.ts',
          activeLine: 1,
          code: '// High performance TypeScript architecture\nexport function bootstrap() {\n  console.log("Studio Ready");\n}',
          terminal: '$ bun run dev\nServer running at http://localhost:3000',
        },
      },
      lines: [
        {
          id: `${newId}-l1`,
          startTime: 0,
          endTime: 4.5,
          text: 'Welcome to this coding tutorial! Today we are building a high-throughput event queue.',
          status: 'unreviewed',
          category: 'explanation',
          isFlubOrSilence: false,
        },
        {
          id: `${newId}-l2`,
          startTime: 4.5,
          endTime: 8.0,
          text: 'Let us start by defining our generic payload interfaces.',
          status: 'unreviewed',
          category: 'coding',
          isFlubOrSilence: false,
        },
      ],
    };

    setProjects([newProject, ...projects]);
    handleOpenProject(newProject);
    setShowTourGuide(true);
  };

  const handleDeleteProject = (id: string) => {
    setProjects(projects.filter((p) => p.id !== id));
  };

  // Playback Handlers
  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      if (!prev && currentTimeRef.current >= duration) {
        setCurrentTime(0);
      }
      return !prev;
    });
  }, [duration]);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(Math.max(0, Math.min(time, duration)));
  }, [duration]);

  // MANUAL SPLIT SCISSORS HANDLER
  const handleSplitAtPlayhead = useCallback(() => {
    const { updatedClips, splitSuccessful, newClipId } = splitClipAtTime(
      clipsRef.current,
      currentTimeRef.current
    );
    if (splitSuccessful) {
      setClips(updatedClips);
      if (newClipId) {
        setSelectedClipId(newClipId);
      }
    }
  }, []);

  // DELETE SELECTED SPLIT CLIP
  const handleDeleteSelectedClip = useCallback(() => {
    if (!selectedClipId) return;
    setClips((prev) =>
      prev.map((c) => (c.id === selectedClipId ? { ...c, isCut: !c.isCut } : c))
    );
  }, [selectedClipId]);

  const handleToggleClipCut = useCallback((clipId: string) => {
    setClips((prev) =>
      prev.map((c) => (c.id === clipId ? { ...c, isCut: !c.isCut } : c))
    );
  }, []);

  // INSERT MEDIA AT PLAYHEAD (User requested: "my media ka option nahi h aager beach me koi video clip add karni ho toh ?")
  const handleInsertMediaAtPlayhead = useCallback((media: MediaAsset) => {
    const curTime = currentTimeRef.current;
    const insertDuration = media.duration;

    const currentClips = [...clipsRef.current];
    const newClips: VideoTimelineClip[] = [];
    let inserted = false;

    currentClips.forEach((clip) => {
      if (!inserted && curTime >= clip.startTime && curTime < clip.endTime) {
        const firstHalf: VideoTimelineClip = {
          ...clip,
          endTime: curTime,
        };
        const mediaClip: VideoTimelineClip = {
          id: `media-${Date.now()}`,
          startTime: curTime,
          endTime: curTime + insertDuration,
          isCut: false,
          label: `B-Roll: ${media.name}`,
        };
        const secondHalf: VideoTimelineClip = {
          id: `${clip.id}-cont`,
          startTime: curTime + insertDuration,
          endTime: clip.endTime + insertDuration,
          isCut: clip.isCut,
          label: `${clip.label || 'Clip'} (Cont.)`,
        };
        newClips.push(firstHalf, mediaClip, secondHalf);
        inserted = true;
      } else if (inserted) {
        newClips.push({
          ...clip,
          startTime: clip.startTime + insertDuration,
          endTime: clip.endTime + insertDuration,
        });
      } else {
        newClips.push(clip);
      }
    });

    if (!inserted) {
      const lastEndTime = newClips.length > 0 ? newClips[newClips.length - 1].endTime : 0;
      newClips.push({
        id: `media-${Date.now()}`,
        startTime: lastEndTime,
        endTime: lastEndTime + insertDuration,
        isCut: false,
        label: `B-Roll: ${media.name}`,
      });
    }

    setClips(newClips);

    const newDuration = duration + insertDuration;
    setCurrentProject((prev) => ({
      ...prev,
      duration: newDuration,
    }));

    // Add synced transcript line
    const newLine: TranscriptLine = {
      id: `line-broll-${Date.now()}`,
      startTime: curTime,
      endTime: curTime + insertDuration,
      text: `[B-Roll / Cutaway: ${media.name}]`,
      status: 'kept',
      category: 'coding',
      isFlubOrSilence: false,
    };
    setLines((prev) => {
      const updated = prev.map((l) => {
        if (l.startTime >= curTime) {
          return {
            ...l,
            startTime: l.startTime + insertDuration,
            endTime: l.endTime + insertDuration,
          };
        }
        return l;
      });
      return [...updated, newLine].sort((a, b) => a.startTime - b.startTime);
    });
  }, [duration]);

  const handleAppendMedia = useCallback((media: MediaAsset) => {
    const lastEndTime = clipsRef.current.length > 0 ? clipsRef.current[clipsRef.current.length - 1].endTime : duration;
    const mediaClip: VideoTimelineClip = {
      id: `media-append-${Date.now()}`,
      startTime: lastEndTime,
      endTime: lastEndTime + media.duration,
      isCut: false,
      label: `B-Roll: ${media.name}`,
    };
    setClips((prev) => [...prev, mediaClip]);
    setCurrentProject((prev) => ({
      ...prev,
      duration: prev.duration + media.duration,
    }));
  }, [duration]);

  // Transcript Line actions
  const handleToggleKeep = useCallback((id: string) => {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id === id) {
          return {
            ...line,
            status: line.status === 'kept' ? 'unreviewed' : 'kept',
          };
        }
        return line;
      })
    );
  }, []);

  const handleToggleCut = useCallback((id: string) => {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id === id) {
          return {
            ...line,
            status: line.status === 'cut' ? 'unreviewed' : 'cut',
          };
        }
        return line;
      })
    );
  }, []);

  const handleSetLineStatus = useCallback((id: string, status: CutStatus) => {
    setLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, status } : line))
    );
  }, []);

  const handleKeepAll = useCallback(() => {
    setLines((prev) =>
      prev.map((line) => (line.status === 'unreviewed' ? { ...line, status: 'kept' } : line))
    );
  }, []);

  const handleCutFlubs = useCallback(() => {
    setLines((prev) =>
      prev.map((line) => (line.isFlubOrSilence ? { ...line, status: 'cut' } : line))
    );
  }, []);

  const handleResetCuts = useCallback(() => {
    setLines((prev) => prev.map((line) => ({ ...line, status: 'unreviewed' })));
    setClips((prev) => prev.map((clip) => ({ ...clip, isCut: false })));
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      // Shift + I: Toggle Inspect Mode
      if (e.shiftKey && (e.key === 'I' || e.key === 'i')) {
        e.preventDefault();
        setIsInspectActive((prev) => !prev);
        return;
      }

      // Number keys 1-5 to switch tool modes
      if (view === 'editor' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '1') {
          e.preventDefault();
          setEditorMode('media');
          return;
        } else if (e.key === '2') {
          e.preventDefault();
          setEditorMode('cut');
          return;
        } else if (e.key === '3') {
          e.preventDefault();
          setEditorMode('text');
          return;
        } else if (e.key === '4') {
          e.preventDefault();
          setEditorMode('audio');
          return;
        } else if (e.key === '5') {
          e.preventDefault();
          setEditorMode('elements');
          return;
        }
      }

      // Esc closes modals or inspect mode
      if (e.key === 'Escape') {
        if (isInspectActive) {
          setIsInspectActive(false);
          return;
        }
        setShowExportModal(false);
        setShowShortcutsModal(false);
        setShowWallpaperModal(false);
        setShowSettingsModal(false);
        setShowTourGuide(false);
        return;
      }

      // Space: Play/Pause
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
        return;
      }

      // J: Rewind 5s
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        handleSeek(currentTimeRef.current - 5);
        return;
      }

      // L: Forward 5s
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        handleSeek(currentTimeRef.current + 5);
        return;
      }

      // K: Pause/Play
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        handleTogglePlay();
        return;
      }

      // C: Cut current line
      if ((e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        e.preventDefault();
        const idx = findActiveLineIndex(linesRef.current, currentTimeRef.current);
        if (idx >= 0) {
          handleToggleCut(linesRef.current[idx].id);
        }
        return;
      }

      // Shift+C: Cut all flubs
      if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        handleCutFlubs();
        return;
      }

      // V: Keep current line
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        const idx = findActiveLineIndex(linesRef.current, currentTimeRef.current);
        if (idx >= 0) {
          handleToggleKeep(linesRef.current[idx].id);
        }
        return;
      }

      // H: Return to Dashboard
      if (e.key === 'h' || e.key === 'H') {
        if (view === 'editor') {
          e.preventDefault();
          setView('dashboard');
        }
        return;
      }

      // ?: Help shortcuts
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowShortcutsModal(true);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    view,
    isInspectActive,
    handleTogglePlay,
    handleSeek,
    handleToggleCut,
    handleToggleKeep,
    handleCutFlubs,
  ]);

  // Dynamic Font Class based on Settings
  const fontClass = {
    Inter: 'font-inter',
    'JetBrains Mono': 'font-jetbrains',
    'Plus Jakarta Sans': 'font-jakarta',
    'Fira Code': 'font-fira',
    Outfit: 'font-outfit',
  }[settings.fontFamily] || 'font-inter';

  return (
    <div
      className={`w-screen h-screen bg-[#0E1017] text-slate-100 flex flex-col overflow-hidden relative ${fontClass}`}
    >
      {/* Dynamic Background Wallpaper */}
      <WallpaperBackground config={wallpaperConfig} />

      {/* VIEW 1: HOME / DASHBOARD */}
      {view === 'dashboard' ? (
        <DashboardView
          projects={projects}
          onOpenProject={handleOpenProject}
          onNewProject={handleNewProject}
          onDeleteProject={handleDeleteProject}
          onOpenSettings={() => setShowSettingsModal(true)}
          onStartTour={() => setShowTourGuide(true)}
          activeWallpaperName={wallpaperConfig.name}
        />
      ) : (
        /* VIEW 2: MULTI-MODE EDITOR WITH SIDEBAR */
        <div className="flex-1 w-full h-full flex flex-col overflow-hidden relative z-10">
          {/* Desktop Window Title Header (Clean, unrepeated actions) */}
          <WindowHeader
            currentProject={currentProject}
            projects={projects}
            onSelectProject={handleSelectProject}
            onOpenExport={() => setShowExportModal(true)}
            onOpenShortcuts={() => setShowShortcutsModal(true)}
            onAutoCutFlubs={handleCutFlubs}
            onResetCuts={handleResetCuts}
            onGoHome={() => setView('dashboard')}
            onStartTour={() => setShowTourGuide(true)}
            isInspectActive={isInspectActive}
            onToggleInspect={() => setIsInspectActive(!isInspectActive)}
            flubCount={flubCount}
          />

          {/* Main Workspace Area: Sidebar + (Video + Tool Panel) */}
          <div className="flex-1 w-full flex flex-row overflow-hidden relative">
            {/* Left Sidebar Mode Switcher (With My Media, Cut, Text, Audio, Elements & Settings) */}
            <SidebarNav
              currentMode={editorMode}
              onSelectMode={(mode) => setEditorMode(mode)}
              onGoHome={() => setView('dashboard')}
              onOpenSettings={() => setShowSettingsModal(true)}
            />

            {/* Central Work Area (Top Video & Panel + Bottom Timeline) */}
            <div className="flex-1 h-full flex flex-col overflow-hidden">
              {/* Upper Section: Video Preview + Tool Panel */}
              <div className="flex-1 w-full flex flex-col lg:flex-row overflow-hidden">
                {/* Video Preview Column */}
                <section
                  id="tour-video-player"
                  aria-label="Video Preview"
                  className="w-full lg:w-[58%] h-full flex flex-col justify-center p-4 bg-[#12131A]/90 backdrop-blur-sm overflow-y-auto shrink-0"
                >
                  <div className="w-full max-w-4xl mx-auto space-y-2">
                    {/* Active Heading Banner */}
                    {activeHeading && (
                      <div className="w-full py-1.5 px-3 rounded-lg bg-black/85 border border-[#FFE600]/80 text-[#FFE600] text-center text-xs font-black uppercase tracking-wider shadow-lg flex items-center justify-between animate-in fade-in">
                        <span className="truncate">{activeHeading.text}</span>
                        <button
                          onClick={() => setActiveHeading(null)}
                          className="text-xs text-slate-400 hover:text-white ml-2 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {/* 16:9 Dark Grey Video Player with CAM 01 & PiP Controls */}
                    <VideoPlayer
                      project={currentProject}
                      currentTime={currentTime}
                      isPlaying={isPlaying}
                      onTogglePlay={handleTogglePlay}
                      activeLine={activeLine}
                      enablePip={settings.enablePip}
                      onTogglePip={(enabled) =>
                        setSettings((prev) => ({ ...prev, enablePip: enabled }))
                      }
                    />
                  </div>
                </section>

                {/* Sleek Hairline Divider */}
                <div className="hidden lg:block w-[1px] bg-[#1E202B] shrink-0" />

                {/* Right Tool Mode Panel */}
                <section
                  aria-label="Tool Mode Panel"
                  className="w-full lg:w-[42%] flex-1 h-full flex flex-col bg-[#12131A]/95 backdrop-blur-md overflow-hidden"
                >
                  {/* TAB 1: MY MEDIA (User requested: add video clips in between) */}
                  {editorMode === 'media' && (
                    <MyMediaPanel
                      currentTime={currentTime}
                      onInsertMediaAtPlayhead={handleInsertMediaAtPlayhead}
                      onAppendMedia={handleAppendMedia}
                    />
                  )}

                  {/* TAB 2: CUT & SCRIPT */}
                  {editorMode === 'cut' && (
                    <TranscriptPanel
                      lines={lines}
                      currentTime={currentTime}
                      activeLineIndex={activeLineIndex}
                      stats={stats}
                      onSeek={handleSeek}
                      onSetLineStatus={handleSetLineStatus}
                      onToggleKeep={handleToggleKeep}
                      onToggleCut={handleToggleCut}
                      onKeepAll={handleKeepAll}
                      onCutFlubs={handleCutFlubs}
                    />
                  )}

                  {/* TAB 3: TEXT & CAPTIONS */}
                  {editorMode === 'text' && (
                    <TextCaptionsPanel
                      onAddHeading={(text, style) => setActiveHeading({ text, style })}
                    />
                  )}

                  {/* TAB 4: AUDIO & MUSIC */}
                  {editorMode === 'audio' && <AudioPanel />}

                  {/* TAB 5: ELEMENTS */}
                  {editorMode === 'elements' && <ElementsPanel />}
                </section>
              </div>

              {/* Lower Section: Professional Switchable Timeline (Clipchamp Multi-Track / Pro NLE / Storyboard) */}
              <VeedTimeline
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onSeek={handleSeek}
                playbackRate={playbackRate}
                onChangePlaybackRate={(rate) => setPlaybackRate(rate)}
                clips={clips}
                selectedClipId={selectedClipId}
                onSelectClip={(id) => setSelectedClipId(id)}
                onSplitAtPlayhead={handleSplitAtPlayhead}
                onDeleteSelectedClip={handleDeleteSelectedClip}
                onToggleClipCut={handleToggleClipCut}
                lines={lines}
                onToggleLineCut={handleToggleCut}
                timelineMode={settings.timelineMode}
                onChangeTimelineMode={(mode) =>
                  setSettings((prev) => ({ ...prev, timelineMode: mode }))
                }
                onOpenMediaPanel={() => setEditorMode('media')}
              />
            </div>
          </div>
        </div>
      )}

      {/* INSPECT MODE (UX Psychology Rules & Reddit Insights) */}
      <InspectMode
        isInspectActive={isInspectActive}
        onToggleInspect={() => setIsInspectActive(!isInspectActive)}
      />

      {/* MODALS & INTERACTIVE SPOTLIGHT TOUR */}
      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        lines={lines}
        stats={stats}
        selectedClip={selectedClip}
      />

      <ShortcutsModal
        isOpen={showShortcutsModal}
        onClose={() => setShowShortcutsModal(false)}
      />

      <WallpaperModal
        isOpen={showWallpaperModal}
        onClose={() => setShowWallpaperModal(false)}
        config={wallpaperConfig}
        onChangeConfig={(newCfg) => setWallpaperConfig(newCfg)}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        settings={settings}
        onChangeSettings={(newSettings) => setSettings(newSettings)}
        wallpaperConfig={wallpaperConfig}
        onChangeWallpaper={(newCfg) => setWallpaperConfig(newCfg)}
      />

      <TourGuide
        isOpen={showTourGuide}
        onClose={() => setShowTourGuide(false)}
      />
    </div>
  );
}
