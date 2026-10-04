import { describe, it, expect } from "vitest";
import {
  SHORTCUTS,
  bindingFromEvent,
  canonical,
  conflictFor,
  findConflicts,
  formatBinding,
  isAcceptableBinding,
  isReserved,
  matchesEvent,
  parseBinding,
  resolveBindings,
  sanitizeOverrides,
  shortcutFor,
} from "../src/settings/shortcuts";
import { fuzzyMatch, pushRecent, rankCommands } from "../src/commands/fuzzy";
import { CommandRegistry } from "../src/commands/registry";
import { DEFAULT_PREFS, backupReminderDue, sanitizePrefs } from "../src/settings/prefs";

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("raccourcis", () => {
  it("analyse et canonise : l'ordre d'écriture n'importe pas", () => {
    expect(canonical(parseBinding("shift+ctrl+k")!)).toBe("Mod+Shift+K");
    expect(canonical(parseBinding("Mod+Alt+Shift+Comma")!)).toBe("Mod+Alt+Shift+Comma");
    expect(parseBinding("")).toBeNull();
    expect(parseBinding("Mod+A+B")).toBeNull();
    expect(parseBinding("Mod+Shift")).toBeNull();
  });

  it("reconnaît un événement, Ctrl comme ⌘, et ne confond pas les modificateurs", () => {
    expect(matchesEvent(ev("k", { ctrlKey: true }), "Mod+K")).toBe(true);
    expect(matchesEvent(ev("K", { metaKey: true }), "Mod+K")).toBe(true);
    expect(matchesEvent(ev("k", { ctrlKey: true, shiftKey: true }), "Mod+K")).toBe(false);
    expect(matchesEvent(ev("k"), "Mod+K")).toBe(false);
    expect(matchesEvent(ev(",", { ctrlKey: true }), "Mod+Comma")).toBe(true);
    expect(matchesEvent(ev("F", { ctrlKey: true, shiftKey: true }), "Mod+Shift+F")).toBe(true);
    expect(bindingFromEvent(ev("Control", { ctrlKey: true }))).toBeNull(); // touche modificatrice seule
  });

  it("n'accepte que les combinaisons utilisables et refuse les réservées", () => {
    expect(isAcceptableBinding(parseBinding("K")!)).toBe(false); // lettre nue
    expect(isAcceptableBinding(parseBinding("Shift+K")!)).toBe(false);
    expect(isAcceptableBinding(parseBinding("Alt+K")!)).toBe(true);
    expect(isAcceptableBinding(parseBinding("F5")!)).toBe(true);
    expect(isReserved(parseBinding("Ctrl+C")!)).toBe(true);
    expect(isReserved(parseBinding("Mod+Shift+K")!)).toBe(false);
  });

  it("affiche Ctrl/Maj sous Windows et ⌘⇧ sous Mac", () => {
    expect(formatBinding("Mod+Shift+K")).toBe("Ctrl+Maj+K");
    expect(formatBinding("Mod+Shift+K", true)).toBe("⇧⌘K");
    expect(formatBinding("Mod+Comma")).toBe("Ctrl+,");
  });

  it("les raccourcis par défaut sont valides et sans conflit", () => {
    const b = resolveBindings(SHORTCUTS, {});
    expect(findConflicts(b)).toEqual([]);
    for (const d of SHORTCUTS) {
      const p = parseBinding(d.default)!;
      expect(p, d.id).not.toBeNull();
      expect(isAcceptableBinding(p), d.id).toBe(true);
      expect(isReserved(p), d.id).toBe(false);
    }
  });

  it("détecte les conflits et applique les écarts (chaîne vide = désactivé)", () => {
    const b = resolveBindings(SHORTCUTS, { goHome: "Mod+K", settings: "" });
    expect(findConflicts(b)).toEqual([["palette", "goHome"]]);
    expect(b.settings).toBe("");
    expect(conflictFor(resolveBindings(SHORTCUTS, {}), "ctrl+k", "goHome")).toBe("palette");
    expect(conflictFor(resolveBindings(SHORTCUTS, {}), "Alt+H", "goHome")).toBeNull();
    expect(shortcutFor(ev("o", { ctrlKey: true }), resolveBindings(SHORTCUTS, {}))).toBe("openFile");
    expect(shortcutFor(ev("o", { ctrlKey: true }), resolveBindings(SHORTCUTS, { openFile: "" }))).toBeNull();
  });

  it("nettoie ce qui est lu du stockage", () => {
    expect(sanitizeOverrides({ goHome: "alt+j", settings: "", palette: "K", inconnu: "Mod+Q", save: 12 })).toEqual({
      goHome: "Alt+J",
      settings: "",
    });
    expect(sanitizeOverrides("n'importe quoi")).toEqual({});
  });
});

