/**
 * Which screen the app is showing.
 *
 * `home` is the **dashboard** — the landing screen the app opens on, whether
 * it was started from the taskbar icon, the desktop shortcut or the launcher
 * script. `editor` is the working surface (media / cut / export).
 *
 * Only one of them is ever mounted. The switch in `App.svelte` is a plain
 * `{#if}`, so the dashboard's DOM is *destroyed* the moment the editor takes
 * over — the zero-RAM rule from AGENTS.md §1 applied at the app level.
 */
export type AppView = 'home' | 'editor';

class AppStore {
  view = $state<AppView>('home');

  /** The dashboard's three sections. `cloud` is the T9 Cloud setup page. */
  section = $state<'home' | 'cloud' | 'trash'>('home');

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

  goHome(section: 'home' | 'cloud' | 'trash' = 'home'): void {
    this.section = section;
    this.view = 'home';
  }
}

export const app = new AppStore();
