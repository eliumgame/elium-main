/**
 * Composition des catalogues par zone. Pour ajouter une zone : créer
 * `messages/fr/<zone>.ts` (source de vérité) et `messages/en/<zone>.ts` (typé
 * `Record<keyof typeof frZone, string>`), puis les ajouter ci-dessous.
 */
import { frWorkspace } from "./messages/fr/workspace";
import { enWorkspace } from "./messages/en/workspace";

export const fr = { ...frWorkspace } as const;

export type MessageKey = keyof typeof fr;

/** Clés de pluriel : `x_one` + `x_other` s'appellent avec `tn("x", n)`. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer B}_other` ? B : never;
}[MessageKey];

export const en: Record<MessageKey, string> = { ...enWorkspace };

export const catalogs: Record<"fr" | "en", Record<string, string>> = { fr, en };
