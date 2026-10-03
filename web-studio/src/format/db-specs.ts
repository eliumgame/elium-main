/**
 * Spécifications de schéma de TOUTES les bases IndexedDB locales d'Elium,
 * regroupées ici pour que `openMigrated` (idb-migrate.ts) soit l'unique chemin
 * d'ouverture. Ajouter une base ou un index = ajouter une étape, jamais
 * modifier une étape déjà publiée.
 */
import { KEEP, type DbSpec } from "./idb-migrate";

export const DRAFTS_SPEC: DbSpec = {
  name: "elium-drafts",
  steps: [{ version: 1, label: "Table des brouillons", up: (db) => void db.ensureStore("drafts") }],
};

export const DRIVE_SPEC: DbSpec = {
  name: "elium-drive",
  steps: [
    { version: 1, label: "Bibliothèque de documents", up: (db) => void db.ensureStore("docs") },
    {
      version: 2,
      label: "Index par date d'enregistrement",
      up: (db) => db.ensureStore("docs").createIndex("savedAt", "savedAt"),
    },
  ],
};

export const PARAPHEUR_SPEC: DbSpec = {
  name: "elium-parapheur",
  steps: [
    { version: 1, label: "Circuits de signature", up: (db) => void db.ensureStore("workflows", { keyPath: "docKey" }) },
  ],
};

export const VAULT_SPEC: DbSpec = {
  name: "elium-vault",
  steps: [{ version: 1, label: "Configuration du coffre", up: (db) => void db.ensureStore("config") }],
};

export const VERSIONS_SPEC: DbSpec = {
  name: "elium",
  steps: [
    {
      version: 1,
      label: "Historique des versions",
      up: (db) => db.ensureStore("versions", { autoIncrement: true }).createIndex("docKey", "docKey"),
    },
  ],
};

export const SHEETS_SPEC: DbSpec = {
  name: "elium-sheets",
  steps: [
    { version: 1, label: "Classeur courant", up: (db) => void db.ensureStore("workbooks") },
    {
      version: 2,
      label: "Classeurs multiples : index par date de modification",
      up: (db) => db.ensureStore("workbooks").createIndex("updatedAt", "updatedAt"),
    },
  ],
};

export const SLIDES_SPEC: DbSpec = {
  name: "elium-slides",
  steps: [
    { version: 1, label: "Présentation courante", up: (db) => void db.ensureStore("decks") },
    {
      version: 2,
      label: "Présentations multiples : index par date de modification",
      up: (db) => db.ensureStore("decks").createIndex("updatedAt", "updatedAt"),
    },
  ],
};

/** Bibliothèque locale de PDF (nouvelle base). */
export const PDFS_SPEC: DbSpec = {
  name: "elium-pdfs",
  steps: [{ version: 1, label: "Bibliothèque PDF", up: (db) => void db.ensureStore("files") }],
};

/** Brouillons de récupération du module PDF (version 2 déjà publiée avant le cadre). */
export const PDF_RECOVERY_SPEC: DbSpec = {
  name: "elium-pdf-recovery",
  steps: [
    {
      version: 1,
      label: "Brouillons PDF",
      up: (db) => {
        db.ensureStore("drafts").createIndex("diskKey", "diskKey");
        db.ensureStore("sources");
      },
    },
    {
      version: 2,
      label: "Sources déplacées hors des brouillons",
      risky: true,
      up: (db, from) => {
        const drafts = db.ensureStore("drafts");
        drafts.createIndex("diskKey", "diskKey");
        const sources = db.ensureStore("sources");
        if (from < 1) return; // base neuve : rien à déplacer
        // La v1 gardait une copie de la source dans chaque brouillon : on la sort, une fois.
        drafts.transform((raw) => {
          const d = raw as Record<string, unknown>;
          if (!d.source && !d.sourceEnc) return KEEP;
          sources.put({ id: d.id, protected: !!d.sourceEnc, bytes: d.source, legacyEnc: d.sourceEnc });
          const { source: _s, sourceEnc: _e, ...rest } = d;
          void _s;
          void _e;
          return rest;
        });
      },
    },
  ],
};

/** Identités numériques du module PDF (version 2 déjà publiée avant le cadre). */
export const PDF_IDS_SPEC: DbSpec = {
  name: "elium-pdf-ids",
  steps: [
    {
      version: 1,
      label: "Identités et confiance",
      up: (db) => {
        db.ensureStore("ids");
        db.ensureStore("trusted");
      },
    },
    { version: 2, label: "Signatures et initiales manuscrites", up: (db) => void db.ensureStore("marks") },
  ],
};

/**
 * Espace de travail : catalogue des éléments, dossiers, index de recherche,
 * méta (drapeaux de migration, récents, préférences synchronisées) et poignées
 * de fichiers (File System Access).
 */
export const WORKSPACE_SPEC: DbSpec = {
  name: "elium-workspace",
  steps: [
    {
      version: 1,
      label: "Catalogue, dossiers, recherche, méta, poignées",
      up: (db) => {
        db.ensureStore("items");
        db.ensureStore("folders");
        db.ensureStore("search");
        db.ensureStore("meta");
        db.ensureStore("handles");
      },
    },
  ],
};

export const ALL_DB_SPECS: DbSpec[] = [
  DRAFTS_SPEC,
  DRIVE_SPEC,
  PARAPHEUR_SPEC,
  VAULT_SPEC,
  VERSIONS_SPEC,
  SHEETS_SPEC,
  SLIDES_SPEC,
  PDFS_SPEC,
  PDF_RECOVERY_SPEC,
  PDF_IDS_SPEC,
  WORKSPACE_SPEC,
];
