/**
 * Phrase de récupération de 24 mots (BIP-39, liste anglaise officielle) qui code
 * le SECRET MAÎTRE du trousseau (256 bits d'entropie + 8 bits de somme de
 * contrôle = 24 mots). Comme toutes les clés d'Elium créées par le trousseau en
 * DÉRIVENT (crypto/keyring-derive.ts), cette seule phrase suffit à retrouver
 * identité de signature et clé de réception sur une machine vierge.
 *
 * Choix de la liste anglaise : c'est celle que tout outil BIP-39 reconnaît ;
 * la phrase reste lisible/utilisable même sans Elium. Les clés héritées
 * (aléatoires, non dérivées) ne sont PAS couvertes : elles restent sauvegardées
 * par le fichier `.eliumkey`.
 *
 * Saisie tolérante : casse, espaces multiples, retours à la ligne, numérotation
 * (« 1. abandon ») acceptés ; somme de contrôle vérifiée.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export class RecoveryPhraseError extends Error {}

export function masterToPhrase(master: Uint8Array): string {
  if (master.length !== 32) throw new RecoveryPhraseError("Secret maître invalide (32 octets attendus).");
  return entropyToMnemonic(master, wordlist);
}

/** Normalise une saisie libre en liste de mots. */
export function normalizePhrase(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[0-9]+[.):-]?/g, " ")
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function phraseToMaster(input: string): Uint8Array {
  const words = normalizePhrase(input);
  if (words.length !== 24) {
    throw new RecoveryPhraseError(`La phrase doit comporter 24 mots (${words.length} saisi(s)).`);
  }
  const unknown = words.find((w) => !wordlist.includes(w));
  if (unknown) throw new RecoveryPhraseError(`Mot inconnu dans la liste : « ${unknown} ».`);
  const phrase = words.join(" ");
  if (!validateMnemonic(phrase, wordlist)) {
    throw new RecoveryPhraseError("Somme de contrôle invalide : un mot est faux ou mal placé.");
  }
  return mnemonicToEntropy(phrase, wordlist);
}

// --- Vérification « avez-vous bien noté la phrase ? » --------------------------

export interface PhraseChallenge {
  /** Positions (1-indexées, croissantes) dont l'utilisateur doit saisir le mot. */
  positions: number[];
}

export function makePhraseChallenge(
  count = 4,
  random: (max: number) => number = (m) => crypto.getRandomValues(new Uint32Array(1))[0] % m,
): PhraseChallenge {
  const set = new Set<number>();
  while (set.size < Math.min(count, 24)) set.add(random(24) + 1);
  return { positions: [...set].sort((a, b) => a - b) };
}

/** Compare les réponses (même ordre que `positions`) à la phrase. */
export function checkPhraseChallenge(phrase: string, challenge: PhraseChallenge, answers: string[]): boolean {
  const words = phrase.split(" ");
  if (answers.length !== challenge.positions.length) return false;
  return challenge.positions.every((pos, i) => (answers[i] ?? "").trim().toLowerCase() === words[pos - 1]);
}
