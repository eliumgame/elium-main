/**
 * Modèle du sélecteur de destinataires : transforme le carnet de confiance en
 * candidats sélectionnables (avec mots de sécurité), et bloque ceux dont la clé
 * est révoquée ou expirée. Pur — testé sans DOM.
 */
import { fingerprintWords } from "./safety-words";
import {
  isRecipientKeyHex,
  kindOf,
  levelOf,
  keyTrustState,
  normalizeKeyHex,
  TRUST_LEVEL_LABELS,
  type Revocation,
  type TrustedContact,
  type TrustLevel,
} from "./trust-book";

export interface RecipientCandidate {
  publicKeyHex: string;
  name: string;
  level: TrustLevel;
  levelLabel: string;
  words: string;
  /** Raison pour laquelle la clé ne peut pas être choisie (révoquée / expirée). */
  blockedReason?: string;
  /** Avertissement non bloquant (clé jamais vérifiée hors-bande). */
  warning?: string;
}

export function recipientCandidates(
  contacts: TrustedContact[],
  revocations: Revocation[],
  now: number = Date.now(),
): RecipientCandidate[] {
  return contacts
    .filter((c) => kindOf(c) === "recipient" && isRecipientKeyHex(c.publicKeyHex))
    .map((c) => {
      const st = keyTrustState(c.publicKeyHex, contacts, revocations, now);
      const level = levelOf(c);
      return {
        publicKeyHex: c.publicKeyHex,
        name: c.name,
        level,
        levelLabel: TRUST_LEVEL_LABELS[level],
        words: fingerprintWords(c.fingerprint),
        ...(st.revoked ? { blockedReason: "clé révoquée" } : st.expired ? { blockedReason: "clé expirée" } : {}),
        ...(level === "unverified" ? { warning: "empreinte jamais vérifiée" } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sélection courante nettoyée : retire les clés devenues bloquées ou inconnues. */
export function sanitizeSelection(selected: string[], candidates: RecipientCandidate[]): string[] {
  const ok = new Set(candidates.filter((c) => !c.blockedReason).map((c) => c.publicKeyHex));
  return selected.map(normalizeKeyHex).filter((k, i, a) => ok.has(k) && a.indexOf(k) === i);
}

export function toggleSelection(selected: string[], publicKeyHex: string): string[] {
  const k = normalizeKeyHex(publicKeyHex);
  return selected.includes(k) ? selected.filter((s) => s !== k) : [...selected, k];
}
