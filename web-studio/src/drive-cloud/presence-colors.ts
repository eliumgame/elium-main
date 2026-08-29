/**
 * Deterministic per-user colour/initials for live presence (cursors, peer
 * badges). Shared so the Tableur and Présentations collab stores can't drift
 * — they used to each keep their own copy of the same palette and hash.
 */
const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];

export const colorForId = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
};

export const initialsOf = (s: string): string => {
  const p = s.split(/[@\s.]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
};
