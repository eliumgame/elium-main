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

/** Fichier joint à une fiche de situation (les octets sont dans `annexes.ts`). */
export interface Annexe {
  id: string;
  name: string;
  mime: string;
  size: number;
  addedAt: string; // ISO
  /** Légende libre affichée dans le dossier. */
  note: string;
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
   * Identifiant(s) de la situation dans le passeport, séparés par « ; ». Vide : le nom de la fiche (« SP2 »).
   */
  code: string;
  /** Annexes jointes à la fiche. */
  annexes: Annexe[];

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

/** Forme d'évaluation de la sous-épreuve (page d'identification du dossier, annexe VI-2). */
export type FormeEvaluation = "ccf" | "ponctuel";

/**
 * Dossier de la sous-épreuve E51 « Participer à la gestion des risques de la PME » (domaine 2 du
 * référentiel). Contrairement au passeport E4, ce n'est pas une collection de fiches : l'annexe VI-2
 * décrit un dossier unique sur UNE PME, avec UN risque choisi (ou une démarche qualité) et sa conduite
 * de projet. Structure reprise terme à terme de l'annexe VI-2 (principes de composition du dossier).
 */
export interface DossierE51 {
  // Partie 1 : identification (page de présentation)
  formeEvaluation: FormeEvaluation;
  /** Intitulé du projet validé par le(s) formateur(s). */
  intituleProjet: string;
  /** Activités du domaine 2 mobilisées (clés « 2.1 » à « 2.6 »). */
  activitesMobilisees: string[];
  periode: string;
  lieu: string;

  // Partie 2 : dossier de l'épreuve (12 pages maximum)
  /** Analyse du contexte de la PME : activité, effectif, CA, marché, clientèle, communication, certification, SI. */
  contextePme: string;
  /** Analyse managériale : production, structure, coordination, management, concurrence, FCS, stratégie. */
  analyseManageriale: string;
  /** Évaluation globale des risques de la PME et des moyens de prévention déployés. */
  evaluationRisques: string;
  /** Évaluation de la démarche qualité mise en œuvre au sein de la PME. */
  evaluationQualite: string;
  /** Risque repéré (ou démarche qualité) choisi comme thème, et justification de ce choix. */
  risqueChoisi: string;
  /** Conduite de projet menée pour améliorer la gestion de ce risque ou développer la démarche qualité. */
  conduiteProjet: string;
  /** Veille associée au thème choisi (réglementaire, technologique…). */
  veille: string;

  // Partie 3 : annexes (hors les 12 pages)
  /** Productions réalisées pour conduire ces travaux. */
  productions: Annexe[];
}

export interface PassportData {
  version: 1;
  updatedAt: string;
  holder: Holder;
  situations: Situation[];
  contexte: ContexteItem[];
  stages: Stage[];
  /** Nombre de fiches de situation à produire (sert à l'avancement du dossier ; à confirmer avec l'équipe pédagogique). */
  expectedSituations: number;
  /** Parcours et durée de stage à réaliser (à confirmer auprès de l'établissement : positionnement réglementaire). */
  parcours: { voie: Voie; requiredWeeks: number };
  /** « Solutions logicielles et fonctionnalités » du passeport, par activité (clé « 1.2 »). */
  solutions: Record<string, string>;
  /** Validation par l'équipe pédagogique (visa du passeport synoptique). */
  visa: { date: string; note: string };
  /** Dossier de la sous-épreuve E51 (domaine 2 : participer à la gestion des risques de la PME). */
  dossierE51: DossierE51;
}
