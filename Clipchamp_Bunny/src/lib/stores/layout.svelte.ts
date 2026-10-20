/** Panel geometry, focus and overlay state the user can drive by keyboard. */
export type FocusArea = 'rail' | 'panel' | 'timeline' | 'stage' | 'header' | 'none';

/** Default geometry — double-click on a separator snaps back to these. */
const MEDIA_W_DEFAULT = 248;
/** 95 fixed chrome (border + 3px resize strip + tool row + minimap + ruler + T lane)
    + 96 lanes (video 52 + audio 44) — i.e. today's look, plus the drag strip. */
const TIMELINE_H_DEFAULT = 191;

class LayoutStore {
  /** Width of the transcript panel, px. */
  transcriptWidth = $state(340);
  /** Width of the "My media" panel, px (drag the right edge). */
  mediaWidth = $state(MEDIA_W_DEFAULT);
  /** Height of the timeline block when expanded, px (drag the top edge). */
  timelineHeight = $state(TIMELINE_H_DEFAULT);
  /** Timeline collapsed to just the tool row. */
  timelineCollapsed = $state(false);
  /** "My media" panel collapsed to its icon strip. */
  sourcePanelCollapsed = $state(false);
  /** Clipchamp's `Ctrl+Alt+F` — collapse both. */
  get bothCollapsed() {
    return this.timelineCollapsed && this.sourcePanelCollapsed;
  }

  /** Where the last `Alt + n` navigation put the caret. */
  focus = $state<FocusArea>('none');
  /** `Ctrl + /` shortcut sheet. */
  helpOpen = $state(false);

  setTranscriptWidth(px: number) {
    this.transcriptWidth = Math.max(240, Math.min(560, Math.round(px)));
  }

  setMediaWidth(px: number) {
    this.mediaWidth = Math.max(180, Math.min(420, Math.round(px)));
    this.persist();
  }

  setTimelineHeight(px: number) {
    // 91 = tool row 30 + minimap 7 + ruler 24 + T lane 30 — the lanes need
    // room for video 52 + audio 44 below that, so never go under ~190.
    this.timelineHeight = Math.max(150, Math.min(560, Math.round(px)));
    this.persist();
  }

  resetMediaWidth() {
    this.setMediaWidth(MEDIA_W_DEFAULT);
  }

  resetTimelineHeight() {
    this.setTimelineHeight(TIMELINE_H_DEFAULT);
  }

  toggleBoth() {
    const next = !this.bothCollapsed;
    this.timelineCollapsed = next;
    this.sourcePanelCollapsed = next;
  }

  /** Panel collapse + drag-resize sizes are a user choice — remember them. */
  setSourcePanelCollapsed(v: boolean) {
    this.sourcePanelCollapsed = v;
    try {
      localStorage.setItem('t9-editor-lit.panel', v ? '1' : '0');
    } catch {
      /* private mode */
    }
  }

  private persist() {
    try {
      localStorage.setItem('t9-editor-lit.mediaw', String(this.mediaWidth));
      localStorage.setItem('t9-editor-lit.tlheight', String(this.timelineHeight));
    } catch {
      /* private mode */
    }
  }

  constructor() {
    try {
      if (localStorage.getItem('t9-editor-lit.panel') === '1') this.sourcePanelCollapsed = true;
      const mw = Number(localStorage.getItem('t9-editor-lit.mediaw'));
      if (mw) this.mediaWidth = Math.max(180, Math.min(420, Math.round(mw)));
      const th = Number(localStorage.getItem('t9-editor-lit.tlheight'));
      if (th) this.timelineHeight = Math.max(150, Math.min(560, Math.round(th)));
    } catch {
      /* private mode */
    }
  }
}

export const layout = new LayoutStore();
