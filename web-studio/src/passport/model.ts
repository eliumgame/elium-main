/**
 * Logique pure du passeport (aucun accès navigateur → testable sous Node).
 * Reproduit les automatismes des macros du classeur officiel : numérotation des
 * fiches, copie, suppression, tâches ↔ activités, transfert vers le passeport,
 * matrice synoptique activités × modalités et tâches « grisées ».
 */
import { REFERENTIEL } from "./referentiel";
import type {
  Annexe,
  ContexteItem,
  DossierE51,
  FormeEvaluation,
  Holder,
  Modalite,
  PassportData,
  RefActivity,
  RefDomain,
  RefTask,
  Situation,
  Stage,
  StageType,
  TransferSnapshot,
  Voie,
} from "./types";

export { REFERENTIEL };

export const MODALITES: { id: Modalite; label: string; short: string }[] = [
  { id: "avant", label: "Avant la formation", short: "Avant la formation" },
  { id: "etablissement", label: "Pendant la formation en établissement", short: "En établissement" },
  { id: "pme", label: "Pendant la formation dans une PME", short: "Dans une PME" },
  { id: "organisation", label: "Pendant la formation dans une organisation", short: "Dans une organisation" },
];

export const CONDITIONS = [
  { id: "autonomie", label: "En autonomie" },
  { id: "accompagnee", label: "Accompagnée" },
  { id: "observation", label: "En observation" },
] as const;

export const NATURES = [
  { id: "grcf", label: "GRCF", long: "Gestion de la relation avec les clients et les fournisseurs" },
  { id: "orale", label: "Communication orale", long: "Communication orale" },
  { id: "ecrite", label: "Communication écrite", long: "Communication écrite" },
] as const;

export const MOIS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

/** Éléments minimaux du contexte commercial (annexe V-3 du règlement d'examen). */
export const CONTEXTE_ITEMS: { id: string; label: string; hint: string }[] = [
  {
    id: "identite",
    label: "Fiche d'identité de l'entreprise",
    hint: "Raison sociale, forme juridique, activité, effectif, localisation, dirigeant.",
  },
  {
    id: "marche",
    label: "Marché et grandes tendances",
    hint: "Marché sur lequel évolue l'entreprise, évolutions, tendances.",
  },
  {
    id: "ca",
    label: "Chiffre d'affaires et son évolution",
    hint: "CA sur 3 ans, évolution, répartition par produit ou par activité.",
  },
  {
    id: "clientele",
    label: "Type de clientèle, répartition et segmentation",
    hint: "Particuliers / professionnels, poids de chaque segment, clients clés.",
  },
  {
    id: "concurrence",
    label: "Concurrence : prix, atouts, position de l'entreprise",
    hint: "Principaux concurrents, comparaison des prix et des atouts.",
  },
  {
    id: "processus",
    label: "Processus d'achat et de vente (activités comptables comprises)",
    hint: "Du devis à l'encaissement, de la commande au règlement, avec l'enregistrement comptable.",
  },
  {
    id: "fournisseurs",
    label: "Types de fournisseurs et pouvoir de négociation",
    hint: "Fournisseurs par catégorie d'achats, dépendance, marge de négociation.",
  },
  {
    id: "delais",
    label: "Délais de paiement des clients et des fournisseurs",
    hint: "Conditions de règlement, délais moyens constatés, relances.",
  },
  {
    id: "communication",
    label: "Politique de communication de l'entreprise",
    hint: "Outils, canaux, identité numérique, cibles.",
  },
  {
    id: "prix",
    label: "Principes généraux de fixation des prix",
    hint: "Coûts, marge, concurrence, grille tarifaire, remises.",
  },
  {
    id: "organisation",
    label: "Organisation de la fonction commerciale",
    hint: "Qui fait quoi : service commercial, ADV, achats, comptabilité.",
  },
  {
    id: "technologies",
    label: "Ressources technologiques mises à disposition",
    hint: "PGI, CRM, tableur, messagerie, outils de visioconférence, site web.",
  },
];

// ---------------------------------------------------------------- référentiel

const ALL_ACTIVITIES: RefActivity[] = REFERENTIEL.flatMap((d) => d.activities);
const ACTIVITY_BY_ID = new Map(ALL_ACTIVITIES.map((a) => [a.id, a]));
const TASK_BY_ID = new Map<string, { task: RefTask; activity: RefActivity }>(
  ALL_ACTIVITIES.flatMap((a) => a.tasks.map((t) => [t.id, { task: t, activity: a }] as const)),
);

export const allActivities = (): RefActivity[] => ALL_ACTIVITIES;
export const activityById = (id: string): RefActivity | undefined => ACTIVITY_BY_ID.get(id);
export const taskInfo = (id: string) => TASK_BY_ID.get(id);
export const domainOfActivity = (activityId: string): RefDomain | undefined =>
  REFERENTIEL.find((d) => d.activities.some((a) => a.id === activityId));

/** Les 6 activités du domaine 1 sont celles de l'épreuve E4. */
export const isE4Activity = (activityId: string): boolean => activityId.startsWith("1.");
/** Les 6 activités du domaine 2 relèvent de la sous-épreuve E51. */
export const isE51Activity = (activityId: string): boolean => activityId.startsWith("2.");

export function modaliteLabel(m: Modalite): string {
  return MODALITES.find((x) => x.id === m)?.label ?? m;
}

