/** Number-format rendering for spreadsheet cells (fr-FR). */
import { isError, type CellValue } from "./formula";
import type { NumFmt } from "./model";

const nf = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat("fr-FR", opts);

const EPOCH = Date.UTC(1899, 11, 30); // Excel/Sheets serial-date epoch

function serialToDate(serial: number): string {
  const d = new Date(EPOCH + Math.round(serial) * 86400000);
  return Number.isNaN(d.getTime()) ? String(serial) : d.toLocaleDateString("fr-FR");
}

function serialToDateTime(serial: number): string {
  // Keep the fractional day (the time component, e.g. from NOW()).
  const d = new Date(EPOCH + Math.round(serial * 86400000));
  return Number.isNaN(d.getTime())
    ? String(serial)
    : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function formatNumber(n: number, fmt: NumFmt): string {
  switch (fmt) {
    case "int":
      return nf({ maximumFractionDigits: 0 }).format(Math.round(n));
    case "number":
      return nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    case "currency":
      return nf({ style: "currency", currency: "EUR" }).format(n);
    case "percent":
      return nf({ style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
    case "date":
      return serialToDate(n);
    case "datetime":
      return serialToDateTime(n);
    default:
      return String(n);
  }
}

/**
 * Render a computed cell value under a number format. `fallback` is the engine's
 * default display (used for "general" or non-numeric values).
 */
export function formatValue(v: CellValue, fmt: NumFmt | undefined, fallback: string): string {
  if (isError(v)) return v.error;
  if (!fmt || fmt === "general") return fallback;
  if (typeof v === "number") return formatNumber(v, fmt);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return formatNumber(n, fmt);
  }
  return fallback;
}

export const NUM_FORMATS: { value: NumFmt; label: string }[] = [
  { value: "general", label: "Automatique" },
  { value: "number", label: "Nombre (0,00)" },
  { value: "int", label: "Entier" },
  { value: "currency", label: "Devise (€)" },
  { value: "percent", label: "Pourcentage" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date et heure" },
];
