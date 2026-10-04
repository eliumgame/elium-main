/**
 * Liste de confiance C2PA. La confiance se fonde UNIQUEMENT sur l'empreinte
 * SHA-256 d'un certificat (jamais sur un nom d'émetteur, trivialement
 * usurpable). Aucune liste officielle n'est embarquée : la liste de confiance
 * C2PA évolue et ne peut être récupérée hors ligne ; l'utilisateur importe les
 * racines de son choix (.pem / .cer / .crt) et elles sont conservées sur cet
 * appareil. Sans racine importée, une signature valide reste « émetteur non
 * reconnu ».
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { parseCertificate } from "../../pdf/ops/der";

export interface TrustAnchor {
  /** SHA-256 hexadécimal du certificat DER. */
  fingerprint: string;
  name: string;
}

/** Racines livrées avec l'application (vide : voir l'en-tête du module). */
export const BUNDLED_TRUST_ANCHORS: readonly TrustAnchor[] = [];

const STORAGE_KEY = "elium.detector.c2paTrust.v1";

export function fingerprintOf(der: Uint8Array): string {
  return Array.from(sha256(der), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extrait tous les certificats d'un fichier PEM ou d'un unique DER. */
export function parseCertificateFile(data: Uint8Array): Uint8Array[] {
  const text = new TextDecoder("latin1").decode(data);
  const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (blocks.length) {
    return blocks.map((m) => {
      const b64 = m[1]!.replace(/\s+/g, "");
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    });
  }
  parseCertificate(data); // lève si ce n'est pas un certificat DER
  return [data];
}

export function anchorsFromFile(data: Uint8Array): TrustAnchor[] {
  return parseCertificateFile(data).map((der) => ({
    fingerprint: fingerprintOf(der),
    name: parseCertificate(der).commonName,
  }));
}

export function loadUserAnchors(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): TrustAnchor[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is TrustAnchor =>
        !!a && typeof a.fingerprint === "string" && /^[0-9a-f]{64}$/.test(a.fingerprint) && typeof a.name === "string",
    );
  } catch {
    return [];
  }
}

export function saveUserAnchors(
  anchors: TrustAnchor[],
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  if (!storage) throw new Error("Stockage local indisponible : impossible d'enregistrer la liste de confiance.");
  storage.setItem(STORAGE_KEY, JSON.stringify(anchors));
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function allTrustAnchors(user = loadUserAnchors()): TrustAnchor[] {
  return [...BUNDLED_TRUST_ANCHORS, ...user];
}