// ------------------------------------------------------------------ création

export function spLabel(id: number): string {
  return `SP${id}`;
}

export function periodLabel(s: { mois: number; annee: number }): string {
  return `${MOIS[Math.min(11, Math.max(0, s.mois - 1))]} ${s.annee}`;
}

export function emptyHolder(): Holder {
  return {
    nom: "",
    prenom: "",
    numeroCandidat: "",
    session: String(new Date().getFullYear() + 1),
    academie: "",
    etablissement: "",
    ville: "",
    enseignant1: "",
    enseignant2: "",
  };
}

export function emptyContexte(): ContexteItem[] {
  return CONTEXTE_ITEMS.map((c) => ({ id: c.id, done: false, notes: "" }));
}

export function emptyDossierE51(): DossierE51 {
  return {
    formeEvaluation: "ccf",
    intituleProjet: "",
    activitesMobilisees: [],
    periode: "",
    lieu: "",
    contextePme: "",
    analyseManageriale: "",
    evaluationRisques: "",
    evaluationQualite: "",
    risqueChoisi: "",
    conduiteProjet: "",
    veille: "",
    productions: [],
  };
}

export function emptyPassport(now = new Date().toISOString()): PassportData {
  return {
    version: 1,
    updatedAt: now,
    holder: emptyHolder(),
    situations: [],
    contexte: emptyContexte(),
    stages: [],
    expectedSituations: DEFAULT_EXPECTED_SITUATIONS,
    parcours: { voie: "scolaire", requiredWeeks: DEFAULT_REQUIRED_WEEKS },
    solutions: {},
    visa: { date: "", note: "" },
    dossierE51: emptyDossierE51(),
  };
}

/**
 * Durée de stage la plus souvent indiquée pour le BTS GPME en voie scolaire : 12 semaines, dont 6 consécutives en fin
 * de 1re année et au moins 4 consécutives en 2e année. Ce n'est PAS une valeur garantie : les sources divergent (8, 10,
 * 12, 14 semaines selon le « positionnement réglementaire » du candidat) — elle est donc modifiable et à confirmer.
 */
export const DEFAULT_REQUIRED_WEEKS = 12;

/** Nombre de fiches de situation visé par défaut (modifiable) : une par activité du domaine 1. */
export const DEFAULT_EXPECTED_SITUATIONS = 6;

export const VOIES: { id: Voie; label: string; requiredHint: string }[] = [
  {
    id: "scolaire",
    label: "Voie scolaire (formation initiale)",
    requiredHint: "12 semaines en général (6 en fin de 1re année + au moins 4 consécutives en 2e année)",
  },
  {
    id: "apprentissage",
    label: "Apprentissage (alternance)",
    requiredHint: "Pas de stage distinct : les périodes en entreprise du contrat en tiennent lieu",
  },
  {
    id: "professionnalisation",
    label: "Contrat de professionnalisation (alternance)",
    requiredHint: "Pas de stage distinct : les périodes en entreprise du contrat en tiennent lieu",
  },
  {
    id: "salarie",
    label: "Candidat salarié (activité professionnelle)",
    requiredHint: "Stage non obligatoire : certificats ou contrats de travail à la place de l'attestation de stage",
  },
];

export const STAGE_TYPES: { id: StageType; label: string; proof: string }[] = [
  { id: "stage", label: "Stage", proof: "Attestation de stage (annexe III-3)" },
  {
    id: "alternance",
    label: "Alternance (période en entreprise)",
    proof: "Contrat d'alternance + attestation ou certificat de l'employeur",
  },
  { id: "emploi", label: "Activité salariée", proof: "Certificat de travail ou contrat de travail" },
];

const DAY = 86_400_000;

/** Durée d'une période en semaines (champ « semaines » s'il est saisi, sinon calculée sur les dates, arrondie au dixième). */
export function stageWeeks(st: Pick<Stage, "debut" | "fin" | "semaines">): number {
  const typed = Number(String(st.semaines).replace(",", "."));
  if (Number.isFinite(typed) && typed > 0) return typed;
  const a = Date.parse(st.debut);
  const b = Date.parse(st.fin);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((((b - a) / DAY + 1) / 7) * 10) / 10;
}

export interface StageSummary {
  totalWeeks: number;
  byType: Record<StageType, number>;
  /** Semaines en 1re / 2e année du cycle (selon la session) ; le reste (hors cycle ou sans date) est à part. */
  year1: number;
  year2: number;
  other: number;
  /** Plus longue période de 2e année (semaines) : l'exigence habituelle est d'au moins 4 consécutives. */
  longestYear2: number;
  required: number;
  remaining: number;
  /** Éléments de preuve attendus mais non reçus. */
  missingProofs: number;
}

/** Année du cycle d'une période : 1 ou 2 selon la session (examen en juin de l'année « session »), 0 si hors cycle ou sans date. */
export function cycleYear(st: Pick<Stage, "debut">, session: string): 0 | 1 | 2 {
  const y = Number(session);
  const d = Date.parse(st.debut);
  if (!Number.isFinite(y) || !Number.isFinite(d)) return 0;
  const sep = (year: number) => Date.UTC(year, 8, 1);
  if (d >= sep(y - 1) && d < sep(y) + 10 * DAY) return 2;
  if (d >= sep(y - 2) && d < sep(y - 1)) return 1;
  return 0;
}