describe("correspondance floue", () => {
  it("sous-séquence, accents et casse ignorés ; null si absente", () => {
    expect(fuzzyMatch("expdf", "Exporter en PDF")).not.toBeNull();
    expect(fuzzyMatch("ECRIRE", "Écrire")).not.toBeNull();
    expect(fuzzyMatch("zzz", "Exporter en PDF")).toBeNull();
    expect(fuzzyMatch("", "x")).toEqual({ score: 0, indices: [] });
  });

  it("préfère la sous-chaîne contiguë et le début de mot", () => {
    const contiguous = fuzzyMatch("pdf", "Exporter en PDF")!;
    const scattered = fuzzyMatch("pdf", "Passer en mode diaporama final")!;
    expect(contiguous.score).toBeGreaterThan(scattered.score);
    expect(contiguous.indices).toEqual([12, 13, 14]);
  });

  it("classe : meilleur d'abord, mots-clés en dernier recours, récents d'abord sans requête", () => {
    const cmds = [
      { id: "a", label: "Ouvrir les paramètres", keywords: "préférences réglages" },
      { id: "b", label: "Exporter en PDF" },
      { id: "c", label: "Rechercher dans tout l'espace" },
    ];
    expect(rankCommands(cmds, "pdf").map((r) => r.item.id)).toEqual(["b"]);
    expect(rankCommands(cmds, "reglages").map((r) => r.item.id)).toEqual(["a"]);
    expect(rankCommands(cmds, "", ["c", "b"]).map((r) => r.item.id)).toEqual(["c", "b", "a"]);
    expect(rankCommands(cmds, "", []).map((r) => r.item.id)).toEqual(["a", "b", "c"]);
  });

  it("mémorise les commandes récentes sans doublon, bornées", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });
});

describe("registre de commandes", () => {
  it("fusionne les sources, remplace une source, retire à la désinscription", () => {
    const r = new CommandRegistry();
    const seen: number[] = [];
    r.subscribe(() => seen.push(r.list().length));
    const un1 = r.register("doc", [{ id: "save", label: "Enregistrer", group: "module", shortcutId: "save", run: () => {} }]);
    r.register("nav", [{ id: "home", label: "Accueil", group: "nav", run: () => {} }]);
    expect(r.list().map((c) => c.id)).toEqual(["save", "home"]);
    expect(r.forShortcut("save")?.id).toBe("save");
    r.register("doc", [{ id: "save2", label: "Autre", group: "module", run: () => {} }]);
    expect(r.list().map((c) => c.id)).toEqual(["save2", "home"]);
    un1(); // ancienne inscription périmée : ne retire pas la nouvelle
    expect(r.list().map((c) => c.id)).toEqual(["save2", "home"]);
    expect(seen.length).toBeGreaterThan(2);
  });

  it("une commande désactivée ne répond pas à son raccourci", () => {
    const r = new CommandRegistry();
    r.register("doc", [{ id: "save", label: "Enregistrer", group: "module", shortcutId: "save", disabled: true, run: () => {} }]);
    expect(r.forShortcut("save")).toBeUndefined();
  });
});

describe("préférences", () => {
  it("borne les valeurs et retombe sur le défaut", () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ recentCount: 500, autosaveSeconds: 0, density: "énorme", startupView: "library", defaultFontSize: 5 })).toMatchObject({
      recentCount: 24,
      autosaveSeconds: 1,
      density: "comfortable",
      startupView: "library",
      defaultFontSize: 8,
    });
    expect(sanitizePrefs({ backupReminderDays: 3 }).backupReminderDays).toBe(0);
    expect(sanitizePrefs({ backupReminderDays: 14 }).backupReminderDays).toBe(14);
    expect(sanitizePrefs({ lastBackupAt: "pas une date" }).lastBackupAt).toBe("");
    expect(sanitizePrefs({ defaultFontSize: 0 }).defaultFontSize).toBe(0);
  });

  it("rappel de sauvegarde : jamais si désactivé ou espace vide, sinon selon l'âge et le report", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const base = { backupReminderDays: 7, lastBackupAt: "", backupSnoozedUntil: "" };
    expect(backupReminderDue({ ...base, backupReminderDays: 0 }, now, true)).toBe(false);
    expect(backupReminderDue(base, now, false)).toBe(false);
    expect(backupReminderDue(base, now, true)).toBe(true); // jamais sauvegardé
    expect(backupReminderDue({ ...base, lastBackupAt: "2026-10-05T00:00:00Z" }, now, true)).toBe(false);
    expect(backupReminderDue({ ...base, lastBackupAt: "2026-10-01T00:00:00Z" }, now, true)).toBe(true);
    expect(backupReminderDue({ ...base, lastBackupAt: "2026-10-01T00:00:00Z", backupSnoozedUntil: "2026-10-11T00:00:00Z" }, now, true)).toBe(false);
  });
});
