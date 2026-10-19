/**
 * The Clipchamp keyboard shortcut set, verbatim from Microsoft's own list
 * (support.microsoft.com/en-us/clipchamp/keyboard-shortcuts-for-clipchamp),
 * mapped onto our transcript-first model.
 *
 * Every row here is implemented — nothing is aspirational.
 */

export interface ShortcutRow {
  keys: string;
  action: string;
  /** Marked when we deliberately differ from Clipchamp. */
  note?: string;
}

export const SHORTCUT_GROUPS: Array<{ title: string; rows: ShortcutRow[] }> = [
  {
    title: 'General',
    rows: [
      { keys: 'Ctrl + Z', action: 'Undo' },
      { keys: 'Ctrl + Y  /  Ctrl + Shift + Z', action: 'Redo' },
      { keys: 'S', action: 'Split the line under the playhead in two' },
      { keys: 'Del  /  Backspace', action: 'Cut the selected line(s)' },
      { keys: 'X', action: 'Cut the current line and jump to the next' },
      { keys: 'V', action: 'Keep the current line and jump to the next' },
      { keys: 'Ctrl + C', action: 'Copy the current line' },
      { keys: 'Ctrl + V', action: 'Paste the copied line after the current one' },
      { keys: 'Ctrl + D', action: 'Duplicate the current line' },
      { keys: 'Ctrl + A', action: 'Select all lines' },
      { keys: 'Esc', action: 'Deselect all lines' },
      { keys: 'Ctrl + G', action: 'Group the selected lines' },
      { keys: 'Ctrl + Shift + G', action: 'Ungroup the selected lines' },
      { keys: 'Space  /  K', action: 'Play or pause' },
      { keys: 'Ctrl + /', action: 'Open this shortcut list' },
      { keys: 'Ctrl + ←', action: 'Seek to start' },
      { keys: 'Ctrl + →', action: 'Seek to end' },
      { keys: '←  /  →', action: 'Move the seeker one frame' },
      { keys: 'Shift + ←  /  →', action: 'Move the seeker one second' },
      { keys: 'J  /  L', action: 'Seek back / forward 5 seconds' },
      { keys: '↑  /  ↓', action: 'Previous / next transcript line' }
    ]
  },
  {
    title: 'Timeline',
    rows: [
      {
        keys: 'Shift + X then ←  /  →',
        action: 'Move the current line earlier / later',
        note: 'Clipchamp uses plain X + arrow; ours uses X for instant cut'
      },
      { keys: 'Z then ←  /  →', action: 'Trim the start of the current line' },
      { keys: 'C then ←  /  →', action: 'Trim the end of the current line' },
      { keys: 'Ctrl + =', action: 'Zoom in on the timeline' },
      { keys: 'Ctrl + -', action: 'Zoom out of the timeline' },
      { keys: 'Ctrl + 0', action: 'Zoom the timeline to fit' },
      { keys: 'Ctrl + Alt + 2', action: 'Collapse or expand the media panel' },
      { keys: 'Ctrl + Alt + 3', action: 'Collapse or expand the timeline' },
      { keys: 'Ctrl + Alt + F', action: 'Collapse or expand both' }
    ]
  },
  {
    title: 'Navigation',
    rows: [
      { keys: 'Alt + 1', action: 'Go to the mode rail' },
      { keys: 'Alt + 2', action: 'Go to the transcript panel' },
      { keys: 'Alt + 3', action: 'Go to the timeline' },
      { keys: 'Alt + 4', action: 'Go to the stage (video preview)' },
      { keys: 'Alt + 5', action: 'Go to the header' },
      { keys: 'Alt + N', action: 'Go to the project name' },
      { keys: 'Alt + I', action: 'Import media' },
      { keys: 'Alt + E', action: 'Go to export' },
      { keys: 'Alt + R', action: 'Go to the aspect ratio selector' },
      { keys: 'Alt + H', action: 'Open this help' }
    ]
  },
  {
    title: 'Our additions',
    rows: [
      {
        keys: 'X  /  V',
        action: 'Cut or keep the current line, then auto-advance to the next',
        note: 'One-hand flow — the whole point of the app'
      },
      {
        keys: '↑  /  ↓',
        action: 'Jump to the previous / next line and move the preview with it',
        note: 'Clipchamp scrolls the timeline here'
      },
      {
        keys: 'J  /  L',
        action: 'Seek back / forward 5 seconds',
        note: 'Clipchamp uses ← / → for the seeker'
      }
    ]
  }
];
