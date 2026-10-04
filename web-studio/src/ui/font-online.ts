/**
 * Catalogue de polices EN LIGNE (optionnel — Elium reste 100 % utilisable hors
 * connexion). Source : Fontsource (api.fontsource.org + cdn.jsdelivr.net),
 * polices libres (OFL / Apache). Rien n'est envoyé hors de l'appareil à part le
 * nom de la police demandée.
 *
 * Sur le bureau, la CSP interdit à la page tout accès externe : le lanceur
 * relaie les requêtes (POST /__fetch_font__) sur une liste blanche fermée. Dans
 * un navigateur ordinaire (PWA), on tente directement le même hôte.
 */
import type { FontInput } from "./font-library";

export const CATALOG_URL = "https://api.fontsource.org/v1/fonts";
const FONT_URL = (id: string) => `https://api.fontsource.org/v1/fonts/${encodeURIComponent(id)}`;

const CATALOG_KEY = "elium_font_catalog_v1";
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;

export interface OnlineFont {
  id: string;
  family: string;
  category: string;
  weights: number[];
  styles: string[];
  defSubset: string;
  license: string;
}

interface CatalogCache {
  at: number;
  fonts: OnlineFont[];
}

// --- transport -------------------------------------------------------------

function launcherToken(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="elium-token"]')?.content ?? null;
}

export class OfflineError extends Error {
  constructor(message = "Connexion à Internet impossible. Vérifiez votre réseau, puis réessayez.") {
    super(message);
    this.name = "OfflineError";
  }
}

