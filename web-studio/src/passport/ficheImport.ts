/**
 * Import d'une fiche d'analyse existante (Word du classeur officiel ou d'Elium, PDF produit par Elium ou issu du
 * modèle Word, texte brut) : le texte est lu dans l'ordre, découpé selon les intitulés fixes du modèle officiel, puis
 * reversé dans une fiche de situation. L'import ne devine jamais en silence : il liste les rubriques trouvées et celles qui
 * manquent, et les cases à cocher illisibles sont signalées.
 */
import { MOIS, newSituation } from "./model";
import type { Condition, Holder, Modalite, Nature, Situation } from "./types";

export interface ImportReport {
  /** Rubriques retrouvées. */
  found: string[];
  /** Rubriques du modèle absentes ou vides. */
  missing: string[];
  warnings: string[];
}

export interface ImportedFiche {
  sourceName: string;
  /** Numéro lu dans la fiche (« SP3 » → 3), s'il y en a un. */
  number?: number;
  situation: Situation;
  holder: Partial<Holder>;
  report: ImportReport;
}

type Key =
  | "title"
  | "ident"
  | "modalite"
  | "periode"
  | "condition"
  | "activites"
  | "intitule"
  | "lieu"
  | "cadre"
  | "enjeux"
  | "dGrcf"
  | "dOral"
  | "dEcrit"
  | "acteurs"
  | "objectif"
  | "conditions"
  | "ressources"
  | "solutions"
  | "productions"
  | "ecrits"
  | "oraux"
  | "analyseBand"
  | "analyse"
  | "contribution";

const START = String.raw`(?:^|\n)[ \t]*`;
const W = String.raw`\s+`;
/** Intitulés fixes du modèle, dans leur ordre d'apparition. */
const LABELS: [Key, RegExp][] = [
  ["title", new RegExp(`${START}Fiche${W}d[’']analyse${W}de${W}situation${W}professionnelle`, "i")],
  ["ident", new RegExp(`${START}Identification${W}de${W}la${W}situation${W}professionnelle`, "i")],
  ["modalite", new RegExp(`${START}Modalit[ée]${W}de${W}r[ée]alisation`, "i")],
  ["periode", new RegExp(`${START}P[ée]riode${W}de${W}r[ée]alisation`, "i")],
  ["condition", new RegExp(`${START}Condition${W}de${W}r[ée]alisation`, "i")],
  ["activites", new RegExp(`${START}Activit[ée]s${W}concern[ée]es`, "i")],
  ["intitule", new RegExp(`${START}Intitul[ée]${W}de${W}la${W}situation${W}professionnelle`, "i")],
  ["lieu", new RegExp(`${START}Lieu,?${W}p[ée]riode${W}et${W}dur[ée]e${W}de${W}r[ée]alisation`, "i")],
  ["cadre", new RegExp(`${START}Cadre${W}de${W}la${W}situation${W}professionnelle`, "i")],
  [
    "enjeux",
    new RegExp(`${START}Probl[èe]me${W}de${W}gestion${W}soulev[ée]${W}et${W}enjeux${W}de${W}la${W}situation`, "i"),
  ],
  ["dGrcf", new RegExp(`${START}De${W}GRCF`, "i")],
  ["dOral", new RegExp(`${START}De${W}communication${W}orale`, "i")],
  ["dEcrit", new RegExp(`${START}De${W}communication${W}[ée]crite`, "i")],
  ["acteurs", new RegExp(`${START}Acteurs${W}et${W}relations?${W}entre${W}les${W}acteurs`, "i")],
  ["objectif", new RegExp(`${START}Objectif[ \\t]*(?=\\n|$|:)`, "i")],
  [
    "conditions",
    new RegExp(
      `${START}Conditions${W}de${W}r[ée]alisation${W}?:?${W}?contraintes${W}dont${W}le${W}processus${W}et${W}organisation${W}comptable,?${W}environnement${W}num[ée]rique`,
      "i",
    ),
  ],
  ["ressources", new RegExp(`${START}Ressources${W}[àa]${W}disposition`, "i")],
  [
    "solutions",
    new RegExp(`${START}Solutions${W}logicielles${W}choisies${W}et${W}fonctionnalit[ée]s${W}mobilis[ée]es`, "i"),
  ],
  ["productions", new RegExp(`${START}Productions${W}r[ée]alis[ée]es`, "i")],
  ["ecrits", new RegExp(`${START}[ÉE]crits${W}professionnels(?:${W}produits)?`, "i")],
  ["oraux", new RegExp(`${START}Oraux${W}professionnels`, "i")],
  ["analyseBand", new RegExp(`${START}ANALYSE[ \t]*(?=\n|$)`)],
  ["analyse", new RegExp(`${START}Analyse${W}de${W}la${W}situation`, "i")],
  [
    "contribution",
    new RegExp(
      `${START}Contribution${W}de${W}la${W}situation${W}professionnelle${W}[àa]${W}la${W}professionnalisation`,
      "i",
    ),
  ],
];