export function stageSummary(data: Pick<PassportData, "stages" | "parcours" | "holder">): StageSummary {
  const byType: Record<StageType, number> = { stage: 0, alternance: 0, emploi: 0 };
  let year1 = 0;
  let year2 = 0;
  let other = 0;
  let longestYear2 = 0;
  for (const st of data.stages) {
    const w = stageWeeks(st);
    byType[st.type] += w;
    const y = cycleYear(st, data.holder.session);
    if (y === 1) year1 += w;
    else if (y === 2) {
      year2 += w;
      longestYear2 = Math.max(longestYear2, w);
    } else other += w;
  }
  const totalWeeks = Math.round((byType.stage + byType.alternance + byType.emploi) * 10) / 10;
  const required = data.parcours.voie === "scolaire" ? Math.max(0, data.parcours.requiredWeeks) : 0;
  return {
    totalWeeks,
    byType,
    year1: Math.round(year1 * 10) / 10,
    year2: Math.round(year2 * 10) / 10,
    other: Math.round(other * 10) / 10,
    longestYear2,
    required,
    remaining: Math.max(0, Math.round((required - totalWeeks) * 10) / 10),
    missingProofs: data.stages.filter((s) => !s.attestationRecue).length,
  };
}

export function newStage(id: string): Stage {
  return {
    id,
    type: "stage",
    organisme: "",
    secteur: "",
    adresse: "",
    debut: "",
    fin: "",
    semaines: "",
    missionsE4: "",
    missionsE51: "",
    gratification: "",
    representant: "",
    attestationRecue: false,
    notes: "",
  };
}

/** Plus petit numéro libre (≥ 1) : comble les trous laissés par les suppressions. */
export function nextSituationId(list: Pick<Situation, "id">[]): number {
  const used = new Set(list.map((s) => s.id));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function newSituation(id: number, now = new Date()): Situation {
  const iso = now.toISOString();
  return {
    id,
    createdAt: iso,
    modifiedAt: iso,
    modalite: "etablissement",
    condition: "autonomie",
    mois: now.getMonth() + 1,
    annee: now.getFullYear(),
    duree: "",
    natures: ["grcf"],
    activityIds: [],
    taskIds: [],
    code: "",
    annexes: [],
    intitule: "",
    lieuPeriodeDuree: "",
    cadre: "",
    problemeGestion: "",
    problemeOral: "",
    problemeEcrit: "",
    acteurs: "",
    objectif: "",
    conditions: "",
    ressources: "",
    solutions: "",
    productions: "",
    ecrits: "",
    oraux: "",
    analyse: "",
    contribution: "",
    pieces: "",
    remarques: "",
    relue: false,
  };
}

/** Copie d'une situation vers un nouveau numéro. Le transfert est à refaire (comme dans le classeur). */
export function duplicateSituation(src: Situation, newId: number, now = new Date()): Situation {
  const iso = now.toISOString();
  return {
    ...src,
    id: newId,
    createdAt: iso,
    modifiedAt: iso,
    activityIds: [...src.activityIds],
    taskIds: [...src.taskIds],
    natures: [...src.natures],
    relue: false,
    remarques: "",
    code: "",
    annexes: [],
    transfer: undefined,
  };
}

// ----------------------------------------------------- activités ↔ tâches

const byRefOrder = (a: string, b: string) =>
  a
    .split(".")
    .map(Number)
    .reduce((acc, n, i) => acc || n - (Number(b.split(".")[i]) || 0), 0);

/** Coche/décoche une activité ; la décocher retire ses tâches. */
export function toggleActivity(s: Situation, activityId: string): Situation {
  const act = activityById(activityId);
  if (!act) return s;
  if (s.activityIds.includes(activityId)) {
    const drop = new Set(act.tasks.map((t) => t.id));
    return {
      ...s,
      activityIds: s.activityIds.filter((a) => a !== activityId),
      taskIds: s.taskIds.filter((t) => !drop.has(t)),
    };
  }
  return { ...s, activityIds: [...s.activityIds, activityId].sort(byRefOrder) };
}

/** Coche/décoche une tâche ; la cocher sélectionne aussi son activité. */
export function toggleTask(s: Situation, taskId: string): Situation {
  const info = taskInfo(taskId);
  if (!info) return s;
  if (s.taskIds.includes(taskId)) return { ...s, taskIds: s.taskIds.filter((t) => t !== taskId) };
  return {
    ...s,
    taskIds: [...s.taskIds, taskId].sort(byRefOrder),
    activityIds: s.activityIds.includes(info.activity.id)
      ? s.activityIds
      : [...s.activityIds, info.activity.id].sort(byRefOrder),
  };
}

/** Compétences associées aux activités choisies (« les compétences se complètent automatiquement »). */
export function competencesOf(s: Pick<Situation, "activityIds">): { activityId: string; competence: string }[] {
  return s.activityIds.flatMap((id) => {
    const a = activityById(id);
    return a ? [{ activityId: id, competence: a.competence }] : [];
  });
}

// ---------------------------------------------------------------- transfert

const sortedKey = (ids: string[]) => [...ids].sort().join("|");

export function snapshotOf(s: Situation, at = new Date().toISOString()): TransferSnapshot {
  return {
    at,
    modalite: s.modalite,
    mois: s.mois,
    annee: s.annee,
    activityIds: [...s.activityIds],
    taskIds: [...s.taskIds],
  };
}

/** Problèmes qui empêchent (error) ou déconseillent (warning) le transfert vers le passeport. */
export function transferIssues(s: Situation): { level: "error" | "warning"; message: string }[] {
  const out: { level: "error" | "warning"; message: string }[] = [];
  if (s.activityIds.length === 0)
    out.push({ level: "error", message: "Sélectionnez au moins une activité concernée." });
  if (s.activityIds.length > 0 && s.taskIds.length === 0)
    out.push({ level: "warning", message: "Aucune tâche cochée : le passeport n'en grisera aucune." });
  if (!s.intitule.trim()) out.push({ level: "warning", message: "L'intitulé de la situation est vide." });
  return out;
}

/** Valide la situation dans le passeport (bouton « Transfert »). Renvoie null si impossible. */
export function transferSituation(s: Situation, now = new Date().toISOString()): Situation | null {
  if (transferIssues(s).some((i) => i.level === "error")) return null;
  return { ...s, transfer: snapshotOf(s, now) };
}

export function untransferSituation(s: Situation): Situation {
  return { ...s, transfer: undefined };
}

/** La fiche a été modifiée depuis son dernier transfert : le passeport n'est plus à jour. */
export function isStale(s: Situation): boolean {
  const t = s.transfer;
  if (!t) return false;
  return (
    t.modalite !== s.modalite ||
    t.mois !== s.mois ||
    t.annee !== s.annee ||
    sortedKey(t.activityIds) !== sortedKey(s.activityIds) ||
    sortedKey(t.taskIds) !== sortedKey(s.taskIds)
  );
}

// ----------------------------------------------------------- passeport

export interface PassportMark {
  spId: number;
  period: string;
  /** Identifiant affiché dans le passeport (« GRCF 2 ; CE2 »). */
  code: string;
}

/**
 * Identifiant(s) d'une situation dans le passeport : son nom de fiche (« SP2 »). Peut être remplacé à la main sur la
 * fiche (« SP2 ; SP5 », « Vente 1 »…).
 */
export function situationCodes(s: Pick<Situation, "id" | "code">, _all?: unknown): string[] {
  const manual = (s.code ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  return manual.length ? manual : [spLabel(s.id)];
}

/** Contenu des cases du passeport : activité × modalité → situations validées. */
export function passportCells(data: Pick<PassportData, "situations">): Map<string, PassportMark[]> {
  const cells = new Map<string, PassportMark[]>();
  const ordered = [...data.situations].sort((a, b) => a.id - b.id);
  for (const s of ordered) {
    const t = s.transfer;
    if (!t) continue;
    for (const actId of t.activityIds) {
      const key = `${actId}|${t.modalite}`;
      const list = cells.get(key) ?? [];
      list.push({ spId: s.id, period: periodLabel(t), code: situationCodes(s, ordered).join(" ; ") });
      cells.set(key, list);
    }
  }
  return cells;
}

/** Tâches « grisées » : tâche → numéros des situations validées qui la mobilisent. */
export function coveredTasks(data: Pick<PassportData, "situations">): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const s of [...data.situations].sort((a, b) => a.id - b.id)) {
    for (const tid of s.transfer?.taskIds ?? []) {
      const l = map.get(tid) ?? [];
      l.push(s.id);
      map.set(tid, l);
    }
  }
  return map;
}

