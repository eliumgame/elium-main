/**
 * Logique pure du passeport (aucun accès navigateur → testable sous Node).
 * Reproduit les automatismes des macros du classeur officiel : numérotation des
 * fiches, copie, suppression, tâches ↔ activités, transfert vers le passeport,
 * matrice synoptique activités × modalités et tâches « grisées ».
 */
import { REFERENTIEL } from "./referentiel";
import type {
  ContexteItem,
  Holder,
  Modalite,
  PassportData,
  RefActivity,
  RefDomain,
  RefTask,
  Situation,
  Stage,
  TransferSnapshot,
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

export function emptyPassport(now = new Date().toISOString()): PassportData {
  return {
    version: 1,
    updatedAt: now,
    holder: emptyHolder(),
    situations: [],
    contexte: emptyContexte(),
    stages: [],
    visa: { date: "", note: "" },
  };
}

export function newStage(id: string): Stage {
  return {
    id,
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
      list.push({ spId: s.id, period: periodLabel(t) });
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
  /** Onglet où corriger. */
  tab?: "dashboard" | "situations" | "passport" | "referentiel" | "contexte" | "stages";
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
  const validated = data.situations.filter((s) => s.transfer);
  const stale = data.situations.filter((s) => isStale(s));
  const cov = activityCoverage(data).filter((c) => isE4Activity(c.activity.id));
  const uncovered = cov.filter((c) => c.situations.length === 0).map((c) => c.activity.id);
  const ctxDone = data.contexte.filter((c) => c.done).length;
  const ctxTotal = CONTEXTE_ITEMS.length;
  const incomplete = data.situations.filter((s) => completion(s) < 100).length;
  const reviewed = data.situations.filter((s) => s.relue).length;
  const withAttestation = data.stages.filter((s) => s.attestationRecue).length;
  return [
    {
      id: "holder",
      label: "Identification du candidat complète",
      ok: missingHolder.length === 0,
      detail: missingHolder.length ? `Manque : ${missingHolder.join(", ")}` : undefined,
      tab: "dashboard",
    },
    {
      id: "situations",
      label: "Au moins une situation professionnelle rédigée",
      ok: data.situations.length > 0,
      tab: "situations",
    },
    {
      id: "validated",
      label: "Situations validées dans le passeport",
      ok: validated.length > 0 && stale.length === 0,
      detail: stale.length
        ? `${stale.length} fiche(s) modifiée(s) depuis leur transfert (${stale.map((s) => spLabel(s.id)).join(", ")})`
        : validated.length === 0
          ? "Aucune situation validée"
          : `${validated.length} / ${data.situations.length} situation(s) validée(s)`,
      tab: "situations",
    },
    {
      id: "complete",
      label: "Toutes les fiches complètement rédigées",
      ok: data.situations.length > 0 && incomplete === 0,
      detail: incomplete ? `${incomplete} fiche(s) à compléter` : undefined,
      tab: "situations",
    },
    {
      id: "coverage",
      label: "Les 6 activités E4 (1.1 à 1.6) couvertes au moins une fois",
      ok: uncovered.length === 0,
      detail: uncovered.length ? `Non couvertes : ${uncovered.join(", ")}` : undefined,
      tab: "passport",
    },
    {
      id: "contexte",
      label: "Contexte commercial présenté (12 éléments)",
      ok: ctxDone === ctxTotal,
      detail: `${ctxDone} / ${ctxTotal}`,
      tab: "contexte",
    },
    {
      id: "stages",
      label: "Attestation de stage (ou certificat de travail) pour chaque période",
      ok: data.stages.length > 0 && withAttestation === data.stages.length,
      detail: data.stages.length ? `${withAttestation} / ${data.stages.length} reçue(s)` : "Aucune période saisie",
      tab: "stages",
    },
    {
      id: "review",
      label: "Fiches relues par l'équipe pédagogique",
      ok: data.situations.length > 0 && reviewed === data.situations.length,
      detail: data.situations.length ? `${reviewed} / ${data.situations.length}` : undefined,
      tab: "situations",
    },
    {
      id: "visa",
      label: "Passeport visé par l'équipe pédagogique",
      ok: !!data.visa.date,
      tab: "passport",
    },
  ];
}

export function dossierProgress(items: ChecklistItem[]): number {
  return items.length ? Math.round((items.filter((i) => i.ok).length / items.length) * 100) : 0;
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
      else (st[k] as string) = str(o[k], st[k] as string);
    }
    return [st];
  });
  const v = (r.visa && typeof r.visa === "object" ? r.visa : {}) as Record<string, unknown>;
  return {
    version: 1,
    updatedAt: str(r.updatedAt, base.updatedAt),
    holder,
    situations,
    contexte,
    stages,
    visa: { date: str(v.date), note: str(v.note) },
  };
}
