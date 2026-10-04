/**
 * Composition des catalogues par zone. Pour ajouter une zone : créer
 * `messages/fr/<zone>.ts` (source de vérité) et `messages/en/<zone>.ts` (typé
 * `Record<keyof typeof frZone, string>`), puis les ajouter ci-dessous.
 */
import { frWorkspace } from "./messages/fr/workspace";
import { enWorkspace } from "./messages/en/workspace";
import { frShell } from "./messages/fr/shell";
import { enShell } from "./messages/en/shell";
import { frSettings } from "./messages/fr/settings";
import { enSettings } from "./messages/en/settings";
import { frCommands } from "./messages/fr/commands";
import { enCommands } from "./messages/en/commands";

export const fr = { ...frWorkspace, ...frShell, ...frSettings, ...frCommands } as const;

export type MessageKey = keyof typeof fr;

/** Clés de pluriel : `x_one` + `x_other` s'appellent avec `tn("x", n)`. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer B}_other` ? B : never;
}[MessageKey];

export const en: Record<MessageKey, string> = { ...enWorkspace, ...enShell, ...enSettings, ...enCommands };

export const catalogs: Record<"fr" | "en", Record<string, string>> = { fr, en };