const RUBRIC_NAMES: Partial<Record<Key, string>> = {
  intitule: "Intitulé",
  lieu: "Lieu, période et durée",
  cadre: "Cadre",
  dGrcf: "Problème de gestion (GRCF)",
  dOral: "Problème de communication orale",
  dEcrit: "Problème de communication écrite",
  acteurs: "Acteurs et relations",
  objectif: "Objectif",
  conditions: "Conditions de réalisation",
  ressources: "Ressources à disposition",
  solutions: "Solutions logicielles",
  productions: "Productions réalisées",
  ecrits: "Écrits professionnels",
  oraux: "Oraux professionnels",
  analyse: "Analyse de la situation",
  contribution: "Contribution à la professionnalisation",
};

// Aussi les glyphes Wingdings / Webdings (zone privée) que Word et les PDF issus de Word emploient pour les cases.
const CHECKED = /[☒☑☑✓✔]|\[\s*[xX]\s*\]/;
const UNCHECKED = /[☐□]|\[\s\]/;

/** Coche située juste avant `label` dans `seg` : true / false, ou null si aucune case n'est lisible. */
function markBefore(seg: string, label: RegExp): boolean | null {
  const m = label.exec(seg);
  if (!m) return null;
  const before = seg.slice(Math.max(0, m.index - 12), m.index);
  const last = [...before.matchAll(new RegExp(`${CHECKED.source}|${UNCHECKED.source}`, "g"))].pop();
  if (!last) return null;
  return CHECKED.test(last[0]);
}

const clean = (s: string) =>
  s
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[.…]{3,}\s*$/gm, "")
    .trim();

