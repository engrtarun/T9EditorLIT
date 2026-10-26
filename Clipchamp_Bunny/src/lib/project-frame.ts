/**
 * The shape of a project — the four format cards in "Create New Project".
 *
 * Every value here is data or pure arithmetic, so the UI, the preview and the
 * export panel can agree on one table instead of each carrying its own magic
 * numbers.
 *
 * **16:9 is the source's own frame.** It deliberately has no canvas: keeping
 * the source shape is what lets the exporter stream-copy where the cut lands
 * on a keyframe, and forcing 1920×1080 onto a 1080p file would re-encode the
 * whole thing for nothing. Every other ratio is a real canvas — the exporter
 * letterboxes the picture into it, so what the preview shows is what the file
 * contains.
 */

export type ProjectFrame = '16:9' | '9:16' | '1:1' | '4:5' | '4:3';

export interface FramePreset {
  id: ProjectFrame;
  /** i18n key for the card's label. */
  label: string;
  /** `aspect-ratio` as a CSS value. */
  css: string;
  /** The same ratio as a number, for `calc()` in the preview. */
  value: number;
  /**
   * The export canvas, or `null` to keep the source shape.
   *
   * The short side is 1080 for every preset, so a vertical export is
   * 1080 × 1920 rather than an upscaled 4K one.
   */
  canvas: [number, number] | null;
}

export const FRAMES: FramePreset[] = [
  {
    id: '16:9',
    label: 'frame.yt',
    css: '16 / 9',
    value: 16 / 9,
    canvas: null
  },
  {
    id: '9:16',
    label: 'frame.shorts',
    css: '9 / 16',
    value: 9 / 16,
    canvas: [1080, 1920]
  },
  {
    id: '1:1',
    label: 'frame.square',
    css: '1 / 1',
    value: 1,
    canvas: [1080, 1080]
  },
  {
    id: '4:5',
    label: 'frame.portrait',
    css: '4 / 5',
    value: 4 / 5,
    canvas: [1080, 1350]
  },
  {
    id: '4:3',
    label: 'frame.classic',
    css: '4 / 3',
    value: 4 / 3,
    canvas: [1440, 1080]
  }
];

/** The presets the format row shows before "More formats" is opened. */
export const MAIN_FRAMES: ProjectFrame[] = ['16:9', '9:16', '1:1'];

/** The extras behind the "More formats" card. */
export const EXTRA_FRAMES: ProjectFrame[] = ['4:5', '4:3'];

/** The preset for one ratio. Unknown ids fall back to 16:9. */
export function framePreset(id: ProjectFrame | string | null | undefined): FramePreset {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0];
}

/** True when the ratio needs a canvas of its own (i.e. is not the source shape). */
export function needsCanvas(id: ProjectFrame | string | null | undefined): boolean {
  return framePreset(id).canvas !== null;
}

/** `[w, h]` for the exporter, or `null` when the source shape is kept. */
export function frameCanvas(id: ProjectFrame | string | null | undefined): [number, number] | null {
  return framePreset(id).canvas;
}
