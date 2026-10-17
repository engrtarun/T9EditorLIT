/**
 * Clipchamp-clone view state: which top-level screen is up, and which
 * content-library tab the editor's left rail is showing.
 *
 * Kept separate from `mode` on purpose. `mode` (cut | polish) decides which
 * right-hand editing panel is *resident*; this store decides whether we are
 * even inside the editor. Both drive `{#key}` blocks so switching either
 * destroys the outgoing tree instead of hiding it.
 */

export type CcView = "home" | "editor";

export type RailTab = "media" | "record" | "library" | "templates" | "text" | "transitions";

export type HomeTab = "home" | "templates";

class ClipchampStore {
  view = $state<CcView>("home");
  /** Left rail selection inside the editor. */
  railTab = $state<RailTab>("media");
  /** Home screen nav: Home shows projects, Templates shows the gallery. */
  homeTab = $state<HomeTab>("home");
  sidebarOpen = $state(true);
  /** Content sidebar width in px; Clipchamp's panel edge is draggable. */
  sidebarWidth = $state(248);
  projectName = $state("Video Project 1");

  openEditor(): void {
    this.view = "editor";
    this.railTab = "media";
  }

  goHome(): void {
    this.view = "home";
  }
}

export const cc = new ClipchampStore();
