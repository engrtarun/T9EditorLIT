/** Panel geometry, focus and overlay state the user can drive by keyboard. */
export type FocusArea = 'rail' | 'panel' | 'timeline' | 'stage' | 'header' | 'none';

class LayoutStore {
  /** Width of the transcript panel, px. */
  transcriptWidth = $state(340);
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

  toggleBoth() {
    const next = !this.bothCollapsed;
    this.timelineCollapsed = next;
    this.sourcePanelCollapsed = next;
  }
}

export const layout = new LayoutStore();
