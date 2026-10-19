/**
 * Passeport professionnel numérique — BTS Gestion de la PME, épreuve E4
 * « Gérer les relations avec les clients et les fournisseurs ».
 *
 * Reprend le fonctionnement du classeur officiel du CRCOM (tableau de bord,
 * fiches de situation professionnelle SPxx, passeport synoptique, référentiel
 * de compétences, fiche d'analyse Word) sans macro ni Excel : tout est dans
 * Elium, sauvegardé localement (chiffré par le coffre local s'il est actif).
 */

export interface RefTask {
  /** « 1.2.4 » */
  id: string;
  label: string;
}
export interface RefActivity {
  /** « 1.2 » */
  id: string;
  title: string;
  /** Compétence associée (colonne « Compétences » du passeport officiel). */
  competence: string;
  tasks: RefTask[];
}
export interface RefDomain {
  /** « 1 » */
  id: string;
  title: string;
  activities: RefActivity[];
}

/** Modalité de réalisation = colonnes du passeport. */
export type Modalite = "avant" | "etablissement" | "pme" | "organisation";
export type Condition = "autonomie" | "accompagnee" | "observation";
/** Nature des enjeux traités par la situation (cases de l'en-tête de la fiche d'analyse). */
export type Nature = "grcf" | "orale" | "ecrite";

/** Copie figée de ce qui a été validé dans le passeport (le « Transfert » du classeur Excel). */
export interface TransferSnapshot {
  at: string; // ISO
  modalite: Modalite;
  mois: number; // 1-12
  annee: number;
  activityIds: string[];
  taskIds: string[];
}

export interface Situation {
  /** Numéro de la fiche : 5 → « SP5 ». */
  id: number;
  createdAt: string;
  modifiedAt: string;

  // Identification
  modalite: Modalite;
  condition: Condition;
  mois: number;
  annee: number;
  /** Durée de la réalisation (texte libre : « 1 mois », « 12 h »…). */
  duree: string;
  natures: Nature[];
  activityIds: string[];
  taskIds: string[];
  /**
   * Identifiant(s) de la situation dans le passeport, séparés par « ; » (ex. « GRCF 2 ; CE2 »).
   * Vide : déduit de la nature et du rang (GRCF 1, CO1, CE1…).
   */
  code: string;

  // Présentation et contexte
  intitule: string;
  lieuPeriodeDuree: string;
  cadre: string;
  problemeGestion: string;
  problemeOral: string;
  problemeEcrit: string;
  acteurs: string;
  objectif: string;
  conditions: string;
  ressources: string;
  solutions: string;
  productions: string;
  ecrits: string;
  oraux: string;

  // Analyse
  analyse: string;
  contribution: string;

  // Suivi
  /** Pièces jointes / preuves à rassembler (liste libre, une ligne par pièce). */
  pieces: string;
  /** Remarques de l'enseignant (relecture). */
  remarques: string;
  relue: boolean;
  transfer?: TransferSnapshot;
}

export interface Holder {
  nom: string;
  prenom: string;
  numeroCandidat: string;
  session: string;
  academie: string;
  etablissement: string;
  ville: string;
  enseignant1: string;
  enseignant2: string;
}

/** Les 12 éléments minimaux du contexte commercial (annexe V-3). */
export interface ContexteItem {
  id: string;
  done: boolean;
  notes: string;
}

/** Nature d'une période en entreprise. */
export type StageType = "stage" | "alternance" | "emploi";
/** Parcours du candidat : détermine ce qui est attendu côté périodes en entreprise. */
export type Voie = "scolaire" | "apprentissage" | "professionnalisation" | "salarie";

/** Une période en entreprise : stage, alternance ou activité salariée (attestation, annexe III-3). */
export interface Stage {
  id: string;
  type: StageType;
  organisme: string;
  secteur: string;
  adresse: string;
  debut: string; // AAAA-MM-JJ
  fin: string; // AAAA-MM-JJ
  semaines: string;
  missionsE4: string;
  missionsE51: string;
  gratification: string;
  representant: string;
  attestationRecue: boolean;
  notes: string;
}

export interface PassportData {
  version: 1;
  updatedAt: string;
  holder: Holder;
  situations: Situation[];
  contexte: ContexteItem[];
  stages: Stage[];
  /** Parcours et durée de stage à réaliser (à confirmer auprès de l'établissement : positionnement réglementaire). */
  parcours: { voie: Voie; requiredWeeks: number };
  /** « Solutions logicielles et fonctionnalités » du passeport, par activité (clé « 1.2 »). */
  solutions: Record<string, string>;
  /** Validation par l'équipe pédagogique (visa du passeport synoptique). */
  visa: { date: string; note: string };
}
