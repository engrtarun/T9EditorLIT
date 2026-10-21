/**
 * Clipchamp keyboard shortcuts — one table, two consumers.
 *
 * `BINDINGS` is the single source of truth for both the key matcher and the
 * `Ctrl + /` cheat sheet, so the sheet can never drift from what the app
 * actually does: a shortcut that is not in this table cannot be pressed, and
 * one that is in it is automatically documented.
 *
 * The combos are transcribed from Microsoft's own list (support.microsoft.com
 * "Keyboard shortcuts for Clipchamp" and clipchamp.com/en/blog/
 * clipchamp-shortcuts), so muscle memory from the real app carries over.
 *
 * Components do NOT add their own window listeners for these keys — they
 * register an action here instead. That keeps exactly one `keydown` handler
 * alive for the whole shell and, more importantly, keeps the "who handles S"
 * question out of the component tree: when several modes are mounted the
 * registry decides, and unmounting unregisters.
 *
 * Scope (`editor` vs `always`) is checked by `handle()` — a binding that says
 * it belongs to the editor cannot fire while the Home screen is up.
 */

import { cc } from "./cc.svelte";

export type ShortcutScope =
  /** Only relevant once a project is open (play, split, zoom…). */
  | "editor"
  /** Relevant anywhere, including the home screen and the cheat sheet. */
  | "always";

export interface ShortcutDef {
  /** Stable id, also the key actions are registered under. */
  id: string;
  /** Accelerator as shown to the user, e.g. "Ctrl + /". */
  combo: string;
  /** Matched against `KeyboardEvent.key` (lower-cased) or `KeyboardEvent.code`. */
  keys: string[];
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  scope?: ShortcutScope;
  /**
   * Listed for Clipchamp parity but **not wired**: the feature underneath it
   * (multi-clip selection, which copy / paste / group need) does not exist in
   * a transcript-first, single-source timeline yet.
   *
   * The cheat sheet marks these rows instead of pretending they work — the
   * whole point of one table is that a documented key either behaves or admits
   * it does not. Set when the selection model lands.
   */
  planned?: boolean;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutDef[];
}

const def = (
  id: string,
  combo: string,
  keys: string[],
  extra: Partial<ShortcutDef> = {},
): ShortcutDef => ({
  id,
  combo,
  keys,
  ...extra,
});

/** Everything `Ctrl + /` shows, in the order Clipchamp groups it. */
export const BINDINGS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      def("shortcuts", "Ctrl + /", ["/"], { ctrl: true, scope: "always" }),
      def("undo", "Ctrl + Z", ["z"], { ctrl: true }),
      def("redo", "Ctrl + Y", ["y"], { ctrl: true }),
      // Microsoft documents Cmd + Shift + Z for macOS; Windows users reach for
      // Ctrl + Shift + Z out of habit, so both are bound to the same handler.
      def("redoShift", "Ctrl + Shift + Z", ["z"], { ctrl: true, shift: true }),
      def("import", "Alt + I", ["i"], { alt: true, scope: "always" }),
      def("export", "Alt + E", ["e"], { alt: true }),
      def("projectName", "Alt + N", ["n"], { alt: true, scope: "always" }),
      def("aspectRatio", "Alt + R", ["r"], { alt: true }),
      def("help", "Alt + H", ["h"], { alt: true, scope: "always" }),
    ],
  },
  {
    title: "Timeline editing",
    items: [
      def("split", "S", ["s"]),
      // Delete/Backspace cut the transcript segment under the playhead — the
      // transcript is this app's selection model, so that is what "delete the
      // selected item" means here.
      def("delete", "Delete", ["delete", "backspace"]),
      def("copy", "Ctrl + C", ["c"], { ctrl: true, planned: true }),
      def("paste", "Ctrl + V", ["v"], { ctrl: true, planned: true }),
      def("duplicate", "Ctrl + D", ["d"], { ctrl: true, planned: true }),
      def("selectAll", "Ctrl + A", ["a"], { ctrl: true, planned: true }),
      def("group", "Ctrl + G", ["g"], { ctrl: true, planned: true }),
      def("ungroup", "Ctrl + Shift + G", ["g"], { ctrl: true, shift: true, planned: true }),
      def("deselect", "Esc", ["escape"], { scope: "always" }),
    ],
  },
  {
    title: "Playback",
    items: [
      def("playPause", "Space", [" ", "spacebar"]),
      def("seekStart", "Ctrl + ←", ["arrowleft"], { ctrl: true }),
      def("seekEnd", "Ctrl + →", ["arrowright"], { ctrl: true }),
      def("seekBack", "←", ["arrowleft"]),
      def("seekForward", "→", ["arrowright"]),
      def("seekBackBig", "Shift + ←", ["arrowleft"], { shift: true }),
      def("seekForwardBig", "Shift + →", ["arrowright"], { shift: true }),
      def("volumeUp", "↑", ["arrowup"]),
      def("volumeDown", "↓", ["arrowdown"]),
      def("mute", "M", ["m"]),
      def("captions", "C", ["c"]),
      def("fullscreen", "F", ["f"]),
    ],
  },
  {
    title: "Zoom & navigation",
    items: [
      def("zoomIn", "Ctrl + =", ["=", "+", "add"], { ctrl: true }),
      def("zoomOut", "Ctrl + -", ["-", "_", "subtract"], { ctrl: true }),
      def("zoomFit", "Ctrl + 0", ["0"], { ctrl: true }),
      def("navRail", "Alt + 1", ["1"], { alt: true }),
      def("navSidebar", "Alt + 2", ["2"], { alt: true }),
      def("navTimeline", "Alt + 3", ["3"], { alt: true }),
      def("navStage", "Alt + 4", ["4"], { alt: true }),
      def("navPanel", "Alt + 5", ["5"], { alt: true }),
    ],
  },
  {
    // Clipchamp has no equivalent of these — they are T9's own, listed here
    // for the same reason as the rest: the sheet is generated from this table,
    // so anything the app honours is documented, and vice versa.
    title: "T9 modes",
    items: [
      def("modeCut", "Ctrl + 1", ["1"], { ctrl: true }),
      def("modePolish", "Ctrl + 2", ["2"], { ctrl: true }),
      def("modeExport", "Ctrl + 3", ["3"], { ctrl: true }),
    ],
  },
  {
    // T9's transcript ruling keys. They used to live in a private `keydown`
    // listener inside CutMode, which broke the "one dispatcher" rule — the
    // registry owns them now, so they survive mode isolation and the sheet
    // documents them.
    title: "Transcript (T9)",
    items: [def("cutLine", "X", ["x"]), def("keepLine", "V", ["v"])],
  },
];