export interface ActivityCoverage {
  activity: RefActivity;
  /** Situations validées qui touchent l'activité. */
  situations: number[];
  tasksCovered: number;
  tasksTotal: number;
}

export function activityCoverage(data: Pick<PassportData, "situations">): ActivityCoverage[] {
  const tasks = coveredTasks(data);
  const bySituation = new Map<string, number[]>();
  for (const s of [...data.situations].sort((a, b) => a.id - b.id))
    for (const a of s.transfer?.activityIds ?? []) bySituation.set(a, [...(bySituation.get(a) ?? []), s.id]);
  return ALL_ACTIVITIES.map((activity) => ({
    activity,
    situations: bySituation.get(activity.id) ?? [],
    tasksCovered: activity.tasks.filter((t) => tasks.has(t.id)).length,
    tasksTotal: activity.tasks.length,
  }));
}

/**
 * « Solutions logicielles et fonctionnalités » du passeport, par activité : reprend, pour chaque activité,
 * les lignes des rubriques « solutions » des situations validées qui la touchent (sans doublon) — sans
 * jamais écraser ce qui a déjà été saisi pour l'activité.
 */
export function prefillSolutions(data: Pick<PassportData, "situations" | "solutions">): Record<string, string> {
  const out = { ...data.solutions };
  for (const a of ALL_ACTIVITIES) {
    if ((out[a.id] ?? "").trim()) continue;
    const parts: string[] = [];
    for (const s of [...data.situations].sort((x, y) => x.id - y.id)) {
      if (!s.transfer?.activityIds.includes(a.id)) continue;
      for (const piece of s.solutions
        .split(/[\n;]+/)
        .map((x) => x.trim())
        .filter(Boolean))
        if (!parts.some((q) => q.toLowerCase() === piece.toLowerCase())) parts.push(piece);
    }
    if (parts.length) out[a.id] = parts.join(" ; ");
  }
  return out;
}

