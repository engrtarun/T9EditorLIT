/**
 * Which screen the app is showing.
 *
 * `home` is the **dashboard** — the landing screen the app opens on, whether
 * it was started from the taskbar icon, the desktop shortcut or the launcher
 * script. `editor` is the working surface (media / cut / export). `browser`
 * is the in-built browser (9 tabs, fast downloads).
 *
 * Only one of them is ever mounted. The switch in `App.svelte` is a plain
 * `{#if}`, so the dashboard's DOM is *destroyed* the moment the editor takes
 * over — the zero-RAM rule from AGENTS.md §1 applied at the app level.
 */
export type AppView = 'home' | 'editor' | 'browser';

class AppStore {
  view = $state<AppView>('home');

  /** The dashboard's three sections. `cloud` is the T9 Cloud setup page. */
  section = $state<'home' | 'cloud' | 'trash'>('home');

  /**
   * The "Create New Project" panel is open.
   *
   * It lives on the dashboard (that is where a project starts), but "New
   * project" has to work from the editor's project menu too — so the flag is
   * here, not inside `HomeDashboard`, and opening it from anywhere goes home
   * first.
   */
  newProjectOpen = $state(false);

  /**
   * The app's real version.
   *
   * Read from the running binary, not hardcoded: a version number in the
   * source that drifts from the shipped build is a lie the user can see.
   * `tauri.conf.json` is the single place the version is written.
   */
  version = $state('0.1.0');

  openEditor(): void {
    this.view = 'editor';
  }

  /**
   * Open the in-built browser.
   *
   * `from` remembers which screen launched it, so the browser's close button
   * returns to the same place — the editor if a project was open, the
   * dashboard otherwise. Without it the browser would always dump the user
   * on the dashboard after a download.
   */
  openBrowser(from?: AppView): void {
    if (from && from !== 'browser') this.browserFrom = from;
    this.view = 'browser';
  }

  /** The screen the browser was opened from (for its close button). */
  browserFrom = $state<AppView>('home');

  /** Close the browser and land back on whichever screen opened it. */
  closeBrowser(): void {
    this.view = this.browserFrom === 'browser' ? 'home' : this.browserFrom;
  }

  goHome(section: 'home' | 'cloud' | 'trash' = 'home'): void {
    this.section = section;
    this.view = 'home';
  }

  /** Ask for a new project — the dashboard shows the panel. */
  openNewProject(): void {
    this.view = 'home';
    this.section = 'home';
    this.newProjectOpen = true;
  }
}

export const app = new AppStore();
