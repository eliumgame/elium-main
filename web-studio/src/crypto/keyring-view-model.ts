/**
 * Modèle de présentation de « Mes clés » : transforme une entrée du trousseau en
 * libellés français + gravité. Pur (pas de DOM, pas de React) pour être testé.
 */
import { effectiveStatus, type EffectiveStatus, type KeyEntry, type RecoveryChecklist } from "./keyring";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const TYPE_LABELS: Record<KeyEntry["type"], string> = {
  "identity-ed25519": "Signature (Ed25519)",
  "recipient-p256": "Réception (P-256)",
  contact: "Contact",
};

export const STATUS_LABELS: Record<EffectiveStatus, string> = {
  active: "Active",
  retired: "Retirée",
  revoked: "Révoquée",
  expired: "Expirée",
};

export const STATUS_TONES: Record<EffectiveStatus, Tone> = {
  active: "success",
  retired: "neutral",
  revoked: "danger",
  expired: "warning",
};

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("fr-FR");
};

export interface KeyRowModel {
  status: EffectiveStatus;
  statusLabel: string;
  statusTone: Tone;
  typeLabel: string;
  backupLabel: string;
  backupTone: Tone;
  expiryLabel: string | null;
  expiryTone: Tone;
  /** « Succède à … » lorsqu'un certificat de succession est attaché. */
  successionLabel: string | null;
  protectionLabel: string;
  /** Actions réellement pertinentes pour cette ligne. */
  can: { rotate: boolean; retire: boolean; reactivate: boolean; revoke: boolean; export: boolean };
}

const DAY = 86_400_000;

export function keyRowModel(e: KeyEntry, now: number = Date.now()): KeyRowModel {
  const status = effectiveStatus(e, now);
  let expiryLabel: string | null = null;
  let expiryTone: Tone = "neutral";
  if (e.expiresAt) {
    const ms = Date.parse(e.expiresAt) - now;
    if (ms <= 0) {
      expiryLabel = `Expirée le ${fmt(e.expiresAt)}`;
      expiryTone = "warning";
    } else {
      const days = Math.ceil(ms / DAY);
      expiryLabel = days <= 30 ? `Expire dans ${days} j (${fmt(e.expiresAt)})` : `Expire le ${fmt(e.expiresAt)}`;
      expiryTone = days <= 30 ? "warning" : "neutral";
    }
  }
  return {
    status,
    statusLabel: STATUS_LABELS[status],
    statusTone: STATUS_TONES[status],
    typeLabel: TYPE_LABELS[e.type],
    backupLabel: e.backedUpAt ? `Sauvegardée le ${fmt(e.backedUpAt)}` : "Non sauvegardée",
    backupTone: e.backedUpAt ? "success" : "warning",
    expiryLabel,
    expiryTone,
    successionLabel: e.succession ? `Succède à ${e.succession.oldPublicKeyHex.slice(0, 12)}… (${fmt(e.succession.issuedAt)})` : null,
    protectionLabel: e.protection === "derived" ? "Dérivée du secret maître" : "Protégée par son mot de passe",
    can: {
      rotate: e.status === "active" && e.type !== "contact",
      retire: e.status === "active",
      reactivate: e.status === "retired",
      revoke: e.status !== "revoked",
      export: e.type !== "contact",
    },
  };
}

export interface ChecklistItem {
  id: "backup" | "phrase" | "passkey";
  done: boolean;
  label: string;
  hint: string;
}

/** Les trois étapes de « Préparation à la récupération », dans l'ordre conseillé. */
export function checklistItems(c: RecoveryChecklist): ChecklistItem[] {
  return [
    {
      id: "backup",
      done: c.backupDone,
      label: "Sauvegarde .eliumkey effectuée",
      hint: "Un fichier chiffré de TOUTES vos clés, à ranger hors de cet appareil.",
    },
    {
      id: "phrase",
      done: c.phraseVerified,
      label: "Phrase de récupération vérifiée",
      hint: "24 mots notés sur papier, puis re-saisis partiellement pour prouver qu'ils sont lisibles.",
    },
    {
      id: "passkey",
      done: c.passkeyEnrolled,
      label: "Clé d'accès enrôlée",
      hint: "Windows Hello, Touch ID ou clé de sécurité : déverrouille sans taper le mot de passe.",
    },
  ];
}

export function checklistSummary(c: RecoveryChecklist): { tone: Tone; text: string } {
  if (c.score === 3) return { tone: "success", text: "Récupération prête : vous ne perdrez pas vos clés." };
  if (c.score === 0) return { tone: "danger", text: "Aucune protection contre la perte : une réinitialisation du navigateur détruirait vos clés." };
  return { tone: "warning", text: `Récupération partielle (${c.score}/3) : terminez la préparation.` };
}