// -------------------------------------------------------------- avancement

const COMPLETION_FIELDS: (keyof Situation)[] = [
  "intitule",
  "lieuPeriodeDuree",
  "cadre",
  "acteurs",
  "objectif",
  "conditions",
  "ressources",
  "solutions",
  "productions",
  "analyse",
  "contribution",
];

/** Avancement de rédaction d'une fiche, 0-100. */
export function completion(s: Situation): number {
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  let done = COMPLETION_FIELDS.filter((k) => filled(s[k])).length;
  let total = COMPLETION_FIELDS.length;
  total += 1; // au moins un problème posé (selon la nature)
  const prob: Record<string, keyof Situation> = {
    grcf: "problemeGestion",
    orale: "problemeOral",
    ecrite: "problemeEcrit",
  };
  const wanted = s.natures.length ? s.natures : (["grcf"] as const);
  if (wanted.every((n) => filled(s[prob[n]]))) done += 1;
  total += 1; // activités
  if (s.activityIds.length > 0) done += 1;
  total += 1; // tâches
  if (s.taskIds.length > 0) done += 1;
  return Math.round((done / total) * 100);
}

export type SituationState = "a-completer" | "a-valider" | "a-retransferer" | "validee";

export function situationState(s: Situation): SituationState {
  if (s.transfer) return isStale(s) ? "a-retransferer" : "validee";
  return completion(s) >= 100 ? "a-valider" : "a-completer";
}

export const STATE_LABEL: Record<SituationState, string> = {
  "a-completer": "À compléter",
  "a-valider": "Prête à valider",
  "a-retransferer": "À retransférer",
  validee: "Validée dans le passeport",
};

// ------------------------------------------------------ suivi du dossier

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  /** Part réalisée, de 0 à 1 (sert à l'avancement global : une fiche sur six ne vaut pas « fait »). */
  ratio: number;
  /** Onglet où corriger. */
  tab?: "dashboard" | "situations" | "passport" | "referentiel" | "contexte" | "stages" | "dossierE51";
}

/** Points à réunir pour présenter le dossier E4 (identification, passeport, contexte, stages). */
export function dossierChecklist(data: PassportData): ChecklistItem[] {
  const h = data.holder;
  const missingHolder = (
    [
      ["nom", "nom"],
      ["prenom", "prénom"],
      ["numeroCandidat", "numéro de candidat"],
      ["session", "session"],
      ["etablissement", "établissement"],
    ] as const
  )
    .filter(([k]) => !h[k].trim())
    .map(([, l]) => l);
  const N = Math.max(1, data.expectedSituations || DEFAULT_EXPECTED_SITUATIONS);
  const frac = (n: number, d = N) => Math.max(0, Math.min(1, d ? n / d : 0));
  const validated = data.situations.filter((s) => s.transfer && !isStale(s));
  const stale = data.situations.filter((s) => isStale(s));
  const written = data.situations.filter((s) => completion(s) >= 100);
  const cov = activityCoverage(data).filter((c) => isE4Activity(c.activity.id));
  const covered = cov.filter((c) => c.situations.length > 0);
  const uncovered = cov.filter((c) => c.situations.length === 0).map((c) => c.activity.id);
  const ctxDone = data.contexte.filter((c) => c.done).length;
  const ctxTotal = CONTEXTE_ITEMS.length;
  const reviewed = data.situations.filter((s) => s.relue).length;
  const withAttestation = data.stages.filter((s) => s.attestationRecue).length;
  const stages = stageSummary(data);
  const scolaire = data.parcours.voie === "scolaire";
  return [
    {
      id: "holder",
      label: "Identification du candidat complète",
      ok: missingHolder.length === 0,
      ratio: frac(5 - missingHolder.length, 5),
      detail: missingHolder.length ? `Manque : ${missingHolder.join(", ")}` : undefined,
      tab: "dashboard",
    },
    {
      id: "situations",
      label: `Fiches de situation créées (${N} attendues)`,
      ok: data.situations.length >= N,
      ratio: frac(data.situations.length),
      detail: `${data.situations.length} / ${N}`,
      tab: "situations",
    },
    {
      id: "complete",
      label: "Fiches complètement rédigées",
      ok: written.length >= N,
      ratio: frac(written.length),
      detail: `${written.length} / ${N}`,
      tab: "situations",
    },
    {
      id: "validated",
      label: "Fiches validées dans le passeport",
      ok: validated.length >= N && stale.length === 0,
      ratio: frac(validated.length),
      detail: stale.length
        ? `${stale.length} fiche(s) modifiée(s) depuis leur transfert (${stale.map((s) => spLabel(s.id)).join(", ")})`
        : `${validated.length} / ${N}`,
      tab: "situations",
    },
    {
      id: "coverage",
      label: "Les 6 activités E4 (1.1 à 1.6) couvertes au moins une fois",
      ok: uncovered.length === 0,
      ratio: frac(covered.length, cov.length),
      detail: uncovered.length ? `Non couvertes : ${uncovered.join(", ")}` : undefined,
      tab: "passport",
    },
    {
      id: "contexte",
      label: "Contexte commercial présenté (12 éléments)",
      ok: ctxDone === ctxTotal,
      ratio: frac(ctxDone, ctxTotal),
      detail: `${ctxDone} / ${ctxTotal}`,
      tab: "contexte",
    },
    {
      id: "stages",
      label: scolaire
        ? `Périodes en entreprise : ${stages.required} semaines à réaliser`
        : "Périodes en entreprise renseignées (stage, alternance ou activité salariée)",
      ok: scolaire ? data.stages.length > 0 && stages.remaining === 0 : data.stages.length > 0,
      ratio: scolaire ? frac(stages.totalWeeks, stages.required) : data.stages.length ? 1 : 0,
      detail: scolaire
        ? `${stages.totalWeeks} / ${stages.required} semaines${stages.remaining ? ` — il en manque ${stages.remaining}` : ""}`
        : `${stages.totalWeeks} semaine(s) saisie(s)`,
      tab: "stages",
    },
    {
      id: "attestations",
      label: "Justificatif reçu pour chaque période (attestation, certificat ou contrat)",
      ok: data.stages.length > 0 && withAttestation === data.stages.length,
      ratio: data.stages.length ? frac(withAttestation, data.stages.length) : 0,
      detail: data.stages.length ? `${withAttestation} / ${data.stages.length} reçu(s)` : "Aucune période saisie",
      tab: "stages",
    },
    {
      id: "review",
      label: "Fiches relues par l'équipe pédagogique",
      ok: reviewed >= N,
      ratio: frac(reviewed),
      detail: `${reviewed} / ${N}`,
      tab: "situations",
    },
    {
      id: "visa",
      label: "Passeport visé par l'équipe pédagogique",
      ok: !!data.visa.date,
      ratio: data.visa.date ? 1 : 0,
      tab: "passport",
    },
  ];
}

