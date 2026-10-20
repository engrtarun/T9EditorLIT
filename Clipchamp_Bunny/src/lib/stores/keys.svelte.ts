/**
 * The keyboard map. Every action has a default; the user can rebind any of
 * them, and the choice is remembered on this machine.
 */

export type KeyAction =
  | 'cut'
  | 'keep'
  | 'split'
  | 'delete'
  | 'playPause'
  | 'seekBack'
  | 'seekForward'
  | 'nextLine'
  | 'prevLine'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'selectAll'
  | 'deselect'
  | 'group'
  | 'ungroup'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'cutHere'
  | 'help';

export const KEY_DEFAULTS: Record<KeyAction, string> = {
  cut: 'x',
  keep: 'v',
  split: 's',
  delete: 'delete',
  playPause: 'space',
  seekBack: 'j',
  seekForward: 'l',
  nextLine: 'arrowdown',
  prevLine: 'arrowup',
  undo: 'ctrl+z',
  redo: 'ctrl+y',
  copy: 'ctrl+c',
  paste: 'ctrl+v',
  duplicate: 'ctrl+d',
  selectAll: 'ctrl+a',
  deselect: 'escape',
  group: 'ctrl+g',
  ungroup: 'ctrl+shift+g',
  zoomIn: 'ctrl+=',
  zoomOut: 'ctrl+-',
  zoomFit: 'ctrl+0',
  cutHere: 'ctrl+shift+x',
  help: 'ctrl+/'
};

export const KEY_LABELS: Record<KeyAction, string> = {
  cut: 'Cut the current line',
  keep: 'Keep the current line',
  split: 'Split the line under the playhead',
  delete: 'Cut the selected line(s)',
  playPause: 'Play / pause',
  seekBack: 'Seek back 5 s',
  seekForward: 'Seek forward 5 s',
  nextLine: 'Next transcript line',
  prevLine: 'Previous transcript line',
  undo: 'Undo',
  redo: 'Redo',
  copy: 'Copy the current line',
  paste: 'Paste the copied line',
  duplicate: 'Duplicate the current line',
  selectAll: 'Select all lines',
  deselect: 'Deselect all lines',
  group: 'Group the selected lines',
  ungroup: 'Ungroup the selected lines',
  zoomIn: 'Zoom in on the timeline',
  zoomOut: 'Zoom out of the timeline',
  zoomFit: 'Zoom the timeline to fit',
  cutHere: 'Cut at the playhead (split + drop the head)',
  help: 'Open this shortcut list'
};

const STORAGE_KEY = 't9-editor-lit.keys';

class KeysStore {
  map = $state<Record<KeyAction, string>>({ ...KEY_DEFAULTS });

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<KeyAction, string>>;
      for (const k of Object.keys(KEY_DEFAULTS) as KeyAction[]) {
        if (typeof parsed[k] === 'string' && parsed[k]) this.map[k] = parsed[k];
      }
    } catch {
      /* corrupt store — keep the defaults */
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map));
    } catch {
      /* private mode — the map just will not persist */
    }
  }

  set(action: KeyAction, key: string) {
    this.map = { ...this.map, [action]: key.toLowerCase() };
    this.persist();
  }

  reset() {
    this.map = { ...KEY_DEFAULTS };
    this.persist();
  }

  /** The key bound to an action. */
  get(action: KeyAction) {
    return this.map[action];
  }

  /** Does this keyboard event match the action's binding? */
  matches(action: KeyAction, e: KeyboardEvent): boolean {
    const combo = this.map[action].split('+').map((s) => s.trim());
    const key = combo[combo.length - 1];
    const wantCtrl = combo.includes('ctrl');
    const wantShift = combo.includes('shift');
    const wantAlt = combo.includes('alt');

    if ((e.ctrlKey || e.metaKey) !== wantCtrl) return false;
    if (e.shiftKey !== wantShift) return false;
    if (e.altKey !== wantAlt) return false;

    const evKey = e.key.toLowerCase();
    if (key === 'space') return evKey === ' ' || evKey === 'spacebar';
    if (key === 'delete') return evKey === 'delete' || evKey === 'backspace';
    if (key === 'escape') return evKey === 'escape';
    if (key === 'arrowup') return evKey === 'arrowup';
    if (key === 'arrowdown') return evKey === 'arrowdown';
    if (key === 'arrowleft') return evKey === 'arrowleft';
    if (key === 'arrowright') return evKey === 'arrowright';
    return evKey === key;
  }

  /** Pretty label for the shortcut sheet. */
  label(action: KeyAction): string {
    return this.map[action]
      .split('+')
      .map((s) => {
        const t = s.trim();
        if (t === 'ctrl') return 'Ctrl';
        if (t === 'shift') return 'Shift';
        if (t === 'alt') return 'Alt';
        if (t === 'space') return 'Space';
        if (t === 'delete') return 'Del';
        if (t === 'arrowup') return '↑';
        if (t === 'arrowdown') return '↓';
        if (t === 'arrowleft') return '←';
        if (t === 'arrowright') return '→';
        if (t === 'escape') return 'Esc';
        return t.length === 1 ? t.toUpperCase() : t;
      })
      .join(' + ');
  }
}

export const keys = new KeysStore();
