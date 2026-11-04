/**
 * Épinglage TOFU (« confiance au premier usage ») des clés publiques servies par le serveur Drive.
 *
 * Le client emballe des clés de nœud (CEK) et des clés privées d'équipe vers des clés publiques que
 * SEUL le serveur lui fournit (utilisateurs, équipes, organisation). Un serveur compromis pourrait
 * substituer sa propre clé. Sans infrastructure de certification, on applique le modèle SSH/Signal :
 *   - la première clé vue pour une identité est mémorisée localement (épinglée) ;
 *   - si le serveur en présente ensuite une AUTRE, une alerte visible est levée (l'utilisateur
 *     compare l'empreinte hors bande puis confirme), et tout emballage est bloqué ;
 *   - l'empreinte (mots de sécurité) est affichable pour une vérification de vive voix.
 *
 * Les rotations LÉGITIMES faites depuis ce navigateur (clé d'équipe, clé d'organisation) mettent
 * l'épingle à jour via `pinKey` pour ne pas lever de fausse alerte.
 */
import { recipientFingerprint } from "../crypto/recipients";
import { fingerprintWords } from "../sign/safety-words";

export type PinKind = "user" | "group" | "org";

export interface KeyPinAlert {
  kind: PinKind;
  id: string;
  /** Libellé lisible (e-mail, nom d'équipe…) quand il est connu. */
  label?: string;
  pinnedHex: string;
  presentedHex: string;
  at: number;
}

export interface KeyPinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "elium.drive.keyPins.v1";

function memoryStorage(): KeyPinStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function defaultStorage(): KeyPinStorage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* stockage interdit (navigation privée stricte) */
  }
  return memoryStorage();
}

let storage: KeyPinStorage | null = null;
const st = (): KeyPinStorage => (storage ??= defaultStorage());
const alerts = new Map<string, KeyPinAlert>();
const listeners = new Set<(alerts: KeyPinAlert[]) => void>();

/** Tests : remplacer le stockage (et repartir de zéro). */
export function setKeyPinStorage(s: KeyPinStorage | null): void {
  storage = s ?? memoryStorage();
  alerts.clear();
  notices.clear();
  emit();
  emitNotices();
}

const pinId = (kind: PinKind, id: string) => `${kind}:${id}`;

