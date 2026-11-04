/**
 * Connexion SSO (OIDC, flux implicite `response_type=id_token`) — logique PURE, sans DOM ni réseau.
 *
 * Le SSO prouve l'identité ; il ne déverrouille aucune clé : après `ssoVerify`, la session reste
 * « verrouillée » et l'utilisateur ouvre son trousseau avec sa phrase de passe ou sa clé d'accès.
 * L'id_token voyage dans le FRAGMENT de l'URL (jamais envoyé à un serveur) et est effacé de
 * l'historique dès sa lecture.
 */

export const SSO_STATE_KEY = "elium.sso.pending";
const MAX_AGE_MS = 10 * 60 * 1000;

/** Configuration publique de l'IdP (jamais de secret : flux implicite, pas de client_secret). */
export interface SsoPublicConfig {
  orgId: string;
  issuer: string;
  clientId: string;
}

/** Contexte conservé en sessionStorage entre la redirection et le retour. */
export interface PendingSso {
  state: string;
  nonce: string;
  orgId: string;
  createdAt: number;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Valeur aléatoire URL-safe (injectable pour les tests). */
export function randomState(bytes = 24, rng: (n: number) => Uint8Array = defaultRng): string {
  const b = rng(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function defaultRng(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL de découverte OIDC d'un émetteur (sans double slash). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/** Valide le document de découverte et en extrait l'`authorization_endpoint` (https obligatoire, issuer concordant). */
export function authorizationEndpointFrom(doc: unknown, issuer: string): string {
  const d = doc as { issuer?: unknown; authorization_endpoint?: unknown } | null;
  if (!d || typeof d !== "object") throw new Error("Document de découverte OIDC invalide.");
  const norm = (s: string) => s.replace(/\/+$/, "");
  if (typeof d.issuer !== "string" || norm(d.issuer) !== norm(issuer)) {
    throw new Error("L'émetteur annoncé par le fournisseur ne correspond pas à la configuration.");
  }
  if (typeof d.authorization_endpoint !== "string") throw new Error("authorization_endpoint absent.");
  let u: URL;
  try {
    u = new URL(d.authorization_endpoint);
  } catch {
    throw new Error("authorization_endpoint invalide.");
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("authorization_endpoint doit être en https.");
  return u.toString();
}

/** Construit l'URL d'autorisation (implicite, id_token seul). `redirectUri` = origine de l'application. */
export function buildAuthorizationUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const u = new URL(opts.authorizationEndpoint);
  u.searchParams.set("response_type", "id_token");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("nonce", opts.nonce);
  u.searchParams.set("response_mode", "fragment");
  return u.toString();
}

export interface SsoFragment {
  idToken: string | null;
  state: string | null;
  error: string | null;
}

/** Lit un fragment d'URL (`#id_token=…&state=…` ou `#error=…`). Retourne null si ce n'est pas un retour SSO. */
export function parseSsoFragment(hash: string): SsoFragment | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  if (!p.has("id_token") && !p.has("error")) return null;
  return { idToken: p.get("id_token"), state: p.get("state"), error: p.get("error_description") ?? p.get("error") };
}

export function savePending(storage: StorageLike, p: PendingSso): void {
  storage.setItem(SSO_STATE_KEY, JSON.stringify(p));
}

export function readPending(storage: StorageLike): PendingSso | null {
  try {
    const v = JSON.parse(storage.getItem(SSO_STATE_KEY) ?? "null") as PendingSso | null;
    if (v && typeof v.state === "string" && typeof v.nonce === "string" && typeof v.orgId === "string") return v;
  } catch {
    /* ignoré */
  }
  return null;
}

export function clearPending(storage: StorageLike): void {
  storage.removeItem(SSO_STATE_KEY);
}

/**
 * Valide un retour SSO contre le contexte stocké (usage unique : le contexte est effacé quel que soit le résultat).
 * Lève une Error au message affichable si `state` manque/diffère, si le contexte a expiré ou si l'IdP a renvoyé une erreur.
 */
export function consumeSsoReturn(
  frag: SsoFragment,
  storage: StorageLike,
  now = Date.now(),
): { idToken: string; nonce: string; orgId: string } {
  const pending = readPending(storage);
  clearPending(storage);
  if (!pending) throw new Error("Aucune connexion SSO en cours : relancez-la depuis l'écran de connexion.");
  if (now - pending.createdAt > MAX_AGE_MS) throw new Error("La connexion SSO a expiré : recommencez.");
  if (!frag.state || !constantTimeEqual(frag.state, pending.state)) {
    throw new Error("Réponse SSO rejetée (état invalide).");
  }
  if (frag.error) throw new Error(`Le fournisseur d'identité a refusé la connexion : ${frag.error}`);
  if (!frag.idToken) throw new Error("Réponse SSO sans jeton d'identité.");
  return { idToken: frag.idToken, nonce: pending.nonce, orgId: pending.orgId };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
