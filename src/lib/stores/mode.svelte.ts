/**
 * Mode-Based Panel Isolation.
 *
 * The central architectural rule of this app. Only ONE mode is resident at a
 * time; switching modes destroys the previous mode's component tree so the
 * WebView releases its DOM and the Rust side can kill any worker processes.
 *
 * This is what makes an 8 GB machine survivable. CapCut and Premiere keep the
 * timeline, transcript, colour engine, audio mixer and font cache all live
 * simultaneously — we never do.
 */

export type Mode = "cut" | "polish";

export interface ModeDescriptor {
  id: Mode;
  label: string;
  hint: string;
  /** Short description of what stays resident while this mode is active. */
  resident: string;
}

export const MODES: ModeDescriptor[] = [
  {
    id: "cut",
    label: "Cut",
    hint: "Transcript & Cut",
    resident: "Video preview · waveform · ✓/✕ transcript",
  },
  {
    id: "polish",
    label: "Polish",
    hint: "Music & Text",
    resident: "Music deck · text/pipeline panel",
  },
];

class ModeStore {
  current = $state<Mode>("cut");
  previous = $state<Mode | null>(null);
  /** Increments on every switch. Components can watch this to flush caches. */
  switchCount = $state(0);

  get descriptor(): ModeDescriptor {
    return MODES.find((m) => m.id === this.current) ?? MODES[0]!;
  }

  set(next: Mode): void {
    if (next === this.current) return;
    this.previous = this.current;
    this.current = next;
    this.switchCount += 1;
  }

  toggle(): void {
    this.set(this.current === "cut" ? "polish" : "cut");
  }
}

export const mode = new ModeStore();
