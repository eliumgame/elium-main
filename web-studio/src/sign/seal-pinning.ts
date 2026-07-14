/**
 * Trust-on-first-use (TOFU) pinning of a document's seal key.
 *
 * The seal proves a document hasn't been tampered with, but on its own it
 * cannot tell you *who* sealed it: any attacker can re-seal a forged document
 * with their own key and it verifies as "valid" (just under a different key).
 *
 * TOFU closes that gap for documents you see repeatedly: the first time a
 * sealed document is opened we remember its seal public key; if a later version
 * of the *same* document presents a different seal key, we warn loudly.
 *
 * The pin is keyed by `createdAt`, which is part of the signed manifest subset
 * (so it is authenticated by the seal and stable across edits of one document).
 * A genuinely new document simply yields a "new" status — not a warning.
 */

import type { EliumManifest } from "../format/types";
import { docKeyOf } from "../format/doc-key";

const STORAGE_KEY = "elium_seal_pins";

export type SealPinStatus = "none" | "new" | "pinned" | "changed";

export interface SealPin {
  fingerprint: string;
  publicKeyHex: string;
  title: string;
  firstSeen: string;
}

export interface SealPinCheck {
  status: SealPinStatus;
  /** The previously pinned key (present for "pinned" and "changed"). */
  pinned?: SealPin;
  /** The seal key currently presented by the file (present unless "none"). */
  current?: { fingerprint: string; publicKeyHex: string };
}

function loadPins(): Record<string, SealPin> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, SealPin>;
  } catch {
    return {};
  }
}

function storePins(pins: Record<string, SealPin>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
}

function pinKey(manifest: EliumManifest): string | null {
  return manifest.seal ? `seal:${docKeyOf(manifest)}` : null;
}

/** Compare the file's seal key against any previously pinned key. */
export function checkSealPin(manifest: EliumManifest): SealPinCheck {
  const seal = manifest.seal;
  const key = pinKey(manifest);
  if (!seal || !key) return { status: "none" };
  const current = { fingerprint: seal.fingerprint, publicKeyHex: seal.publicKeyHex };
  const pinned = loadPins()[key];
  if (!pinned) return { status: "new", current };
  if (pinned.publicKeyHex.toLowerCase() === seal.publicKeyHex.toLowerCase()) {
    return { status: "pinned", pinned, current };
  }
  return { status: "changed", pinned, current };
}

/** Record (or refresh) the pin for this document's seal key. */
export function pinSeal(manifest: EliumManifest): void {
  const seal = manifest.seal;
  const key = pinKey(manifest);
  if (!seal || !key) return;
  const pins = loadPins();
  pins[key] = {
    fingerprint: seal.fingerprint,
    publicKeyHex: seal.publicKeyHex,
    title: manifest.title,
    firstSeen: pins[key]?.firstSeen ?? new Date().toISOString(),
  };
  storePins(pins);
}

/** Replace the pinned key with the one currently presented (user accepts the change). */
export function repinSeal(manifest: EliumManifest): void {
  const key = pinKey(manifest);
  if (!key) return;
  const pins = loadPins();
  delete pins[key];
  storePins(pins);
  pinSeal(manifest);
}

export function forgetSealPin(manifest: EliumManifest): void {
  const key = pinKey(manifest);
  if (!key) return;
  const pins = loadPins();
  delete pins[key];
  storePins(pins);
}
