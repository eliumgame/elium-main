/** Nom de fichier sûr à partir d'un libellé libre. */
export function safeStem(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "passeport"
  );
}
