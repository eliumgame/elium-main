/**
 * Protection par mot de passe des liens de partage — 100 % côté client (le
 * serveur ne voit JAMAIS le mot de passe ni le secret en clair).
 *
 * Rappel du modèle : un lien de partage porte, dans le FRAGMENT d'URL (`#…`,
 * jamais envoyé au serveur), le scalaire privé qui déchiffre la clé de contenu.
 * Quiconque a l'URL complète a donc l'accès. La protection par mot de passe
 * ajoute une seconde barrière : ce scalaire est CHIFFRÉ sous une clé dérivée du
 * mot de passe (PBKDF2-SHA-256 → AES-256-GCM). Le fragment ne contient plus que
 * le blob chiffré + le sel ; sans le mot de passe (transmis hors bande), l'URL
 * seule ne suffit pas. PBKDF2 via WebCrypto : pas de WASM, fonctionne partout.
 */
const PBKDF2_ITERATIONS = 310_000; // recommandation OWASP (SHA-256)
const enc = new TextEncoder();

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Chiffre le secret hex du lien sous le mot de passe. Rend `salt.iv.ct` en hex. */
export async function protectLinkSecret(password: string, secretHex: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, fromHex(secretHex) as BufferSource),
  );
  return `${toHex(salt)}.${toHex(iv)}.${toHex(ct)}`;
}

/**
 * Déchiffre le secret depuis `salt.iv.ct` avec le mot de passe. Lève si le mot
 * de passe est faux (AES-GCM rejette l'authentification) ou le blob malformé.
 */
export async function unprotectLinkSecret(password: string, blob: string): Promise<string> {
  const [saltHex, ivHex, ctHex] = blob.split(".");
  if (!saltHex || !ivHex || !ctHex) throw new Error("Lien protégé malformé.");
  const key = await deriveKey(password, fromHex(saltHex));
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(ivHex) as BufferSource },
      key,
      fromHex(ctHex) as BufferSource,
    ),
  );
  return toHex(pt);
}
