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

  /** The dashboard's three sections. */
  section = $state<'home' | 'videos' | 'trash'>('home');

  openEditor(): void {
    this.view = 'editor';
  }

  goHome(section: 'home' | 'videos' | 'trash' = 'home'): void {
    this.section = section;
    this.view = 'home';
  }
}

export const app = new AppStore();