export function dossierProgress(items: ChecklistItem[]): number {
  return items.length ? Math.round((items.reduce((a, i) => a + i.ratio, 0) / items.length) * 100) : 0;
}

/**
 * Environ 450 mots tiennent sur une page A4 de texte courant (corps de texte, marges normales) : sert à
 * donner un ordre de grandeur, pas une mesure exacte de mise en page. La limite réglementaire (annexe
 * VI-2) est 12 pages pour la présentation du contexte et l'évaluation globale, hors annexes.
 */
const WORDS_PER_PAGE = 450;

export function estimateE51Pages(d: Pick<DossierE51, (typeof E51_BODY_FIELDS)[number]>): number {
  const words = E51_BODY_FIELDS.reduce((n, k) => n + (d[k].trim() ? d[k].trim().split(/\s+/).length : 0), 0);
  return Math.max(1, Math.ceil(words / WORDS_PER_PAGE));
}

/** Rubriques du corps du dossier (partie 2 de l'annexe VI-2), dans l'ordre de l'annexe. */
export const E51_BODY_FIELDS = [
  "contextePme",
  "analyseManageriale",
  "evaluationRisques",
  "evaluationQualite",
  "risqueChoisi",
  "conduiteProjet",
  "veille",
] as const satisfies readonly (keyof DossierE51)[];

/** Titres des rubriques, dans l'ordre de l'annexe VI-2 — alignés sur `E51_BODY_FIELDS`. */
export const E51_SECTION_TITLES: Record<(typeof E51_BODY_FIELDS)[number], string> = {
  contextePme: "Présentation du contexte et de l'activité de la PME",
  analyseManageriale: "Analyse managériale",
  evaluationRisques: "Évaluation globale des risques de la PME",
  evaluationQualite: "Évaluation de la démarche qualité mise en œuvre",
  risqueChoisi: "Risque repéré (ou démarche qualité) choisi et justification",
  conduiteProjet: "Conduite de projet",
  veille: "Veille associée au thème choisi",
};

export const FORMES_EVALUATION: { id: FormeEvaluation; label: string }[] = [
  { id: "ccf", label: "Contrôle en cours de formation (CCF)" },
  { id: "ponctuel", label: "Forme ponctuelle" },
];