/** Flat list for the matcher. */
const ALL: ShortcutDef[] = BINDINGS.flatMap((g) => g.items);

/** Tooltip text for a shortcut id — `null` when the id is undocumented. */
export function comboFor(id: string): string | null {
  return ALL.find((s) => s.id === id)?.combo ?? null;
}

function matches(event: KeyboardEvent, s: ShortcutDef): boolean {
  // On Windows, metaKey is the Windows key (used by Win+Shift+S, Win+V, etc.)
  // Never treat metaKey as Ctrl on Windows.
  if (event.metaKey) return false;
  if (!!s.ctrl !== event.ctrlKey) return false;
  // Shift must match exactly: leaving it out means "no modifier", so
  // Ctrl + Shift + Z cannot be swallowed by the plain Ctrl + Z binding.
  if ((s.shift ?? false) !== event.shiftKey) return false;
  if (!!s.alt !== event.altKey) return false;
  const key = event.key.toLowerCase();
  if (s.keys.includes(key)) return true;
  // Numpad keys report only `code` on some layouts.
  return s.keys.includes(event.code.toLowerCase());
}

export type ShortcutHandler = (event: KeyboardEvent) => void;

class ShortcutStore {
  /** Whether the `Ctrl + /` cheat sheet is on screen. */
  sheetOpen = $state(false);
  /** Total documented shortcuts, shown in the sheet header. */
  readonly count = ALL.length;
  /** Of those, how many are wired up rather than merely listed. */
  readonly plannedCount = ALL.filter((s) => s.planned === true).length;

  /** Documented and actually pressable. */
  get readyCount(): number {
    return this.count - this.plannedCount;
  }

  #handlers = new Map<string, ShortcutHandler>();
  #scope = new Map<string, ShortcutScope>();

  /**
   * Bind an action for the lifetime of the calling `$effect`.
   *
   * Registering the same id twice (e.g. two components mounted at once) keeps
   * the newest — the last one wins, which is what you want when a panel takes
   * over a key while it is on screen.
   */
  bind(id: string, handler: ShortcutHandler, scope: ShortcutScope = "editor"): () => void {
    this.#handlers.set(id, handler);
    this.#scope.set(id, scope);
    return () => {
      // Only remove ourselves: a newer registration may already own the id.
      if (this.#handlers.get(id) === handler) {
        this.#handlers.delete(id);
        this.#scope.delete(id);
      }
    };
  }

  /**
   * Single window `keydown` listener for every binding above.
   *
   * Keys are ignored while a text field has focus — Clipchamp does the same,
   * otherwise typing "s" into the rename box would split the clip.
   */
  handle(event: KeyboardEvent): void {
    // System shortcuts & screenshot keys must never be captured or blocked
    if (
      event.key === "PrintScreen" ||
      event.key === "Snapshot" ||
      event.metaKey ||
      event.key.startsWith("F")
    ) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    const typing =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target?.isContentEditable === true;

    // Escape and Ctrl + / still fire while typing: you must be able to close a
    // dialog or undo an accidental focus without leaving the field first.
    const alwaysReachable = event.key === "Escape" || (event.ctrlKey && event.key === "/");

    if (typing && !alwaysReachable) return;

    for (const s of ALL) {
      if (!matches(event, s)) continue;
      const handler = this.#handlers.get(s.id);
      if (!handler) continue;
      // Scope is enforced, not decoration: an `editor` binding belongs to the
      // screen that registers it, so it must not fire while Home is up (which
      // can happen the moment a panel outlives a `{#key}` swap).
      if (this.#scope.get(s.id) === "editor" && cc.view !== "editor") continue;
      event.preventDefault();
      handler(event);
      return;
    }
  }

  /** Open / close the cheat sheet — reachable by binding and by the UI. */
  toggleSheet(force?: boolean): void {
    this.sheetOpen = force ?? !this.sheetOpen;
  }

  closeSheet(): void {
    this.sheetOpen = false;
  }
}

export const shortcuts = new ShortcutStore();
