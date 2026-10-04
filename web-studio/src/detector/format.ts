/** Mise en forme des dates : langue du document (`<html lang>`), français par défaut. */
export function documentLocale(): string {
  try {
    return (typeof document !== "undefined" && document.documentElement.lang) || "fr-FR";
  } catch {
    return "fr-FR";
  }
}

export function formatDateTime(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(documentLocale(), { dateStyle: "short", timeStyle: "medium" }).format(d);
  } catch {
    return d.toLocaleString("fr-FR");
  }
}
