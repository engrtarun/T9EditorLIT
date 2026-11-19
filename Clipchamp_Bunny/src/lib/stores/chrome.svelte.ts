import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../ipc';

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
   * hide rahe halaki key se acces also on rahe": F11 (and Escape) are the
   * doors that stay open; the button is an optional fourth one the user can
   * switch on from Browser settings.
   */
  fullscreenToolbar = $state(false);

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

  /** F11 / the toolbar button: one toggle, whichever door was used. */
  async toggleFullscreen(): Promise<boolean> {
    if (isTauri()) {
      try {
        const win = getCurrentWindow();
        const on = !(await win.isFullscreen());
        await win.setFullscreen(on);
        this.fullscreen = on;
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
    } catch {
      /* not a user gesture, or the preview frame refuses */
    }
    return this.fullscreen;
  }

  /** Escape leaves fullscreen, exactly like Firefox. */
  async exitFullscreen(): Promise<void> {
    if (!this.fullscreen) return;
    if (isTauri()) {
      await getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
    this.fullscreen = false;
  }

  /**
   * Follow the window even when something else changed it - a page video
   * going fullscreen (Rust grows the window), Win+Shift+Enter, the OS. The
   * resize event is the reliable signal for both directions; a short debounce
   * keeps a window drag from firing one IPC call per pixel.
   */
  watch(): () => void {
    if (!isTauri()) {
      const onFs = () => (this.fullscreen = !!document.fullscreenElement);
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
            .then((on) => (this.fullscreen = on))
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
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }
}

export const chrome = new ChromeStore();