/** Télécharge `url` via le relais du lanceur (bureau) ou directement (navigateur). */
export async function fetchOnline(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const token = launcherToken();
  if (token) {
    let res: Response | undefined;
    try {
      res = await fetch("/__fetch_font__", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Elium-Token": token },
        body: JSON.stringify({ url }),
        signal,
      });
    } catch {
      throw new OfflineError();
    }
    if (res.ok) return res.arrayBuffer();
    if (res.status === 502) throw new OfflineError();
    if (res.status === 429) throw new Error("Trop de requêtes : patientez quelques secondes.");
    if (res.status !== 404 && res.status !== 501) throw new Error(`Téléchargement refusé (${res.status}).`);
    // 404 : lanceur plus ancien sans relais → essai direct ci-dessous (bloqué par sa CSP, d'où le message).
  }
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Téléchargement refusé (${res.status}).`);
    return res.arrayBuffer();
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    if (e instanceof Error && /refusé/.test(e.message)) throw e;
    throw new OfflineError(
      token
        ? "Cette version du lanceur ne permet pas encore le téléchargement de polices : mettez Elium à jour."
        : undefined,
    );
  }
}

// --- catalogue -------------------------------------------------------------

/** Réduit la réponse Fontsource aux champs utiles (le brut pèse ~600 Ko). Pur. */
export function parseCatalog(raw: unknown): OnlineFont[] {
  if (!Array.isArray(raw)) return [];
  const out: OnlineFont[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.id !== "string" || typeof r.family !== "string") continue;
    const weights = Array.isArray(r.weights) ? r.weights.filter((w): w is number => typeof w === "number") : [];
    if (!weights.length) continue;
    out.push({
      id: r.id,
      family: r.family,
      category: typeof r.category === "string" ? r.category : "autre",
      weights,
      styles: Array.isArray(r.styles) ? r.styles.filter((s): s is string => typeof s === "string") : ["normal"],
      defSubset: typeof r.defSubset === "string" ? r.defSubset : "latin",
      license: typeof r.license === "string" ? r.license : "",
    });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family, "en", { sensitivity: "base" }));
}

function readCache(): CatalogCache | null {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    const c = raw ? (JSON.parse(raw) as CatalogCache) : null;
    return c && Array.isArray(c.fonts) && typeof c.at === "number" ? c : null;
  } catch {
    return null;
  }
}

/** Catalogue en cache 7 jours ; en cas d'échec réseau, la copie périmée vaut mieux que rien. */
export async function loadCatalog(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{
  fonts: OnlineFont[];
  stale: boolean;
}> {
  const cached = readCache();
  if (cached && !opts.refresh && Date.now() - cached.at < CATALOG_TTL_MS) return { fonts: cached.fonts, stale: false };
  try {
    const buf = await fetchOnline(CATALOG_URL, opts.signal);
    const fonts = parseCatalog(JSON.parse(new TextDecoder().decode(buf)));
    if (!fonts.length) throw new Error("Catalogue vide ou illisible.");
    try {
      localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), fonts } satisfies CatalogCache));
    } catch {
      /* quota : le catalogue sera simplement re-téléchargé */
    }
    return { fonts, stale: false };
  } catch (e) {
    if (cached) return { fonts: cached.fonts, stale: true };
    throw e;
  }
}

// --- variantes d'une famille ------------------------------------------------

export interface PlannedVariant {
  url: string;
  /** Nom affiché dans les sélecteurs (« Lobster », « Roboto Bold Italic »…). */
  name: string;
}

const WEIGHT_WORDS: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export function variantName(family: string, weight: number, style: string): string {
  const w = weight === 400 ? "" : (WEIGHT_WORDS[weight] ?? String(weight));
  const s = style === "italic" ? "Italic" : "";
  return [family, w, s].filter(Boolean).join(" ");
}

interface FontDetail {
  family: string;
  defSubset?: string;
  variants?: Record<string, Record<string, Record<string, { url?: { woff2?: string } }>>>;
}

/**
 * Choisit quoi télécharger : normal + gras, droit + italique (ce qui existe),
 * sous-ensemble latin (ou celui par défaut de la famille). Si ni 400 ni 700
 * n'existent, la graisse la plus proche de 400. Pur.
 */
export function planVariants(detail: FontDetail, opts: { extraWeights?: number[] } = {}): PlannedVariant[] {
  const variants = detail.variants ?? {};
  const available = Object.keys(variants)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!available.length) return [];
  let wanted = [400, 700, ...(opts.extraWeights ?? [])].filter((w) => available.includes(w));
  if (!wanted.length) {
    const nearest = available.reduce((best, w) => (Math.abs(w - 400) < Math.abs(best - 400) ? w : best));
    wanted = [nearest];
  }
  const out: PlannedVariant[] = [];
  for (const weight of [...new Set(wanted)].sort((a, b) => a - b)) {
    for (const style of ["normal", "italic"]) {
      const subsets = variants[String(weight)]?.[style];
      if (!subsets) continue;
      const subset = subsets.latin ? "latin" : (detail.defSubset ?? Object.keys(subsets)[0]!);
      const url = subsets[subset]?.url?.woff2;
      if (typeof url === "string") out.push({ url, name: variantName(detail.family, weight, style) });
    }
  }
  return out;
}

/** Télécharge une famille (métadonnées puis fichiers) et renvoie des entrées prêtes pour `importFonts`. */
export async function downloadFamily(
  font: OnlineFont,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<FontInput[]> {
  const detailBuf = await fetchOnline(FONT_URL(font.id), opts.signal);
  const detail = JSON.parse(new TextDecoder().decode(detailBuf)) as FontDetail;
  const plan = planVariants({ ...detail, family: font.family });
  if (!plan.length) throw new Error(`Aucun fichier de police disponible pour « ${font.family} ».`);
  const out: FontInput[] = [];
  for (let i = 0; i < plan.length; i++) {
    opts.onProgress?.(i, plan.length);
    const bytes = new Uint8Array(await fetchOnline(plan[i]!.url, opts.signal));
    out.push({ filename: `${plan[i]!.name}.woff2`, bytes, source: "en ligne" });
  }
  opts.onProgress?.(plan.length, plan.length);
  return out;
}
