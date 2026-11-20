import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../ipc';
import { layout } from './layout.svelte';
import { menu } from './menu.svelte';
import { ublock } from './ublock.svelte';
import { downloads } from './downloads.svelte';

/**
 * The window's fullscreen state + where Firefox's F11 affordances live.
 *
 * Firefox gives fullscreen three doors, and the user asked for all of them in
 * settings: the F11 key, a button in the browser toolbar (next to Home, like
 * the screenshot), and - if they want it - the same button in the app's own
 * top bar. `prefs` is the settings half, `fullscreen` is the live state.
 *
 * In the desktop app this is the real window (`setFullscreen`); on
 * localhost:5174 it is the browser's Fullscreen API so the feature can be
 * previewed in dev. Nothing media-related happens here: no decoder, no
 * buffer, only a window flag.
 */
const KEY = 't9-shell.chrome.v1';

interface ChromePrefs {
  /** F11 toggles fullscreen. */
  fullscreenKey: boolean;
  /** The expand/collapse button sits in the browser toolbar, beside Home. */
  fullscreenToolbar: boolean;
}

class ChromeStore {
  fullscreen = $state(false);
  fullscreenKey = $state(true);
  /**
   * The ⛶ button in the browser toolbar. OFF by default — "by difialt ye
   * hide rahe halaki key se acces also on rahe": the F11 key stays on; the
   * button is an optional extra the user can switch on from Browser settings.
   */
  fullscreenToolbar = $state(false);

  /**
   * Firefox F11: the nav toolbox (tab strip + toolbar) is COLLAPSED on
   * enter and only comes back when the pointer goes to the top edge of the
   * window. This flag tracks whether it is currently revealed.
   */
  fullscreenRevealed = $state(false);

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<ChromePrefs>;
      if (typeof p.fullscreenKey === 'boolean') this.fullscreenKey = p.fullscreenKey;
      if (typeof p.fullscreenToolbar === 'boolean') this.fullscreenToolbar = p.fullscreenToolbar;
    } catch {
      /* blocked storage / old payload: the defaults are honest */
    }
  }

  private save(): void {
    try {
      const prefs: ChromePrefs = {
        fullscreenKey: this.fullscreenKey,
        fullscreenToolbar: this.fullscreenToolbar
      };
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: the switch still works for this session */
    }
  }

  setFullscreenKey(on: boolean): void {
    this.fullscreenKey = on;
    this.save();
  }

  setFullscreenToolbar(on: boolean): void {
    this.fullscreenToolbar = on;
    this.save();
  }

  /** F11 / the toolbar button: one toggle, whichever door was used.
   *
   * Firefox: entering fullscreen collapses ALL chrome (tab strip + toolbar)
   * — the content fills the window. Esc never exits fullscreen (only F11
   * does); it only hides a revealed toolbar. So on both transitions the
   * revealed flag resets to "collapsed".
   */
  async toggleFullscreen(): Promise<boolean> {
    if (isTauri()) {
      try {
        const win = getCurrentWindow();
        const on = !(await win.isFullscreen());
        await win.setFullscreen(on);
        this.fullscreen = on;
        this.fullscreenRevealed = false;
      } catch {
        /* missing permission: the state stays as it was */
      }
      return this.fullscreen;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        this.fullscreen = false;
      } else {
        await document.documentElement.requestFullscreen();
        this.fullscreen = true;
      }
      this.fullscreenRevealed = false;
    } catch {
      /* not a user gesture, or the preview frame refuses */
    }
    return this.fullscreen;
  }

  /**
   * Reveal the collapsed chrome (Firefox's nav toolbox showing on a top-edge
   * hover / F6 / Ctrl+L). Only meaningful while fullscreen.
   */
  revealFullscreenChrome(): void {
    if (!this.fullscreen) return;
    this.fullscreenRevealed = true;
  }

  /**
   * Collapse a revealed toolbar again (Firefox's autohide / Esc). Vetoed
   * while the urlbar has focus or a popup is open — Firefox keeps the chrome
   * in those cases so the user can keep typing / interacting. Returns whether
   * the chrome actually collapsed, so Escape can fall through when vetoed.
   */
  hideFullscreenChrome(): boolean {
    if (!this.fullscreen || !this.fullscreenRevealed) return false;
    const ae = document.activeElement as HTMLElement | null;
    // The desktop app renders the page in a CHILD window: clicking into it
    // takes OS focus away from the main document, but `activeElement` stays
    // the old INPUT. `hasFocus()` is what stops that stale focus from
    // vetoing the autohide forever ("toolbar kabhi chhupta nahi").
    if (
      ae &&
      (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) &&
      document.hasFocus()
    ) {
      return false;
    }
    if (menu.current) return false;
    if (
      layout.profileOpen ||
      layout.helpOpen ||
      layout.settingsOpen ||
      layout.commandPaletteOpen ||
      layout.importOpen
    ) {
      return false;
    }
    if (ublock.panelOpen) return false;
    if (downloads.open) return false;
    this.fullscreenRevealed = false;
    return true;
  }

  /**
   * Follow the window even when something else changed it - a page video
   * going fullscreen (Rust grows the window), Win+Shift+Enter, the OS. The
   * resize event is the reliable signal for both directions; a short debounce
   * keeps a window drag from firing one IPC call per pixel.
   */
  watch(): () => void {
    if (!isTauri()) {
      const onFs = () => {
        const prev = this.fullscreen;
        this.fullscreen = !!document.fullscreenElement;
        if (prev !== this.fullscreen) this.fullscreenRevealed = false;
      };
      document.addEventListener('fullscreenchange', onFs);
      return () => document.removeEventListener('fullscreenchange', onFs);
    }
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    let dead = false;
    void win
      .onResized(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void win
            .isFullscreen()
            .then((on) => {
              const prev = this.fullscreen;
              this.fullscreen = on;
              if (prev !== on) this.fullscreenRevealed = false;
            })
            .catch(() => {});
        }, 200);
      })
      .then((un) => {
        if (dead) un();
        else unlisten = un;
      })
      .catch(() => {
        /* no window permission in this build */
      });
    // Firefox's `#fullscr-toggler`: while the chrome is COLLAPSED, the very
    // top edge of the window reveals it. The pointer is out on the native
    // child webview there — no DOM listener ever sees it — so the position
    // comes from the window API (desktop-physical minus the window origin).
    // Two tiny IPC calls every 100 ms, and ONLY while collapsed: outside
    // that state the tick returns before touching the API at all.
    const topEdge = setInterval(() => {
      if (!this.fullscreen || this.fullscreenRevealed) return;
      void Promise.all([cursorPosition(), win.outerPosition()])
        .then(([cur, origin]) => {
          const d = cur.y - origin.y;
          // d >= -4 keeps a cursor parked on a monitor ABOVE this one from
          // "hovering" the top edge it is nowhere near.
          if (this.fullscreen && !this.fullscreenRevealed && d >= -4 && d <= 4) {
            this.revealFullscreenChrome();
          }
        })
        .catch(() => {
          /* permission hiccup / window on another monitor: the keyboard
             doors (F6, Ctrl+L, F11) still reveal the chrome */
        });
    }, 100);
    return () => {
      dead = true;
      clearInterval(topEdge);
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }
}

export const chrome = new ChromeStore();
