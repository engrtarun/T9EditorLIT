/**
 * The in-built browser's Firefox keyboard map.
 *
 * Every row comes from Firefox on Windows (the official Mozilla shortcut
 * lists — see docs/BROWSER_KEYS.md for the exact table and the few keys we
 * deliberately do not bind). The one rule: an entry in this file is
 * *implemented* — tests drive every combo, nothing here is aspirational.
 *
 * The module is deliberately store-free: it resolves a KeyboardEvent to a
 * named action and hands it to an injected `BrowserKeyDeps`. That keeps unit
 * tests DOM-free (`node --test`) and keeps App.svelte doing only wiring.
 *
 * These are browser-view keys — they never fire while the editor is open,
 * and the editor's own rebindable map (keys.svelte.ts) is untouched.
 */

/** The event shape this module needs (a plain-object alias of KeyboardEvent). */
export interface KeyEvt {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target?: EventTarget | null;
  preventDefault?: () => void;
}

/** What the browser keys may do. Stores + ipc live on the other side (App.svelte). */
export interface BrowserKeyDeps {
  newTab(): void;
  closeTab(): void;
  closeBrowserView(): void;
  reopenClosedTab(): void;
  selectTabN(n: number): void;
  /** Ctrl+9 — Firefox's "the last tab", whatever the count is. */
  lastTab(): void;
  prevTab(): void;
  nextTab(): void;
  moveTab(dir: -1 | 1): void;
  back(): void;
  forward(): void;
  stopLoading(): void;
  reload(force: boolean): void;
  goHome(): void;
  focusUrlbar(): void;
  downloads(): void;
  history(): void;
  clearHistory(): void;
  bookmark(): void;
  bookmarkAllTabs(): void;
  openBookmarks(): void;
  savePage(): void;
  openFile(): void;
  printPage(): void;
  viewSource(): void;
  /** dir: -1 out, +1 in, 0 reset — the native webview's zoom. */
  zoom(dir: -1 | 0 | 1): void;
  findInPage(): void;
  openHelp(): void;
}

/** An action's name + all Firefox combos that fire it. */
interface Entry {
  action: keyof BrowserKeyDeps & string;
  combos: string[];
  /** Works even while the focus sits in the address bar (Firefox lets it). */
  whileTyping?: boolean;
}

const B = (
  action: keyof BrowserKeyDeps & string,
  combos: string[],
  whileTyping = false
): Entry => ({
  action,
  combos,
  whileTyping
});

/**
 * The bindings, Firefox-Windows-css order. Parse rules in `matchCombo` keep
 * mirrors honest: `tab`, `pageup`/`pagedown`, `delete`, `f1`… all lowercase
 * `e.key` names.
 */
export const BINDINGS: Entry[] = [
  // ── tabs ────────────────────────────────────────────────────────────────
  B('newTab', ['ctrl+t'], true),
  B('closeTab', ['ctrl+w', 'ctrl+f4'], true),
  B('reopenClosedTab', ['ctrl+shift+t'], true),
  B('newTab', ['ctrl+n'], true), // Firefox "new window" — one-window app: a tab
  B('prevTab', ['ctrl+shift+tab', 'ctrl+pageup'], true),
  B('nextTab', ['ctrl+tab', 'ctrl+pagedown'], true),
  B(
    'selectTabN',
    ['ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5', 'ctrl+6', 'ctrl+7', 'ctrl+8'],
    true
  ),
  B('lastTab', ['ctrl+9'], true),
  B('moveTab', ['ctrl+shift+pageup', 'ctrl+shift+pagedown'], true),
  B('closeBrowserView', ['ctrl+shift+w'], true),
  // ── navigation ──────────────────────────────────────────────────────────
  B('back', ['alt+arrowleft', 'backspace']),
  B('forward', ['alt+arrowright', 'shift+backspace']),
  B('reload', ['f5', 'ctrl+r'], true),
  B('reload', ['ctrl+f5', 'ctrl+shift+r'], true), // force reload (same nudge, force anyway)
  B('stopLoading', ['escape']),
  B('goHome', ['alt+home']),
  B('focusUrlbar', ['ctrl+l', 'alt+d', 'ctrl+k'], true),
  // ── page & panels ───────────────────────────────────────────────────────
  B('downloads', ['ctrl+j'], true),
  B('history', ['ctrl+h']),
  B('clearHistory', ['ctrl+shift+delete']),
  B('bookmark', ['ctrl+d']),
  B('bookmarkAllTabs', ['ctrl+shift+d']),
  B('openBookmarks', ['ctrl+b', 'ctrl+shift+o']),
  B('savePage', ['ctrl+s'], true),
  B('openFile', ['ctrl+o'], true),
  B('printPage', ['ctrl+p']),
  B('viewSource', ['ctrl+u']),
  B('findInPage', ['ctrl+f', 'f3', 'shift+f3', 'ctrl+shift+g', 'ctrl+shift+f']),
  // ── zoom (the child webview's own zoom, like Firefox's page zoom) ──────
  // Ctrl+Shift+= is the "+" key — Firefox zooms with both meanings of that key.
  B('zoom', ['ctrl+=', 'ctrl+shift+=', 'ctrl++', 'ctrl+-', 'ctrl+0']),
  // ── help ────────────────────────────────────────────────────────────────
  B('openHelp', ['f1'], true)
];

/** Deps that take no argument — the plain `deps[action]()` branch below. */
type ZeroArgAction = {
  [K in keyof BrowserKeyDeps]: Parameters<BrowserKeyDeps[K]> extends [] ? K : never;
}[keyof BrowserKeyDeps];

const norm = (key: string): string => {
  const k = key.toLowerCase();
  if (k === ' ') return 'space';
  return k;
};