/** Texte lu → fiche. Pur : aucune lecture de fichier ici (testable sous Node). */
export function parseFicheText(raw: string, sourceName = "fiche"): ImportedFiche {
  const text = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const pos = new Map<Key, { start: number; end: number }>();
  let cursor = 0;
  for (const [key, re] of LABELS) {
    const sub = text.slice(cursor);
    const m = re.exec(sub);
    if (!m) continue;
    const start = cursor + m.index + (m[0].length - m[0].replace(/^\s+/, "").length);
    const end = cursor + m.index + m[0].length;
    pos.set(key, { start, end });
    cursor = end;
  }
  // Valeur d'une rubrique : du bout de son intitulé au début de l'intitulé suivant trouvé.
  const order = LABELS.map(([k]) => k);
  const rawValueOf = (key: Key): string | undefined => {
    const p = pos.get(key);
    if (!p) return undefined;
    let next = text.length;
    for (const k of order.slice(order.indexOf(key) + 1)) {
      const q = pos.get(k);
      if (q) {
        next = q.start;
        break;
      }
    }
    return clean(text.slice(p.end, next));
  };
  // Certains PDF (et les tableaux Word) sortent « plusieurs intitulés d'affilée, puis leurs valeurs » : on répartit
  // les lignes de la dernière valeur sur les intitulés restés vides, seulement si le compte tombe juste.
  const distributed = new Map<Key, string>();
  const found = order.filter((k) => pos.has(k));
  for (let i = 0; i < found.length; i++) {
    let j = i;
    while (j + 1 < found.length && !rawValueOf(found[j])) j++;
    if (j === i) continue;
    const run = found.slice(i, j + 1);
    const lines = (rawValueOf(found[j]) ?? "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    // Analyse / contribution : valeurs multi-lignes, jamais réparties ligne à ligne.
    if (run.some((k) => k === "analyse" || k === "contribution" || k === "analyseBand")) continue;
    if (lines.length === run.length) run.forEach((k, n) => distributed.set(k, lines[n]));
    i = j;
  }
  const valueOf = (key: Key): string | undefined => {
    const v = distributed.get(key) ?? rawValueOf(key);
    // PDF : le texte de l'analyse sort entre le bandeau « ANALYSE » et l'intitulé « Analyse de la situation ».
    // Ordre PDF : bandeau, texte d'analyse, intitulé « Analyse… », texte de contribution, intitulé « Contribution… ».
    const band = rawValueOf("analyseBand");
    const shifted = !!band && !rawValueOf("contribution");
    if (shifted && key === "analyse") return band;
    if (shifted && key === "contribution") return rawValueOf("analyse") || v;
    return v;
  };
  const segment = (a: Key, b: Key): string => {
    const pa = pos.get(a);
    if (!pa) return "";
    const pb = pos.get(b);
    return text.slice(pa.end, pb ? pb.start : text.length);
  };

  const s = newSituation(1, new Date());
  const report: ImportReport = { found: [], missing: [], warnings: [] };
  const holder: Partial<Holder> = {};

  // ---- en-tête (avant le titre) : session, nom, numéro
  const head = text.slice(0, pos.get("title")?.start ?? Math.min(text.length, 600));
  const session = /Session\s+(\d{4})/i.exec(head)?.[1];
  if (session) holder.session = session;
  const nm = /NOM\s+et\s+pr[ée]nom\s+du\s+candidat\s*\n?\s*([^\n]+)/i.exec(head)?.[1]?.trim();
  if (nm && !/^<.*>$/.test(nm)) {
    const parts = nm.split(/\s+/);
    const last = parts.findIndex((w) => w === w.toUpperCase() && /[A-ZÀ-Ý]{2}/.test(w));
    if (last === 0) {
      let k = 0;
      while (k < parts.length && parts[k] === parts[k].toUpperCase()) k++;
      holder.nom = parts.slice(0, k).join(" ");
      holder.prenom = parts.slice(k).join(" ");
    } else holder.nom = nm;
  }
  const num = /Num[ée]ro\s+de\s+candidat\s*:?\s*\n?\s*([^\n]+)/i.exec(head)?.[1]?.trim();
  if (num && !/^<.*>$/.test(num)) holder.numeroCandidat = num;

  // Métadonnées invisibles écrites par Elium dans ses PDF (prioritaires sur la lecture des cases).
  const meta = /ELIUMFICHE;sp=(\d+);mod=([a-z]*);cond=([a-z]*);nat=([a-z,]*);act=([\d.,]*);/.exec(text);

  // ---- nature (cases avant le bandeau d'identification)
  const natSeg = segment("title", "ident") || text.slice(0, 400);
  const natures: Nature[] = [];
  const nat: [Nature, RegExp][] = [
    ["grcf", /GRCF/i],
    ["orale", /Communication\s+orale/i],
    ["ecrite", /Communication\s+[ée]crite/i],
  ];
  const natMarks = nat.map(([n, re]) => [n, markBefore(natSeg, re)] as const);
  if (natMarks.every(([, v]) => v === null))
    report.warnings.push("Nature de la situation : cases à cocher illisibles (PDF sans coches) — à vérifier.");
  for (const [n, v] of natMarks) if (v) natures.push(n);

  // ---- identification
  const identSeg = segment("ident", "intitule");
  // PDF : l'ordre de lecture des blocs varie, le « SPn » peut sortir hors du segment — repli sur tout le texte.
  const id = /SP\s*(\d+)/i.exec(identSeg)?.[1] ?? /\bSP\s*(\d{1,2})\b/.exec(text)?.[1];
  let number: number | undefined;
  if (id) {
    number = Number(id);
    report.found.push("Numéro de fiche");
  } else report.missing.push("Numéro de fiche");

  const modSeg = segment("modalite", "periode");
  const mod: [Modalite, RegExp][] = [
    ["avant", /Avant\s+la\s+formation/i],
    ["etablissement", /Pendant\s+la\s+formation\s+en\s+[ée]tablissement/i],
    ["pme", /Pendant\s+la\s+formation\s+en\s+milieu\s+professionnel/i],
  ];
  const modMarks = mod.map(([m, re]) => [m, markBefore(modSeg, re)] as const);
  const chosen = modMarks.find(([, v]) => v);
  if (chosen) {
    s.modalite = chosen[0];
    report.found.push("Modalité de réalisation");
  } else if (modMarks.some(([, v]) => v === null))
    report.warnings.push("Modalité de réalisation : case illisible — « en établissement » par défaut.");
  else report.missing.push("Modalité de réalisation");

  const perSeg = segment("periode", "condition");
  const monthIdx = MOIS.findIndex((m) =>
    new RegExp(
      m
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .slice(0, 4),
      "i",
    ).test(perSeg.normalize("NFD").replace(/\p{Diacritic}/gu, "")),
  );
  const year = /(20\d{2})/.exec(perSeg)?.[1];
  if (monthIdx >= 0) s.mois = monthIdx + 1;
  if (year) s.annee = Number(year);
  if (monthIdx >= 0 || year) report.found.push("Période de réalisation");
  else report.missing.push("Période de réalisation");

  const condSeg = segment("condition", "activites");
  const cond: [Condition, RegExp][] = [
    ["autonomie", /En\s+autonomie/i],
    ["accompagnee", /Accompagn[ée]e/i],
    ["observation", /En\s+observation/i],
  ];
  const condChosen = cond.map(([c, re]) => [c, markBefore(condSeg, re)] as const).find(([, v]) => v);
  if (condChosen) {
    s.condition = condChosen[0];
    report.found.push("Condition de réalisation");
  } else report.missing.push("Condition de réalisation");

  const actSeg = segment("activites", "intitule");
  const acts: string[] = [];
  for (const a of ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]) {
    if (markBefore(actSeg, new RegExp(`Activit[ée]\\s+${a.replace(".", "\\.")}`, "i"))) acts.push(a);
  }
  if (acts.length) {
    s.activityIds = acts;
    report.found.push("Activités concernées");
  } else report.missing.push("Activités concernées (cases illisibles ou aucune cochée)");

  if (meta) {
    const drop = /^(Nature de la situation|Modalité de réalisation|Condition de réalisation|Activités concernées)/;
    report.warnings = report.warnings.filter((w) => !drop.test(w));
    report.missing = report.missing.filter((m) => !drop.test(m));
    const mk = (n: string) => {
      if (!report.found.includes(n)) report.found.push(n);
    };
    if (["avant", "etablissement", "pme"].includes(meta[2])) {
      s.modalite = meta[2] as Modalite;
      mk("Modalité de réalisation");
    }
    if (["autonomie", "accompagnee", "observation"].includes(meta[3])) {
      s.condition = meta[3] as Condition;
      mk("Condition de réalisation");
    }
    natures.length = 0;
    natures.push(...(meta[4].split(",").filter((n) => ["grcf", "orale", "ecrite"].includes(n)) as Nature[]));
    acts.length = 0;
    acts.push(...meta[5].split(",").filter(Boolean));
    if (acts.length) {
      s.activityIds = [...acts];
      mk("Activités concernées");
    }
  }

  // ---- rubriques de texte
  const put = (key: Key, set: (v: string) => void) => {
    const v = valueOf(key);
    const name = RUBRIC_NAMES[key] ?? key;
    if (v && !/^<.*>$/.test(v)) {
      set(v);
      report.found.push(name);
    } else report.missing.push(name);
  };
  put("intitule", (v) => (s.intitule = v));
  put("lieu", (v) => (s.lieuPeriodeDuree = v));
  put("cadre", (v) => (s.cadre = v));
  // Les trois enjeux : « En-tête, valeur » × 3 (PDF) ou « 3 en-têtes puis 3 valeurs » (tableau Word du modèle).
  const eG = valueOf("dGrcf");
  const eO = valueOf("dOral");
  const eE = valueOf("dEcrit");
  if (!eG && !eO && eE) {
    const parts = eE
      .split(/\n{2,}|\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const wanted: Nature[] = natures.length
      ? natures
      : (["grcf", "orale", "ecrite"] as Nature[]).slice(0, Math.min(3, parts.length));
    if (parts.length === wanted.length) {
      wanted.forEach((n, i) => {
        if (n === "grcf") s.problemeGestion = parts[i];
        else if (n === "orale") s.problemeOral = parts[i];
        else s.problemeEcrit = parts[i];
      });
      report.found.push(
        ...wanted.map((n) => RUBRIC_NAMES[n === "grcf" ? "dGrcf" : n === "orale" ? "dOral" : "dEcrit"]!),
      );
    } else {
      s.problemeGestion = parts.join("\n");
      report.found.push(RUBRIC_NAMES.dGrcf!);
      report.warnings.push(
        "Enjeux : découpage entre GRCF / oral / écrit incertain, tout est placé dans « GRCF » — à répartir.",
      );
    }
  } else {
    put("dGrcf", (v) => (s.problemeGestion = v));
    put("dOral", (v) => (s.problemeOral = v));
    put("dEcrit", (v) => (s.problemeEcrit = v));
  }
  put("acteurs", (v) => (s.acteurs = v));
  put("objectif", (v) => (s.objectif = v));
  put("conditions", (v) => (s.conditions = v));
  put("ressources", (v) => (s.ressources = v));
  put("solutions", (v) => (s.solutions = v));
  put("productions", (v) => (s.productions = v));
  put("ecrits", (v) => (s.ecrits = v));
  put("oraux", (v) => (s.oraux = v));
  put("analyse", (v) => (s.analyse = v));
  put("contribution", (v) => (s.contribution = v));

  // natures : lues sur les cases, sinon déduites des problèmes renseignés
  if (natures.length) s.natures = natures;
  else {
    const inferred: Nature[] = [];
    if (s.problemeGestion) inferred.push("grcf");
    if (s.problemeOral) inferred.push("orale");
    if (s.problemeEcrit) inferred.push("ecrite");
    s.natures = inferred.length ? inferred : ["grcf"];
  }
  if (pos.size < 6)
    report.warnings.push("Peu d'intitulés du modèle reconnus : ce fichier n'est peut-être pas une fiche d'analyse E4.");

  s.id = number ?? 1;
  return { sourceName, number, situation: s, holder, report };
}

/** Lit un fichier (docx, pdf, elium, txt, md) et en fait une fiche. */
/**
 * Word garde ses cases dans des contrôles (w14:checkbox), des champs de formulaire hérités ou des symboles Wingdings,
 * que la conversion en texte efface : on les remplace d'abord par ☒ / ☐ dans le XML.
 */
export async function withReadableCheckboxes(file: File): Promise<File> {
  try {
    const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const doc = files["word/document.xml"];
    if (!doc) return file;
    const run = (c: boolean) => `<w:r><w:t>${c ? "☒" : "☐"}</w:t></w:r>`;
    const on = (v: string | undefined) => v === undefined || /^(1|true|on)$/i.test(v);
    let x = strFromU8(doc);
    const before = x;
    // 1. contrôles de contenu « case à cocher »
    x = x.replace(/<w:sdt>(?:(?!<w:sdt>)[\s\S])*?<\/w:sdt>/g, (m) => {
      if (!m.includes("<w14:checkbox")) return m;
      const v = /<w14:checked(?=[\s/>])[^>]*w14:val="([^"]*)"/.exec(m)?.[1];
      return run(v !== undefined && on(v));
    });
    // 2. champs de formulaire hérités (FORMCHECKBOX)
    x = x.replace(
      /<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:ffData>(?:(?!<\/w:ffData>)[\s\S])*?<w:checkBox>[\s\S]*?<\/w:ffData>[\s\S]*?<\/w:r>/g,
      (m) => {
        const cb = /<w:checkBox>([\s\S]*?)<\/w:checkBox>/.exec(m)?.[1] ?? "";
        const chk = /<w:checked(?=[\s/>])(?:[^>]*w:val="([^"]*)")?[^>]*\/>/.exec(cb);
        const def = /<w:default(?=[\s/>])[^>]*w:val="([^"]*)"/.exec(cb)?.[1];
        return run(chk ? on(chk[1]) : def !== undefined && on(def));
      },
    );
    // 3. symboles Wingdings
    x = x.replace(/<w:sym(?=\s)[^>]*w:char="([0-9A-Fa-f]{4})"[^>]*\/>/g, (_m, ch: string) => {
      const c = ch.toUpperCase();
      if (["F0FE", "F0FD", "F0FC", "F078", "F0FB"].includes(c)) return "<w:t>☒</w:t>";
      if (["F0A8", "F06F", "F0A3", "F071"].includes(c)) return "<w:t>☐</w:t>";
      return _m;
    });
    if (x === before) return file;
    files["word/document.xml"] = strToU8(x);
    return new File([zipSync(files) as BlobPart], file.name, { type: file.type });
  } catch {
    return file;
  }
}

export async function importFicheFile(file: File): Promise<ImportedFiche> {
  const name = file.name;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  let text: string;
  if (ext === "txt" || ext === "md" || ext === "text") text = await file.text();
  else {
    if (ext === "docx") file = await withReadableCheckboxes(file);
    // Réutilise l'ingestion du Détecteur (docx, pdf, .elium) : mêmes lecteurs, déjà éprouvés.
    const { loadDocumentModel } = await import("../detector/ingest/loadFile");
    const model = await loadDocumentModel(file);
    text = model.paragraphs.map((p) => p.text).join("\n");
  }
  if (!text.trim())
    throw new Error(`« ${name} » ne contient aucun texte lisible (PDF scanné ? passez-le par l'OCR du module PDF).`);
  return parseFicheText(text, name);
}
