/**
 * Local store for the user's persistent P-256 "recipient key" — the keypair
 * that lets others encrypt documents TO this user (multi-recipient). Mirrors the
 * Ed25519 identity store: the private scalar is encrypted at rest (Argon2id +
 * AES-256-GCM) and only decrypted on demand with a password; the public key and
 * fingerprint are stored in clear so the user can share/display them.
 *
 * Separate from the signing identity: signing (Ed25519) and encryption-receipt
 * (P-256) are distinct roles, and keeping them apart avoids a format change to
 * the existing identity / .eliumkey backup.
 */
import { encryptPrivateKey, decryptPrivateKey } from "../sign/identity-store";
import { generateRecipientKeypair, recipientFingerprint, type RecipientKeypair } from "./recipients";

const STORAGE_KEY = "elium_recipient_key";

interface StoredRecipientKey {
  publicHex: string;
  fingerprint: string;
  enc: string; // Argon2id/AES-GCM-encrypted private scalar (hex container)
}

export interface RecipientPublic {
  publicHex: string;
  fingerprint: string;
}

export function loadRecipientPublic(): RecipientPublic | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredRecipientKey>;
    if (s.publicHex && s.fingerprint) return { publicHex: s.publicHex, fingerprint: s.fingerprint };
  } catch {
    /* corrupt entry */
  }
  return null;
}

export function hasRecipientKey(): boolean {
  return !!localStorage.getItem(STORAGE_KEY);
}

/** Generate a fresh recipient keypair, encrypt the private scalar, persist it. */
export async function generateAndStoreRecipientKey(password: string): Promise<RecipientPublic> {
  const kp = await generateRecipientKeypair();
  const enc = await encryptPrivateKey(kp.privateHex, password);
  const fingerprint = await recipientFingerprint(kp.publicHex);
  const stored: StoredRecipientKey = { publicHex: kp.publicHex, fingerprint, enc };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return { publicHex: kp.publicHex, fingerprint };
}

/** Decrypt the stored recipient private key with the password. */
export async function unlockRecipientKey(password: string): Promise<RecipientKeypair> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("Aucune clé de réception sur ce navigateur.");
  const s = JSON.parse(raw) as StoredRecipientKey;
  const privateHex = await decryptPrivateKey(s.enc, password);
  return { privateHex, publicHex: s.publicHex };
}

export function forgetRecipientKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
