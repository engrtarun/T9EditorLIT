/** Panel geometry the user can drag. Clipchamp has a "Resize panel" separator too. */
class LayoutStore {
  /** Width of the transcript panel, px. */
  transcriptWidth = $state(340);
  /** Timeline collapsed to just the tool row. */
  timelineCollapsed = $state(false);

  setTranscriptWidth(px: number) {
    this.transcriptWidth = Math.max(240, Math.min(560, Math.round(px)));
  }
}

export const layout = new LayoutStore();
