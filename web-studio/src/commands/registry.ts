/**
 * Registre des commandes de l'application. Chaque module actif (Documents,
 * Tableur, Présentations…) y DÉCLARE ses actions tant qu'il est affiché ; la
 * navigation globale et l'espace de travail y ajoutent les leurs. La palette
 * (Ctrl/⌘+K) et les raccourcis lisent ce registre : une action déclarée une
 * fois apparaît partout, avec son raccourci.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ShortcutId } from "../settings/shortcuts";

export type CommandGroup = "module" | "file" | "nav" | "workspace" | "item" | "settings";

export interface AppCommand {
  id: string;
  label: string;
  /** Synonymes pour la recherche. */
  keywords?: string;
  group: CommandGroup;
  /** Raccourci personnalisable associé (affiché dans la palette, déclenche cette commande). */
  shortcutId?: ShortcutId;
  /** Indication fixe quand la commande a un raccourci propre à l'éditeur (non personnalisable). */
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

type Listener = () => void;

export class CommandRegistry {
  private sources = new Map<string, AppCommand[]>();
  private listeners = new Set<Listener>();
  private snapshot: AppCommand[] = [];

  /** Déclare les commandes d'une source (remplace les précédentes de cette source). Renvoie la fonction de retrait. */
  register(source: string, commands: AppCommand[]): () => void {
    this.sources.set(source, commands);
    this.rebuild();
    return () => {
      if (this.sources.get(source) === commands) {
        this.sources.delete(source);
        this.rebuild();
      }
    };
  }

  private rebuild() {
    this.snapshot = [...this.sources.values()].flat();
    for (const fn of this.listeners) fn();
  }

  list = (): AppCommand[] => this.snapshot;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Commande associée à un raccourci (la première non désactivée), s'il y en a une. */
  forShortcut(id: ShortcutId): AppCommand | undefined {
    return this.snapshot.find((c) => c.shortcutId === id && !c.disabled);
  }
}

export const commandRegistry = new CommandRegistry();

export function useCommands(): AppCommand[] {
  return useSyncExternalStore(commandRegistry.subscribe, commandRegistry.list, commandRegistry.list);
}

/**
 * Déclare des commandes pendant que le composant est monté. `commands` doit
 * être mémoïsé (useMemo) : un nouveau tableau à chaque rendu re-déclare à chaque rendu.
 */
export function useRegisterCommands(source: string, commands: AppCommand[]): void {
  useEffect(() => commandRegistry.register(source, commands), [source, commands]);
}
