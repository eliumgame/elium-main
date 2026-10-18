/** Impression / « Enregistrer en PDF » d'un document HTML autonome (même convention que `export/exporters.ts`). */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texte multi-ligne → HTML (sauts de ligne conservés). */
export const escMultiline = (s: string): string => esc(s).replace(/\r?\n/g, "<br>");

export function printHtml(html: string): boolean {
  // Blob URL (origine opaque) plutôt que document.write : la fenêtre d'impression n'hérite pas de l'origine de l'app.
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const win = window.open(url, "_blank");
  if (!win) {
    URL.revokeObjectURL(url);
    return false;
  }
  win.addEventListener("load", () => {
    win.focus();
    win.print();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  return true;
}

export function safeStem(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "passeport"
  );
}
