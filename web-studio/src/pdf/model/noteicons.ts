/**
 * The seven sticky-note icons of ISO 32000 (`/Name` of a Text annotation),
 * drawn once here in a unit square (top-left origin, y down) so the screen
 * (SVG) and the file's appearance (`paintNoteIcon`) show the same picture.
 */

export type NoteShape =
  | { t: "rrect"; x: number; y: number; w: number; h: number; r: number; fill: boolean }
  | { t: "poly"; pts: [number, number][]; close: boolean; fill: boolean }
  | { t: "circle"; cx: number; cy: number; r: number; fill: boolean }
  | { t: "glyph"; text: string; x: number; y: number; size: number };

const lines = (ys: number[], x0: number, x1: number): NoteShape[] =>
  ys.map(
    (y) =>
      ({
        t: "poly",
        pts: [
          [x0, y],
          [x1, y],
        ],
        close: false,
        fill: false,
      }) as NoteShape,
  );

export const NOTE_ICONS: Record<string, NoteShape[]> = {
  Comment: [
    { t: "rrect", x: 0, y: 0.08, w: 1, h: 0.72, r: 0.16, fill: true },
    {
      t: "poly",
      pts: [
        [0.24, 0.79],
        [0.2, 1],
        [0.46, 0.79],
      ],
      close: true,
      fill: true,
    },
    ...lines([0.28, 0.44], 0.16, 0.84),
    ...lines([0.6], 0.16, 0.62),
  ],
  Note: [
    {
      t: "poly",
      pts: [
        [0.14, 0],
        [0.66, 0],
        [0.86, 0.2],
        [0.86, 1],
        [0.14, 1],
      ],
      close: true,
      fill: true,
    },
    {
      t: "poly",
      pts: [
        [0.66, 0],
        [0.66, 0.2],
        [0.86, 0.2],
      ],
      close: false,
      fill: false,
    },
    ...lines([0.38, 0.54, 0.7], 0.26, 0.74),
    ...lines([0.86], 0.26, 0.56),
  ],
  Help: [
    { t: "circle", cx: 0.5, cy: 0.5, r: 0.47, fill: true },
    { t: "glyph", text: "?", x: 0.5, y: 0.78, size: 0.72 },
  ],
  Insert: [
    {
      t: "poly",
      pts: [
        [0.08, 0.92],
        [0.5, 0.1],
        [0.92, 0.92],
        [0.5, 0.66],
      ],
      close: true,
      fill: true,
    },
  ],
  Key: [
    { t: "circle", cx: 0.3, cy: 0.32, r: 0.24, fill: true },
    { t: "circle", cx: 0.3, cy: 0.32, r: 0.08, fill: false },
    {
      t: "poly",
      pts: [
        [0.46, 0.48],
        [0.92, 0.94],
      ],
      close: false,
      fill: false,
    },
    {
      t: "poly",
      pts: [
        [0.7, 0.72],
        [0.82, 0.6],
      ],
      close: false,
      fill: false,
    },
    {
      t: "poly",
      pts: [
        [0.8, 0.82],
        [0.92, 0.7],
      ],
      close: false,
      fill: false,
    },
  ],
  NewParagraph: [
    {
      t: "poly",
      pts: [
        [0.14, 0.46],
        [0.5, 0.02],
        [0.86, 0.46],
      ],
      close: true,
      fill: true,
    },
    { t: "glyph", text: "¶", x: 0.5, y: 0.98, size: 0.56 },
  ],
  Paragraph: [
    { t: "circle", cx: 0.5, cy: 0.5, r: 0.47, fill: true },
    { t: "glyph", text: "¶", x: 0.5, y: 0.8, size: 0.7 },
  ],
};

export function noteIcon(name: string | undefined): NoteShape[] {
  return NOTE_ICONS[name ?? "Comment"] ?? NOTE_ICONS.Comment;
}