/** Points à réunir pour présenter le dossier E51 (identification, contexte, risques, projet, annexe VI-2). */
export function dossierE51Checklist(data: PassportData): ChecklistItem[] {
  const e = data.dossierE51;
  const filled = (v: string) => v.trim().length > 0;
  const cov = activityCoverage(data).filter((c) => isE51Activity(c.activity.id));
  const withAttestation = data.stages.filter((s) => s.attestationRecue).length;
  return [
    {
      id: "identification",
      label: "Identification du projet (intitulé, période, lieu)",
      ok: filled(e.intituleProjet) && filled(e.periode) && filled(e.lieu),
      ratio: [e.intituleProjet, e.periode, e.lieu].filter(filled).length / 3,
      tab: "dossierE51",
    },
    {
      id: "activites",
      label: "Au moins une activité du domaine 2 mobilisée (2.1 à 2.6)",
      ok: e.activitesMobilisees.length > 0,
      ratio: e.activitesMobilisees.length > 0 ? 1 : 0,
      detail: e.activitesMobilisees.length ? e.activitesMobilisees.join(", ") : undefined,
      tab: "dossierE51",
    },
    {
      id: "contexte",
      label: "Contexte de la PME et analyse managériale rédigés",
      ok: filled(e.contextePme) && filled(e.analyseManageriale),
      ratio: [e.contextePme, e.analyseManageriale].filter(filled).length / 2,
      tab: "dossierE51",
    },
    {
      id: "evaluation",
      label: "Évaluation globale des risques et de la démarche qualité rédigée",
      ok: filled(e.evaluationRisques) && filled(e.evaluationQualite),
      ratio: [e.evaluationRisques, e.evaluationQualite].filter(filled).length / 2,
      tab: "dossierE51",
    },
    {
      id: "risque-choisi",
      label: "Risque repéré (ou démarche qualité) choisi et justifié",
      ok: filled(e.risqueChoisi),
      ratio: filled(e.risqueChoisi) ? 1 : 0,
      tab: "dossierE51",
    },
    {
      id: "projet",
      label: "Conduite de projet et veille associée rédigées",
      ok: filled(e.conduiteProjet) && filled(e.veille),
      ratio: [e.conduiteProjet, e.veille].filter(filled).length / 2,
      tab: "dossierE51",
    },
    {
      id: "productions",
      label: "Productions réalisées jointes (annexes, hors 12 pages)",
      ok: e.productions.length > 0,
      ratio: e.productions.length > 0 ? 1 : 0,
      detail: `${e.productions.length} pièce(s)`,
      tab: "dossierE51",
    },
    {
      id: "e51-activities-coverage",
      label: "Les 6 activités du domaine 2 passées en revue (référentiel)",
      ok: cov.some((c) => c.situations.length > 0 || e.activitesMobilisees.includes(c.activity.id)),
      ratio: e.activitesMobilisees.length ? Math.min(1, e.activitesMobilisees.length / cov.length) : 0,
      tab: "referentiel",
    },
    {
      id: "attestations",
      label: "Justificatif reçu pour chaque période en entreprise (partagé avec E4)",
      ok: data.stages.length > 0 && withAttestation === data.stages.length,
      ratio: data.stages.length ? withAttestation / data.stages.length : 0,
      detail: data.stages.length ? `${withAttestation} / ${data.stages.length} reçu(s)` : "Aucune période saisie",
      tab: "stages",
    },
  ];
}

// --------------------------------------------------------------- statistiques

export interface PassportStats {
  total: number;
  validated: number;
  stale: number;
  byModalite: Record<Modalite, number>;
  byNature: { grcf: number; orale: number; ecrite: number };
  tasksCovered: number;
  tasksTotal: number;
  e4TasksCovered: number;
  e4TasksTotal: number;
}

export function passportStats(data: PassportData): PassportStats {
  const byModalite: Record<Modalite, number> = { avant: 0, etablissement: 0, pme: 0, organisation: 0 };
  const byNature = { grcf: 0, orale: 0, ecrite: 0 };
  for (const s of data.situations) {
    byModalite[s.modalite]++;
    for (const n of s.natures) byNature[n]++;
  }
  const cov = activityCoverage(data);
  const e4 = cov.filter((c) => isE4Activity(c.activity.id));
  const sum = (l: ActivityCoverage[], k: "tasksCovered" | "tasksTotal") => l.reduce((a, c) => a + c[k], 0);
  return {
    total: data.situations.length,
    validated: data.situations.filter((s) => s.transfer).length,
    stale: data.situations.filter(isStale).length,
    byModalite,
    byNature,
    tasksCovered: sum(cov, "tasksCovered"),
    tasksTotal: sum(cov, "tasksTotal"),
    e4TasksCovered: sum(e4, "tasksCovered"),
    e4TasksTotal: sum(e4, "tasksTotal"),
  };
}

// --------------------------------------------------- normalisation / import

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown): boolean => v === true;
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strList = (v: unknown, valid?: (s: string) => boolean): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && (!valid || valid(x))) : [];

/** Reconstruit une liste d'annexes (description seulement : les octets vivent ailleurs, cf. `annexes.ts`). */
function normAnnexeList(v: unknown): Annexe[] {
  return (Array.isArray(v) ? v : []).flatMap((x: unknown) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const id = str(o.id);
    return id
      ? [
          {
            id,
            name: str(o.name, "annexe"),
            mime: str(o.mime),
            size: num(o.size, 0),
            addedAt: str(o.addedAt),
            note: str(o.note),
          },
        ]
      : [];
  });
}

function normSituation(raw: unknown): Situation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = Math.floor(num(r.id, NaN));
  if (!Number.isFinite(id) || id < 1) return null;
  const base = newSituation(id, new Date(0));
  const mod = MODALITES.some((m) => m.id === r.modalite) ? (r.modalite as Modalite) : base.modalite;
  const cond = CONDITIONS.some((c) => c.id === r.condition) ? (r.condition as Situation["condition"]) : base.condition;
  const natures = strList(r.natures, (n) => NATURES.some((x) => x.id === n)) as Situation["natures"];
  const s: Situation = {
    ...base,
    createdAt: str(r.createdAt, base.createdAt),
    modifiedAt: str(r.modifiedAt, base.modifiedAt),
    modalite: mod,
    condition: cond,
    mois: Math.min(12, Math.max(1, Math.floor(num(r.mois, 1)))),
    annee: Math.floor(num(r.annee, new Date().getFullYear())),
    duree: str(r.duree),
    natures: natures.length ? natures : ["grcf"],
    activityIds: strList(r.activityIds, (a) => ACTIVITY_BY_ID.has(a)),
    taskIds: strList(r.taskIds, (t) => TASK_BY_ID.has(t)),
    relue: bool(r.relue),
    code: str(r.code),
    annexes: normAnnexeList(r.annexes),
  };
  for (const k of [
    "intitule",
    "lieuPeriodeDuree",
    "cadre",
    "problemeGestion",
    "problemeOral",
    "problemeEcrit",
    "acteurs",
    "objectif",
    "conditions",
    "ressources",
    "solutions",
    "productions",
    "ecrits",
    "oraux",
    "analyse",
    "contribution",
    "pieces",
    "remarques",
  ] as const)
    s[k] = str(r[k]);
  const t = r.transfer as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    s.transfer = {
      at: str(t.at, s.modifiedAt),
      modalite: MODALITES.some((m) => m.id === t.modalite) ? (t.modalite as Modalite) : mod,
      mois: Math.min(12, Math.max(1, Math.floor(num(t.mois, s.mois)))),
      annee: Math.floor(num(t.annee, s.annee)),
      activityIds: strList(t.activityIds, (a) => ACTIVITY_BY_ID.has(a)),
      taskIds: strList(t.taskIds, (x) => TASK_BY_ID.has(x)),
    };
  }
  return s;
}

