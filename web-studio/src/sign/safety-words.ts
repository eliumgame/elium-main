/**
 * « Safety-words » : rend une empreinte (sha256 d'une clé publique, 64 hex) sous
 * forme de courte phrase mémorisable, pour qu'un humain PUISSE la comparer de
 * vive voix / hors-bande (personne ne compare 64 caractères hexadécimaux).
 *
 * Déterministe : mêmes octets → mêmes mots. On lit l'empreinte par groupes de
 * 6 bits (0-63) et on mappe sur une liste de 64 mots courts et distincts. Six
 * mots ≈ 36 bits — assez pour une comparaison visuelle fiable. Ce n'est PAS un
 * secret ; c'est une aide de comparaison de l'empreinte publique.
 */
import { fromHex } from "../format/canonical";

// 64 mots courts, concrets et phonétiquement distincts (fr).
const WORDS: readonly string[] = [
  "arbre", "aigle", "ancre", "avion", "bison", "brume", "balai", "banc",
  "cactus", "canard", "chaton", "cloche", "corde", "crabe", "cube", "dauphin",
  "datte", "delta", "dune", "encre", "étoile", "faucon", "flèche", "forêt",
  "fraise", "glace", "grain", "griffe", "harpe", "hérisson", "igloo", "île",
  "jade", "jardin", "koala", "lac", "lampe", "lierre", "loup", "lune",
  "mangue", "masque", "menthe", "miel", "navire", "neige", "noyau", "ombre",
  "orage", "ours", "panda", "perle", "phare", "pierre", "pomme", "prune",
  "renard", "rivière", "sable", "singe", "tigre", "tulipe", "vague", "zèbre",
];

/** Empreinte hex → `count` mots mémorisables (défaut 6 ≈ 36 bits). */
export function fingerprintWords(fingerprintHex: string, count = 6): string {
  if (!/^[0-9a-fA-F]+$/.test(fingerprintHex) || fingerprintHex.length % 2 !== 0) return "";
  let bytes: Uint8Array;
  try {
    bytes = fromHex(fingerprintHex);
  } catch {
    return "";
  }
  if (bytes.length === 0) return "";
  const out: string[] = [];
  let acc = 0;
  let bits = 0;
  let bi = 0;
  while (out.length < count) {
    while (bits < 6) {
      acc = (acc << 8) | (bytes[bi++] ?? 0);
      bits += 8;
    }
    bits -= 6;
    out.push(WORDS[(acc >>> bits) & 0x3f]!);
  }
  return out.join(" ");
}

export const SAFETY_WORD_COUNT = 64;