function readPins(): Record<string, string> {
  try {
    const raw = st().getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writePins(p: Record<string, string>): void {
  try {
    st().setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* quota / stockage indisponible : l'épinglage reste valable pour cette lecture seulement */
  }
}

function emit(): void {
  const list = [...alerts.values()];
  for (const l of listeners) {
    try {
      l(list);
    } catch {
      /* un écouteur défaillant n'empêche pas les autres */
    }
  }
}

const norm = (hex: string) => hex.trim().toLowerCase();

/**
 * Vérifie une clé présentée par le serveur contre l'épingle locale.
 * - `new`     : jamais vue → épinglée maintenant ;
 * - `match`   : identique à l'épingle ;
 * - `changed` : différente → alerte levée (l'épingle d'origine est CONSERVÉE jusqu'à confirmation).
 */
export function checkKeyPin(
  kind: PinKind,
  id: string,
  publicHex: string,
  label?: string,
): { status: "new" | "match" | "changed"; pinnedHex?: string } {
  if (!id || !publicHex) return { status: "match" };
  const pins = readPins();
  const k = pinId(kind, id);
  const presented = norm(publicHex);
  const pinned = pins[k];
  if (!pinned) {
    pins[k] = presented;
    writePins(pins);
    return { status: "new" };
  }
  if (pinned === presented) return { status: "match", pinnedHex: pinned };
  const prev = alerts.get(k);
  if (!prev || prev.presentedHex !== presented) {
    alerts.set(k, {
      kind,
      id,
      ...(label ? { label } : prev?.label ? { label: prev.label } : {}),
      pinnedHex: pinned,
      presentedHex: presented,
      at: Date.now(),
    });
    emit();
  }
  return { status: "changed", pinnedHex: pinned };
}

/** Destinataire vu pour la PREMIÈRE fois (épinglé sans vérification d'empreinte) : signalé à l'utilisateur. */
export interface KeyPinNotice {
  kind: PinKind;
  id: string;
  label?: string;
  publicHex: string;
  at: number;
}

const notices = new Map<string, KeyPinNotice>();
const noticeListeners = new Set<(notices: KeyPinNotice[]) => void>();

function emitNotices(): void {
  const list = [...notices.values()];
  for (const l of noticeListeners) {
    try {
      l(list);
    } catch {
      /* un écouteur défaillant n'empêche pas les autres */
    }
  }
}

export function keyPinNotices(): KeyPinNotice[] {
  return [...notices.values()];
}

export function onKeyPinNotices(fn: (notices: KeyPinNotice[]) => void): () => void {
  noticeListeners.add(fn);
  return () => void noticeListeners.delete(fn);
}

/** Ferme l'avis (vérifié ou ignoré par l'utilisateur) ; l'épingle reste. */
export function dismissKeyPinNotice(kind: PinKind, id: string): void {
  if (notices.delete(pinId(kind, id))) emitNotices();
}

/** `true` si une clé est déjà épinglée pour cette identité. */
export function isKeyPinned(kind: PinKind, id: string): boolean {
  return !!readPins()[pinId(kind, id)];
}

const PUBLIC_HEX = /^(04[0-9a-f]{128}|0[23][0-9a-f]{64})$/i;

/**
 * No key material may be sent to a changed recipient until explicitly verified.
 * Une clé JAMAIS vue est épinglée (confiance au premier usage) ET signalée par un avis visible
 * (`keyPinNotices`) plutôt qu'acceptée en silence ; `notifyNew: false` pour les appelants qui l'ont déjà fait.
 */
export function requireKeyPin(
  kind: PinKind,
  id: string,
  publicHex: string,
  label?: string,
  opts: { notifyNew?: boolean } = {},
): void {
  if (!PUBLIC_HEX.test(publicHex)) throw new Error("Clé publique Drive invalide.");
  const status = checkKeyPin(kind, id, publicHex, label).status;
  if (status === "changed")
    throw new Error(
      `Clé ${PIN_KIND_LABEL[kind]} modifiée (${label ?? id}). Vérifiez les mots de sécurité dans Sécurité avant de continuer.`,
    );
  if (status === "new" && opts.notifyNew !== false) {
    notices.set(pinId(kind, id), { kind, id, ...(label ? { label } : {}), publicHex: norm(publicHex), at: Date.now() });
    emitNotices();
  }
}

export interface FirstUseFingerprint {
  kind: PinKind;
  id: string;
  label?: string;
  words: string;
  grouped: string;
}

/**
 * Partage direct vers une personne jamais épinglée : l'empreinte doit être confirmée (hors bande) avant
 * d'emballer la moindre clé. `confirm` est une boîte de dialogue ANNULABLE (refus = erreur, pas de blocage
 * définitif : on peut réessayer). Sans `confirm` (appel non interactif), repli sur épinglage + avis visible.
 */
export async function requireKeyPinConfirmed(
  kind: PinKind,
  id: string,
  publicHex: string,
  label?: string,
  confirm?: (fp: FirstUseFingerprint) => Promise<boolean>,
): Promise<void> {
  if (!PUBLIC_HEX.test(publicHex)) throw new Error("Clé publique Drive invalide.");
  if (isKeyPinned(kind, id) || !confirm) return requireKeyPin(kind, id, publicHex, label);
  const fp = await keyFingerprint(publicHex);
  if (!(await confirm({ kind, id, ...(label ? { label } : {}), words: fp.words, grouped: fp.grouped })))
    throw new Error(`Partage annulé : l'empreinte ${PIN_KIND_LABEL[kind]} (${label ?? id}) n'a pas été confirmée.`);
  pinKey(kind, id, publicHex);
}

/** Épingle (ou ré-épingle) explicitement une clé : rotation légitime faite ici, ou confirmation. */
export function pinKey(kind: PinKind, id: string, publicHex: string): void {
  const pins = readPins();
  pins[pinId(kind, id)] = norm(publicHex);
  writePins(pins);
  if (alerts.delete(pinId(kind, id))) emit();
  if (notices.delete(pinId(kind, id))) emitNotices();
}

/** L'utilisateur a vérifié la nouvelle empreinte hors bande : on l'adopte. */
export function acceptKeyChange(kind: PinKind, id: string): void {
  const a = alerts.get(pinId(kind, id));
  if (a) pinKey(kind, id, a.presentedHex);
}

export function keyPinAlerts(): KeyPinAlert[] {
  return [...alerts.values()];
}

export function onKeyPinAlerts(fn: (alerts: KeyPinAlert[]) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Empreinte vérifiable d'une clé publique : SHA-256 (hex groupé, 128 premiers bits) + 6 mots de sécurité. */
export async function keyFingerprint(publicHex: string): Promise<{ hex: string; grouped: string; words: string }> {
  const hex = await recipientFingerprint(publicHex);
  const grouped = (hex.slice(0, 32).match(/.{4}/g) ?? []).join(" ").toUpperCase();
  return { hex, grouped, words: fingerprintWords(hex) };
}

export const PIN_KIND_LABEL: Record<PinKind, string> = {
  user: "de l'utilisateur",
  group: "de l'équipe",
  org: "de l'organisation",
};