/** Reconstruit un PassportData valide à partir d'un JSON quelconque (import, ancienne version). Renvoie null si inexploitable. */
export function normalizePassport(raw: unknown): PassportData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.situations) && typeof r.holder !== "object") return null;
  const base = emptyPassport();
  const h = (r.holder && typeof r.holder === "object" ? r.holder : {}) as Record<string, unknown>;
  const holder = { ...base.holder };
  for (const k of Object.keys(holder) as (keyof Holder)[]) holder[k] = str(h[k], holder[k]);
  const seen = new Set<number>();
  const situations: Situation[] = [];
  for (const raw1 of Array.isArray(r.situations) ? r.situations : []) {
    const s = normSituation(raw1);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      situations.push(s);
    }
  }
  situations.sort((a, b) => a.id - b.id);
  const ctxIn = new Map(
    (Array.isArray(r.contexte) ? r.contexte : []).flatMap((c: unknown) =>
      c && typeof c === "object"
        ? [[str((c as Record<string, unknown>).id), c as Record<string, unknown>] as const]
        : [],
    ),
  );
  const contexte = CONTEXTE_ITEMS.map((c) => ({
    id: c.id,
    done: bool(ctxIn.get(c.id)?.done),
    notes: str(ctxIn.get(c.id)?.notes),
  }));
  const stages: Stage[] = (Array.isArray(r.stages) ? r.stages : []).flatMap((x: unknown, i: number) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const st = newStage(str(o.id, `st-${i + 1}`));
    for (const k of Object.keys(st) as (keyof Stage)[]) {
      if (k === "attestationRecue") st[k] = bool(o[k]);
      else if (k === "type") st[k] = STAGE_TYPES.some((x) => x.id === o[k]) ? (o[k] as StageType) : "stage";
      else (st[k] as string) = str(o[k], st[k] as string);
    }
    return [st];
  });
  const v = (r.visa && typeof r.visa === "object" ? r.visa : {}) as Record<string, unknown>;
  const e51base = emptyDossierE51();
  const e51 = (r.dossierE51 && typeof r.dossierE51 === "object" ? r.dossierE51 : {}) as Record<string, unknown>;
  const dossierE51: DossierE51 = {
    formeEvaluation: FORMES_EVALUATION.some((f) => f.id === e51.formeEvaluation)
      ? (e51.formeEvaluation as FormeEvaluation)
      : e51base.formeEvaluation,
    intituleProjet: str(e51.intituleProjet),
    activitesMobilisees: strList(e51.activitesMobilisees, (a) => ACTIVITY_BY_ID.has(a) && isE51Activity(a)),
    periode: str(e51.periode),
    lieu: str(e51.lieu),
    contextePme: str(e51.contextePme),
    analyseManageriale: str(e51.analyseManageriale),
    evaluationRisques: str(e51.evaluationRisques),
    evaluationQualite: str(e51.evaluationQualite),
    risqueChoisi: str(e51.risqueChoisi),
    conduiteProjet: str(e51.conduiteProjet),
    veille: str(e51.veille),
    productions: normAnnexeList(e51.productions),
  };
  return {
    version: 1,
    updatedAt: str(r.updatedAt, base.updatedAt),
    holder,
    situations,
    contexte,
    stages,
    expectedSituations: Math.max(1, Math.min(30, Math.floor(num(r.expectedSituations, DEFAULT_EXPECTED_SITUATIONS)))),
    parcours: (() => {
      const pc = (r.parcours && typeof r.parcours === "object" ? r.parcours : {}) as Record<string, unknown>;
      return {
        voie: VOIES.some((x) => x.id === pc.voie) ? (pc.voie as Voie) : "scolaire",
        requiredWeeks: Math.max(0, Math.min(60, num(pc.requiredWeeks, DEFAULT_REQUIRED_WEEKS))),
      };
    })(),
    solutions: Object.fromEntries(
      Object.entries(
        (r.solutions && typeof r.solutions === "object" ? r.solutions : {}) as Record<string, unknown>,
      ).flatMap(([k, val]) => (ACTIVITY_BY_ID.has(k) && typeof val === "string" && val.trim() ? [[k, val]] : [])),
    ),
    visa: { date: str(v.date), note: str(v.note) },
    dossierE51,
  };
}