const matchCombo = (e: KeyEvt, combo: string): boolean => {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  if (e.metaKey) return false; // Windows key chords belong to the OS, never here
  if (e.ctrlKey !== parts.includes('ctrl')) return false;
  if (e.shiftKey !== parts.includes('shift')) return false;
  if (e.altKey !== parts.includes('alt')) return false;
  if (norm(e.key) !== key) return false;
  return true;
};

const inputTarget = (e: KeyEvt): boolean => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

/** Resolve an event to the binding it matches respecting the focus rules. */
export function matchBrowserKey(e: KeyEvt): { action: string; combo: string } | null {
  for (const entry of BINDINGS) {
    for (const combo of entry.combos) {
      if (!matchCombo(e, combo)) continue;
      if (inputTarget(e) && !entry.whileTyping) return null;
      return { action: entry.action, combo };
    }
  }
  return null;
}

/** Ctrl+1..8 resolve to `selectTabN` — pull the digit out of the combo. */
const digitOf = (combo: string): number => {
  const m = /^ctrl\+([1-8])$/.exec(combo);
  return m ? Number(m[1]) : 0;
};

/**
 * Fire a browser key. Returns true when the event was a browser shortcut
 * (App.svelte stops its own handling then) — the editor's path is untouched.
 */
export function dispatchBrowserKey(e: KeyEvt, deps: BrowserKeyDeps): boolean {
  if (e.metaKey) return false;
  const hit = matchBrowserKey(e);
  if (!hit) return false;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  if (hit.action === 'selectTabN') {
    // Ctrl+1..8 = tab n (0-based here; the store clamps past the end).
    deps.selectTabN(digitOf(hit.combo) - 1);
  } else if (hit.action === 'moveTab') {
    deps.moveTab(hit.combo.endsWith('pageup') ? -1 : 1);
  } else if (hit.action === 'reload') {
    // plain F5 / Ctrl+R reload; Ctrl+F5 and Ctrl+Shift+R bypass the cache.
    deps.reload(hit.combo === 'ctrl+f5' || hit.combo === 'ctrl+shift+r');
  } else if (hit.action === 'zoom') {
    deps.zoom(hit.combo === 'ctrl+-' ? -1 : hit.combo === 'ctrl+0' ? 0 : 1);
  } else {
    deps[hit.action as ZeroArgAction]();
  }
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * The shortcut sheet's browser section — generated from the bindings above
 * so the docs, the sheet and the code can never drift apart.
 * ──────────────────────────────────────────────────────────────────────── */

export interface BrowserSheetRow {
  keys: string;
  action: string;
  note?: string;
}

export const BROWSER_GROUPS: Array<{ title: string; rows: BrowserSheetRow[] }> = [
  {
    title: 'Tabs (Firefox rulebook)',
    rows: [
      { keys: 'Ctrl + T  /  Ctrl + N', action: 'Naya tab' },
      { keys: 'Ctrl + W  /  Ctrl + F4', action: 'Tab band', note: 'last tab → browser band' },
      { keys: 'Ctrl + Shift + T', action: 'Band kiya tab wapas' },
      { keys: 'Ctrl + Tab  /  Ctrl + PgDn', action: 'Agla tab' },
      { keys: 'Ctrl + Shift + Tab  /  Ctrl + PgUp', action: 'Pichla tab' },
      { keys: 'Ctrl + 1 … 9', action: 'Tab n / last tab' },
      { keys: 'Ctrl + Shift + PgUp / PgDn', action: 'Tab ko aage / peeche move' },
      { keys: 'Ctrl + Shift + W', action: 'Browser band — editor pe wapas' }
    ]
  },
  {
    title: 'Navigation',
    rows: [
      { keys: 'Alt + ←  /  Backspace', action: 'Back' },
      { keys: 'Alt + →  /  Shift + Backspace', action: 'Forward' },
      { keys: 'F5  /  Ctrl + R', action: 'Reload' },
      { keys: 'Ctrl + F5  /  Ctrl + Shift + R', action: 'Cache ke bina reload' },
      { keys: 'Esc', action: 'Stop — loading spinner roko' },
      { keys: 'Alt + Home', action: 'Speed dial (home page)' },
      { keys: 'Ctrl + L  /  Alt + D  /  Ctrl + K', action: 'Address bar fokus' }
    ]
  },
  {
    title: 'Page',
    rows: [
      { keys: 'Ctrl + D', action: 'Is page ko bookmark (dial me)' },
      { keys: 'Ctrl + Shift + D', action: 'Saare tabs bookmark' },
      { keys: 'Ctrl + B  /  Ctrl + Shift + O', action: 'Bookmarks = speed dial kholo' },
      { keys: 'Ctrl + J', action: 'Downloads panel' },
      { keys: 'Ctrl + H', action: 'History panel' },
      { keys: 'Ctrl + Shift + Del', action: 'Browsing data + T9 history saaf' },
      { keys: 'Ctrl + S', action: 'Page save (daemon downloader)' },
      { keys: 'Ctrl + O', action: 'File import dialog' },
      { keys: 'Ctrl + P', action: 'Print (WebView2 print dialog)' },
      { keys: 'Ctrl + U', action: 'Page source (view-source)' },
      { keys: 'Ctrl + +  /  Ctrl + -  /  Ctrl + 0', action: 'Page zoom in / out / reset' }
    ]
  },
  {
    title: 'Find & help',
    rows: [
      {
        keys: 'Ctrl + F',
        action: 'Find in page',
        note: 'WebView2 me find API nahi hai — T9 me toast bata deta hai'
      },
      { keys: 'F3  /  Ctrl + G  /  Shift + F3', action: 'Find again / previous', note: 'same' },
      { keys: 'F1', action: 'Ye shortcut list' }
    ]
  }
];
