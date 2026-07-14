/**
 * Protection profiles.
 *
 * Protection is OPTIONAL. A profile is a *guided preset* that turns a set of
 * independent capabilities (encryption, locking, tracking, signature) on or
 * off. The user can always start from `standard` and add protections later.
 */

import type { EliumProfile } from "./types";

export interface ProfileDefinition {
  id: EliumProfile;
  label: string;
  short: string;
  description: string;
  /** Capabilities this profile turns on. */
  encrypted: boolean;
  passwordRequired: boolean;
  locked: boolean;
  tracking: boolean;
  /** Visual signatures are expected (not enforced). */
  signaturesExpected: boolean;
  badge: string;
  accent: "neutral" | "info" | "success" | "warning" | "danger";
}

export const PROFILES: Record<EliumProfile, ProfileDefinition> = {
  standard: {
    id: "standard",
    label: "Document simple",
    short: "Standard",
    description:
      "Document portable non chiffré. Aucune protection forte — il n'est pas confidentiel.",
    encrypted: false,
    passwordRequired: false,
    locked: false,
    tracking: false,
    signaturesExpected: false,
    badge: "Non protégé",
    accent: "neutral",
  },
  signed: {
    id: "signed",
    label: "Document signé",
    short: "Signé",
    description: "Signatures visuelles, empreinte du contenu et journal de suivi.",
    encrypted: false,
    passwordRequired: false,
    locked: false,
    tracking: true,
    signaturesExpected: true,
    badge: "Signé",
    accent: "info",
  },
  protected: {
    id: "protected",
    label: "Document privé",
    short: "Protégé",
    description: "Mot de passe d'ouverture requis. Le contenu est chiffré au repos.",
    encrypted: true,
    passwordRequired: true,
    locked: false,
    tracking: false,
    signaturesExpected: false,
    badge: "Protégé",
    accent: "info",
  },
  encrypted: {
    id: "encrypted",
    label: "Document confidentiel",
    short: "Chiffré",
    description: "Contenu chiffré (AES-256-GCM) et mot de passe obligatoire.",
    encrypted: true,
    passwordRequired: true,
    locked: false,
    tracking: false,
    signaturesExpected: false,
    badge: "Chiffré",
    accent: "warning",
  },
  locked: {
    id: "locked",
    label: "Document final",
    short: "Verrouillé",
    description: "Lecture seule, signature et détection de modification.",
    encrypted: false,
    passwordRequired: false,
    locked: true,
    tracking: true,
    signaturesExpected: true,
    badge: "Verrouillé",
    accent: "warning",
  },
  tracked: {
    id: "tracked",
    label: "Document suivi",
    short: "Suivi",
    description: "Journal de suivi intégré, chaîné par empreinte.",
    encrypted: false,
    passwordRequired: false,
    locked: false,
    tracking: true,
    signaturesExpected: false,
    badge: "Suivi",
    accent: "info",
  },
  secure_max: {
    id: "secure_max",
    label: "Document ultra sécurisé",
    short: "Sécurité max",
    description:
      "Chiffrement + keyfile optionnel + signature + verrouillage + suivi.",
    encrypted: true,
    passwordRequired: true,
    locked: true,
    tracking: true,
    signaturesExpected: true,
    badge: "Sécurité max",
    accent: "danger",
  },
};

export const PROFILE_ORDER: EliumProfile[] = [
  "standard",
  "signed",
  "tracked",
  "protected",
  "encrypted",
  "locked",
  "secure_max",
];

export function profileOf(id: EliumProfile): ProfileDefinition {
  return PROFILES[id];
}
