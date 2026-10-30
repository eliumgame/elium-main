/**
 * Modèles de documents (voir Cahier des charges §6 — Modèles).
 *
 * Chaque modèle est un vrai document structuré : titres hiérarchisés, accroche,
 * tableaux stylés (styles de tableau intégrés), listes, filets, en-tête / pied
 * de page et marges propres. Le contenu d'exemple est réaliste et en français ;
 * les passages à remplacer sont des valeurs plausibles, pas des pointillés.
 * Palette : teintes moyennes (ardoise, bleu Elium) lisibles en thème clair comme sombre ;
 * le texte courant garde la couleur du thème.
 */
import type { PageSettings, ProseMirrorNode } from "../format/types";

type Node = ProseMirrorNode;
type Align = "left" | "center" | "right" | "justify";

const SLATE = "#64748b";
const MUTED = "#7b8794";
const BLUE = "#2563eb";

interface Fmt {
  b?: boolean;
  i?: boolean;
  color?: string;
  size?: number;
  caps?: boolean;
  spacing?: string;
}

/** Texte brut, ou mis en forme (gras, italique, couleur, taille, capitales). */
const text = (t: string, f: Fmt = {}): Node => {
  const marks: NonNullable<Node["marks"]> = [];
  if (f.b) marks.push({ type: "bold" });
  if (f.i) marks.push({ type: "italic" });
  const attrs: Record<string, unknown> = {};
  if (f.color) attrs.color = f.color;
  if (f.size) attrs.fontSize = `${f.size}px`;
  if (f.caps) attrs.allCaps = true;
  if (f.spacing) attrs.letterSpacing = f.spacing;
  if (Object.keys(attrs).length) marks.push({ type: "textStyle", attrs });
  // Espaces insécables : milliers, « € », « % » et ponctuation haute ne se coupent pas en fin de ligne.
  const nb = t.replace(/(\d) (?=\d{3})/g, "$1 ").replace(/ (€|%|:|;|!|\?)/g, " $1");
  return { type: "text", text: nb, ...(marks.length ? { marks } : {}) };
};
const b = (t: string): Node => text(t, { b: true });
const muted = (t: string, size?: number): Node => text(t, { color: MUTED, ...(size ? { size } : {}) });

const para = (align: Align | undefined, c: Node[]): Node => ({
  type: "paragraph",
  ...(align && align !== "left" ? { attrs: { textAlign: align } } : {}),
  ...(c.length ? { content: c } : {}),
});
const p = (...c: Node[]): Node => para(undefined, c);
const pa = (align: Align, ...c: Node[]): Node => para(align, c);
const h = (level: number, t: string, f: Fmt = {}, align?: Align): Node => ({
  type: "heading",
  attrs: { level, ...(align ? { textAlign: align } : {}) },
  content: [text(t, f)],
});
/** Petite étiquette en capitales espacées, au-dessus d'un titre. */
const kicker = (t: string, align?: Align): Node =>
  para(align, [text(t, { b: true, caps: true, size: 12, color: BLUE, spacing: "0.14em" })]);
const lead = (t: string, align?: Align): Node => para(align, [text(t, { size: 18, color: SLATE })]);
const rule = (): Node => ({ type: "horizontalRule" });
const gap = (): Node => p();

const li = (...c: Node[]): Node => ({ type: "listItem", content: [p(...c)] });
const ul = (...items: (string | Node[])[]): Node => ({
  type: "bulletList",
  content: items.map((it) => li(...(typeof it === "string" ? [text(it)] : it))),
});
const ol = (...items: (string | Node[])[]): Node => ({
  type: "orderedList",
  content: items.map((it) => li(...(typeof it === "string" ? [text(it)] : it))),
});
const doc = (...content: Node[]): Node => ({ type: "doc", content });

export type TemplateCategory = "Général" | "Courrier" | "Professionnel" | "Réunion" | "Finance";

export interface Template {
  id: string;
  label: string;
  description: string;
  category?: TemplateCategory;
  /** Mise en page propre au modèle (en-tête, pied de page, marges, numéros). */
  page?: Partial<PageSettings>;
  build(): { title: string; doc: Node };
}

/* ------------------------------ Tableaux ------------------------------ */

type CellSpec = string | Node | Node[];
const cellBlocks = (c: CellSpec, align?: Align, bold?: boolean): Node[] =>
  typeof c === "string" ? [para(align, c ? [text(c, bold ? { b: true } : {})] : [])] : Array.isArray(c) ? c : [c];
const cell = (c: CellSpec, o: { header?: boolean; align?: Align; bold?: boolean; width?: number } = {}): Node => ({
  type: o.header ? "tableHeader" : "tableCell",
  ...(o.width ? { attrs: { colwidth: [o.width] } } : {}),
  content: cellBlocks(c, o.align, o.bold),
});
const row = (
  cells: CellSpec[],
  o: { header?: boolean; aligns?: Align[]; bold?: boolean; widths?: number[] } = {},
): Node => ({
  type: "tableRow",
  content: cells.map((c, i) => cell(c, { header: o.header, align: o.aligns?.[i], bold: o.bold, width: o.widths?.[i] })),
});
/** Tableau à ligne d'en-tête, avec l'un des styles de tableau intégrés. */
const table = (style: string, head: string[], rows: CellSpec[][], aligns?: Align[], widths?: number[]): Node => ({
  type: "table",
  attrs: { tableStyle: style },
  content: [row(head, { header: true, aligns, widths }), ...rows.map((r) => row(r, { aligns, widths }))],
});
/** Tableau sans en-tête (mise en page en colonnes, fiches clé / valeur). */
const layout = (style: string, rows: CellSpec[][], aligns?: Align[], widths?: number[]): Node => ({
  type: "table",
  attrs: { tableStyle: style },
  content: rows.map((r) => row(r, { aligns, widths })),
});
/* ------------------------------ Modèles ------------------------------ */

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    category: "Général",
    label: "Document vierge",
    description: "Page blanche pour démarrer librement.",
    build: () => ({
      title: "Document sans titre",
      doc: doc(h(1, "Titre du document"), p(text("Commencez à rédiger…"))),
    }),
  },
  {
    id: "contrat",
    category: "Professionnel",
    label: "Contrat",
    description: "Accord entre deux parties avec clauses et signatures.",
    page: { footer: "Contrat de prestation de services — Parafes : ______ / ______", showPageNumbers: true },
    build: () => ({
      title: "Contrat de prestation de services",
      doc: doc(
        kicker("Contrat", "center"),
        h(1, "Contrat de prestation de services", {}, "center"),
        pa("center", muted("Référence CT-2026-014 · Établi en deux exemplaires originaux")),
        rule(),
        h(2, "Entre les parties"),
        layout("grid", [
          [
            [
              p(text("LE PRESTATAIRE", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Atelier Lumière SAS")),
              p(text("12 rue des Tanneurs, 69002 Lyon")),
              p(text("SIREN 912 345 678 — représentée par Camille Roux, présidente")),
            ],
            [
              p(text("LE CLIENT", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Maison Verdier SARL")),
              p(text("48 avenue de la République, 75011 Paris")),
              p(text("SIREN 845 120 337 — représentée par Hugo Verdier, gérant")),
            ],
          ],
        ]),
        gap(),
        h(2, "Article 1 — Objet"),
        pa(
          "justify",
          text(
            "Le Prestataire s'engage à réaliser pour le Client la refonte de son site internet vitrine, comprenant la conception graphique, l'intégration et la mise en ligne, selon le cahier des charges validé par les parties le 12 janvier 2026 et annexé au présent contrat.",
          ),
        ),
        h(2, "Article 2 — Durée"),
        pa(
          "justify",
          text(
            "Le contrat prend effet à la date de signature et s'achève à la livraison finale, prévue le 30 avril 2026. Toute prolongation fait l'objet d'un avenant écrit signé des deux parties.",
          ),
        ),
        h(2, "Article 3 — Conditions financières"),
        pa(
          "justify",
          text("Le prix forfaitaire de la prestation est de "),
          b("8 400,00 € HT"),
          text(", soit 10 080,00 € TTC, payable selon l'échéancier suivant :"),
        ),
        ul(
          [b("30 % "), text("à la signature, soit 2 520,00 € HT")],
          [b("40 % "), text("à la validation des maquettes, soit 3 360,00 € HT")],
          [b("30 % "), text("à la livraison finale, soit 2 520,00 € HT")],
        ),
        pa(
          "justify",
          text(
            "Les factures sont payables à 30 jours. Tout retard donne lieu à des pénalités égales à trois fois le taux d'intérêt légal.",
          ),
        ),
        h(2, "Article 4 — Confidentialité"),
        pa(
          "justify",
          text(
            "Chaque partie s'interdit de divulguer les informations confidentielles de l'autre partie, pendant la durée du contrat et pendant cinq ans après son terme.",
          ),
        ),
        h(2, "Article 5 — Résiliation et litiges"),
        pa(
          "justify",
          text(
            "Chaque partie peut résilier le contrat en cas de manquement grave de l'autre, après mise en demeure restée sans effet pendant quinze jours. À défaut d'accord amiable, le litige relève du tribunal de commerce de Lyon.",
          ),
        ),
        gap(),
        pa("left", text("Fait à Lyon, le 15 février 2026, en deux exemplaires originaux.", { i: true, color: SLATE })),
        layout("minimal", [
          [
            [
              p(b("Pour le Prestataire")),
              p(muted("Camille Roux, présidente", 13)),
              p(),
              p(),
              p(muted("Signature précédée de « Lu et approuvé »", 12)),
            ],
            [
              p(b("Pour le Client")),
              p(muted("Hugo Verdier, gérant", 13)),
              p(),
              p(),
              p(muted("Signature précédée de « Lu et approuvé »", 12)),
            ],
          ],
        ]),
      ),
    }),
  },
  {
    id: "attestation",
    category: "Courrier",
    label: "Attestation",
    description: "Attestation officielle datée et signée.",
    page: { margins: { top: 30, right: 30, bottom: 25, left: 30 } },
    build: () => ({
      title: "Attestation sur l'honneur",
      doc: doc(
        kicker("Document officiel", "center"),
        h(1, "Attestation sur l'honneur", {}, "center"),
        rule(),
        gap(),
        pa(
          "justify",
          text("Je soussignée "),
          b("Claire Martin"),
          text(", née le 4 mars 1989 à Nantes (44), demeurant 27 rue des Lilas, 44000 Nantes,"),
        ),
        pa("center", text("atteste sur l'honneur", { b: true, size: 20, color: BLUE })),
        pa(
          "justify",
          text(
            "que j'héberge à titre gratuit et de manière continue, à l'adresse indiquée ci-dessus, Monsieur Paul Martin, né le 17 juillet 1962 à Rennes (35), depuis le 1er septembre 2025.",
          ),
        ),
        pa(
          "justify",
          text(
            "Je certifie l'exactitude des informations déclarées et suis informée que toute fausse déclaration m'expose aux sanctions prévues par l'article 441-7 du code pénal.",
          ),
        ),
        pa("justify", text("Cette attestation est établie pour servir et valoir ce que de droit.")),
        gap(),
        pa("right", text("Fait à Nantes, le 6 mars 2026")),
        gap(),
        pa("right", b("Claire Martin")),
        pa("right", muted("Signature", 13)),
        gap(),
        gap(),
        pa(
          "left",
          muted(
            "Pièces jointes : copie de la pièce d'identité de l'hébergeant, justificatif de domicile de moins de trois mois.",
            13,
          ),
        ),
      ),
    }),
  },
  {
    id: "rapport",
    category: "Professionnel",
    label: "Rapport",
    description: "Rapport structuré avec sections et synthèse.",
    page: { header: "Rapport d'activité — T1 2026", showPageNumbers: true, numberedHeadings: true },
    build: () => ({
      title: "Rapport d'activité — T1 2026",
      doc: doc(
        kicker("Rapport trimestriel"),
        h(1, "Rapport d'activité du premier trimestre 2026"),
        lead("Direction commerciale — synthèse des résultats et recommandations"),
        pa("left", muted("Rédigé par Sophie Lambert · 3 avril 2026 · Diffusion interne")),
        rule(),
        h(2, "Synthèse"),
        p(
          text("Le premier trimestre confirme la dynamique de fin d'année : le chiffre d'affaires atteint "),
          b("1,42 M€"),
          text(", en hausse de "),
          text("+12 %", { b: true, color: BLUE }),
          text(" par rapport au T1 2025, avec une marge opérationnelle stable à 18 %. Trois constats ressortent :"),
        ),
        ul(
          "La région Auvergne-Rhône-Alpes porte la croissance (+21 %).",
          "Le taux de rétention client progresse de 4 points, à 91 %.",
          "Les délais de livraison restent le principal point de vigilance.",
        ),
        h(2, "Contexte"),
        p(
          text(
            "Le trimestre s'est déroulé dans un marché contrasté : la demande des grands comptes est restée soutenue, tandis que les petites structures ont allongé leurs cycles de décision. Deux recrutements commerciaux ont renforcé l'équipe en février.",
          ),
        ),
        h(2, "Résultats clés"),
        table(
          "header-accent",
          ["Indicateur", "T1 2025", "T1 2026", "Évolution"],
          [
            ["Chiffre d'affaires", "1,27 M€", "1,42 M€", "+12 %"],
            ["Nouveaux clients", "38", "47", "+24 %"],
            ["Taux de rétention", "87 %", "91 %", "+4 pts"],
            ["Marge opérationnelle", "18 %", "18 %", "stable"],
          ],
          ["left", "right", "right", "right"],
          [260, 120, 120, 120],
        ),
        h(2, "Analyse"),
        h(3, "Ventes"),
        p(
          text(
            "Les ventes récurrentes représentent désormais 63 % du chiffre d'affaires. Le panier moyen augmente de 7 % grâce à la nouvelle offre premium.",
          ),
        ),
        h(3, "Opérations"),
        p(
          text(
            "Le délai moyen de livraison passe de 9 à 11 jours en raison de tensions sur l'approvisionnement. Un second fournisseur est en cours de qualification.",
          ),
        ),
        h(2, "Recommandations"),
        ol(
          "Qualifier un second fournisseur d'ici fin mai pour sécuriser les délais.",
          "Étendre l'offre premium aux deux régions restantes au deuxième trimestre.",
          "Lancer un programme de fidélisation ciblant les clients de plus de deux ans.",
        ),
        h(2, "Conclusion"),
        p(
          text(
            "Les résultats du trimestre sont solides. Le maintien de cette trajectoire dépend de la fiabilité logistique, priorité du T2.",
          ),
        ),
      ),
    }),
  },
  {
    id: "facture",
    category: "Finance",
    label: "Facture",
    description: "Facture avec tableau de lignes et total.",
    page: {
      footer: "Atelier Lumière SAS · SIREN 912 345 678 · TVA FR12 912345678 · IBAN FR76 3000 1007 9412 3456 7890 185",
    },
    build: () => ({
      title: "Facture n° 2026-042",
      doc: doc(
        layout("minimal", [
          [
            [
              p(text("Atelier Lumière", { b: true, size: 24, color: BLUE })),
              p(muted("12 rue des Tanneurs, 69002 Lyon", 13)),
              p(muted("contact@atelier-lumiere.fr · 04 78 00 00 00", 13)),
            ],
            [
              pa("right", text("FACTURE", { b: true, size: 26, spacing: "0.08em" })),
              pa("right", b("N° 2026-042")),
              pa("right", muted("Émise le 20 mars 2026", 13)),
            ],
          ],
        ]),
        rule(),
        layout("minimal", [
          [
            [
              p(text("FACTURÉ À", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Maison Verdier SARL")),
              p(text("48 avenue de la République")),
              p(text("75011 Paris")),
            ],
            [
              p(text("DÉTAILS", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Échéance : "), text("19 avril 2026")),
              p(b("Référence : "), text("Refonte du site vitrine")),
              p(b("Règlement : "), text("virement bancaire")),
            ],
          ],
        ]),
        gap(),
        table(
          "header-accent",
          ["Désignation", "Qté", "P.U. HT", "Total HT"],
          [
            ["Conception graphique — maquettes desktop et mobile", "1", "3 200,00 €", "3 200,00 €"],
            ["Intégration et développement (journées)", "6", "650,00 €", "3 900,00 €"],
            ["Rédaction et optimisation SEO des pages", "1", "900,00 €", "900,00 €"],
            ["Mise en ligne et formation", "1", "400,00 €", "400,00 €"],
            [
              [p()],
              [p()],
              [pa("right", text("Total HT", { b: true }))],
              [pa("right", text("8 400,00 €", { b: true }))],
            ],
          ],
          ["left", "right", "right", "right"],
          [300, 50, 140, 140],
        ),
        pa("right", muted("TVA 20 % : 1 680,00 €")),
        pa(
          "right",
          text("Total TTC : ", { size: 18, color: SLATE }),
          text("10 080,00 €", { b: true, size: 22, color: BLUE }),
        ),
        gap(),
        pa("left", b("Conditions de règlement")),
        p(
          text(
            "Paiement à 30 jours. Pénalité de retard : trois fois le taux d'intérêt légal ; indemnité forfaitaire de recouvrement de 40 €. Aucun escompte pour paiement anticipé.",
            { size: 14, color: SLATE },
          ),
        ),
      ),
    }),
  },
  {
    id: "courrier",
    category: "Courrier",
    label: "Courrier",
    description: "Lettre administrative formelle.",
    page: { margins: { top: 25, right: 25, bottom: 25, left: 25 } },
    build: () => ({
      title: "Courrier",
      doc: doc(
        p(b("Élodie Fabre")),
        p(text("14 rue Victor Hugo")),
        p(text("33000 Bordeaux")),
        p(muted("elodie.fabre@exemple.fr · 06 12 34 56 78", 13)),
        gap(),
        pa("right", b("Mairie de Bordeaux")),
        pa("right", text("Service Urbanisme")),
        pa("right", text("Place Pey-Berland")),
        pa("right", text("33045 Bordeaux Cedex")),
        gap(),
        pa("right", text("Bordeaux, le 12 mars 2026", { i: true, color: SLATE })),
        gap(),
        p(
          b("Objet : "),
          text("demande de rendez-vous concernant mon dossier de permis de construire n° PC 033 063 26 00142"),
        ),
        p(text("Lettre recommandée avec accusé de réception", { i: true, size: 14, color: MUTED })),
        gap(),
        p(text("Madame, Monsieur,")),
        pa(
          "justify",
          text(
            "Par la présente, je me permets de solliciter un rendez-vous afin d'examiner l'avancement de mon dossier de permis de construire, déposé le 20 janvier 2026 et pour lequel je n'ai reçu à ce jour aucune notification d'instruction.",
          ),
        ),
        pa(
          "justify",
          text(
            "Je souhaiterais en particulier connaître les éventuelles pièces complémentaires à fournir, ainsi que le délai prévisible de réponse. Je reste disponible les mardis et jeudis après-midi.",
          ),
        ),
        pa(
          "justify",
          text(
            "Dans l'attente de votre retour, je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
          ),
        ),
        gap(),
        pa("right", b("Élodie Fabre")),
        gap(),
        p(muted("P. J. : copie du récépissé de dépôt du dossier.", 13)),
      ),
    }),
  },
  {
    id: "fiche",
    category: "Professionnel",
    label: "Fiche technique",
    description: "Caractéristiques d'un produit ou service.",
    page: { header: "Fiche technique — Enceinte Nova 2", showPageNumbers: true },
    build: () => ({
      title: "Fiche technique — Enceinte Nova 2",
      doc: doc(
        kicker("Fiche produit · Réf. NOV-2-BLK"),
        h(1, "Enceinte Bluetooth Nova 2"),
        lead("Son 360°, 24 heures d'autonomie, résistante à l'eau."),
        rule(),
        h(2, "Description"),
        p(
          text(
            "La Nova 2 associe un rendu sonore généreux à un format compact. Son double haut-parleur passif délivre des basses profondes, tandis que son boîtier en aluminium recyclé résiste aux projections d'eau et à la poussière (IP67).",
          ),
        ),
        h(2, "Caractéristiques techniques"),
        table(
          "banded-rows",
          ["Caractéristique", "Valeur"],
          [
            ["Puissance", "2 × 20 W RMS"],
            ["Connectivité", "Bluetooth 5.3, USB-C, entrée jack 3,5 mm"],
            ["Autonomie", "24 heures à volume moyen"],
            ["Temps de charge", "3 heures (charge rapide : 15 min = 4 h)"],
            ["Dimensions", "190 × 78 × 78 mm"],
            ["Poids", "720 g"],
            ["Indice de protection", "IP67"],
          ],
        ),
        h(2, "Points forts"),
        ul(
          [b("Autonomie record : "), text("24 heures sur une seule charge.")],
          [b("Robuste : "), text("étanche, anti-poussière, résiste aux chutes d'un mètre.")],
          [b("Éco-conçue : "), text("aluminium recyclé à 90 %, emballage sans plastique.")],
        ),
        h(2, "Contenu de la boîte"),
        p(text("Enceinte Nova 2 · câble USB-C · dragonne · guide de démarrage rapide. Garantie 2 ans.")),
      ),
    }),
  },
  {
    id: "cv",
    label: "CV",
    description: "Curriculum vitae : profil, expérience, formation, compétences.",
    category: "Professionnel",
    page: { margins: { top: 15, right: 18, bottom: 15, left: 18 } },
    build: () => ({
      title: "CV — Julien Moreau",
      doc: doc(
        h(1, "Julien Moreau", { size: 38 }),
        p(text("Chef de projet digital", { size: 20, b: true, color: BLUE })),
        p(muted("Lille · 06 12 34 56 78 · julien.moreau@exemple.fr · linkedin.com/in/julienmoreau", 14)),
        rule(),
        h(2, "Profil", { color: BLUE, caps: true, size: 15, spacing: "0.1em" }),
        p(
          text(
            "Chef de projet digital avec huit ans d'expérience dans la conduite de refontes web et de produits mobiles. À l'aise entre équipes techniques et métiers, je livre dans les délais, avec un souci constant de la qualité et de l'usage.",
          ),
        ),
        h(2, "Expérience professionnelle", { color: BLUE, caps: true, size: 15, spacing: "0.1em" }),
        layout(
          "minimal",
          [
            [
              [p(muted("2021 – aujourd'hui", 14))],
              [
                p(b("Chef de projet digital — Groupe Altéa, Lille")),
                ul(
                  "Pilotage de la refonte du site e-commerce : +28 % de conversion en un an.",
                  "Encadrement d'une équipe de 7 personnes (design, développement, QA).",
                  "Mise en place d'une méthode agile ayant réduit les délais de livraison de 30 %.",
                ),
              ],
            ],
            [
              [p(muted("2018 – 2021", 14))],
              [
                p(b("Chargé de projet web — Agence Pixel, Paris")),
                ul(
                  "Gestion de 15 projets clients simultanés, budget moyen 60 k€.",
                  "Rédaction des cahiers des charges et recette fonctionnelle.",
                ),
              ],
            ],
          ],
          undefined,
          [130, 510],
        ),
        h(2, "Formation", { color: BLUE, caps: true, size: 15, spacing: "0.1em" }),
        layout(
          "minimal",
          [
            [[p(muted("2018", 14))], [p(b("Master Management de projets numériques"), text(" — Université de Lille"))]],
            [[p(muted("2016", 14))], [p(b("Licence Information-Communication"), text(" — Université de Lille"))]],
          ],
          undefined,
          [130, 510],
        ),
        h(2, "Compétences", { color: BLUE, caps: true, size: 15, spacing: "0.1em" }),
        layout("minimal", [
          [
            [p(b("Gestion de projet")), p(text("Scrum, Kanban, Jira, roadmaps"))],
            [p(b("Outils")), p(text("Figma, Notion, Google Analytics, SQL"))],
            [p(b("Langues")), p(text("Français (natif), anglais (courant), espagnol (notions)"))],
          ],
        ]),
      ),
    }),
  },
  {
    id: "lettre-motivation",
    label: "Lettre de motivation",
    description: "Lettre de candidature avec coordonnées et formule de politesse.",
    category: "Courrier",
    page: { margins: { top: 25, right: 25, bottom: 25, left: 25 } },
    build: () => ({
      title: "Lettre de motivation",
      doc: doc(
        p(text("Julien Moreau", { b: true, size: 20, color: BLUE })),
        p(text("28 rue Nationale, 59000 Lille")),
        p(muted("06 12 34 56 78 · julien.moreau@exemple.fr", 13)),
        gap(),
        pa("right", b("Groupe Horizon")),
        pa("right", text("À l'attention de Madame Sandrine Petit")),
        pa("right", text("Direction des ressources humaines")),
        pa("right", text("5 boulevard Haussmann, 75009 Paris")),
        gap(),
        pa("right", text("Lille, le 9 mars 2026", { i: true, color: SLATE })),
        gap(),
        p(b("Objet : candidature au poste de chef de projet digital (réf. RH-2026-31)")),
        gap(),
        p(text("Madame,")),
        pa(
          "justify",
          text(
            "Votre annonce pour le poste de chef de projet digital a immédiatement retenu mon attention : elle associe pilotage de projets transverses et exigence sur l'expérience utilisateur, deux domaines qui m'animent depuis huit ans.",
          ),
        ),
        pa(
          "justify",
          text(
            "Chez Altéa, j'ai conduit la refonte du site e-commerce du groupe, menée avec une équipe de sept personnes : la conversion a progressé de 28 % en un an et les délais de livraison ont diminué de 30 % grâce à une organisation agile que j'ai mise en place. Cette expérience m'a appris à fédérer des profils variés autour d'objectifs mesurables.",
          ),
        ),
        pa(
          "justify",
          text(
            "Rejoindre le Groupe Horizon, c'est pour moi l'occasion de contribuer à une transformation digitale d'envergure, dans une entreprise dont j'apprécie l'engagement en faveur de l'innovation responsable.",
          ),
        ),
        pa(
          "justify",
          text(
            "Je serais ravi de vous rencontrer pour échanger sur ma candidature et vous présenter plus en détail mon parcours.",
          ),
        ),
        pa(
          "justify",
          text(
            "Dans l'attente de votre réponse, je vous prie d'agréer, Madame, l'expression de mes salutations distinguées.",
          ),
        ),
        gap(),
        pa("right", b("Julien Moreau")),
      ),
    }),
  },
  {
    id: "compte-rendu",
    label: "Compte rendu de réunion",
    description: "Participants, ordre du jour, décisions et actions à suivre.",
    category: "Réunion",
    page: { header: "Compte rendu de réunion", showPageNumbers: true },
    build: () => ({
      title: "Compte rendu de réunion",
      doc: doc(
        kicker("Réunion de projet"),
        h(1, "Point d'avancement — Refonte du site"),
        layout("minimal", [
          [
            [
              p(text("DATE", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(text("Jeudi 12 mars 2026, 10 h – 11 h 15")),
            ],
            [
              p(text("LIEU", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(text("Salle Pasteur / visioconférence")),
            ],
            [p(text("RÉDACTEUR", { b: true, size: 12, color: BLUE, spacing: "0.1em" })), p(text("Inès Bouchard"))],
          ],
        ]),
        rule(),
        h(2, "Participants"),
        ul(
          [b("Inès Bouchard"), text(" — cheffe de projet")],
          [b("Thomas Garnier"), text(" — développeur principal")],
          [b("Léa Dupuis"), text(" — designer UX")],
          [b("Marc Lefèvre"), text(" — direction marketing (excusé en fin de séance)")],
        ),
        h(2, "Ordre du jour"),
        ol("Bilan des maquettes validées", "Planning de développement", "Budget et points de vigilance"),
        h(2, "Points abordés et décisions"),
        h(3, "1. Maquettes"),
        p(
          text(
            "Les maquettes desktop sont validées. Les écrans mobiles nécessitent une dernière passe sur la navigation. ",
          ),
          b("Décision : "),
          text("le menu est simplifié à cinq entrées."),
        ),
        h(3, "2. Planning"),
        p(
          text(
            "Le développement démarre le 23 mars. La mise en ligne est confirmée pour le 30 avril, sous réserve de la livraison des contenus avant le 3 avril.",
          ),
        ),
        h(3, "3. Budget"),
        p(text("Le budget est tenu à ce stade (consommé : 58 %). Aucun dépassement n'est anticipé.")),
        h(2, "Actions à suivre"),
        table(
          "header-accent",
          ["Action", "Responsable", "Échéance"],
          [
            ["Finaliser la navigation mobile", "Léa Dupuis", "17 mars"],
            ["Livrer les contenus rédactionnels", "Marc Lefèvre", "3 avril"],
            ["Mettre en place l'environnement de recette", "Thomas Garnier", "20 mars"],
          ],
        ),
        gap(),
        p(b("Prochaine réunion : "), text("jeudi 26 mars 2026, 10 h, salle Pasteur.")),
      ),
    }),
  },
  {
    id: "memo",
    label: "Mémo",
    description: "Note interne courte : destinataires, objet, message.",
    category: "Professionnel",
    build: () => ({
      title: "Mémo",
      doc: doc(
        kicker("Note interne"),
        h(1, "Mémo"),
        layout(
          "minimal",
          [
            [[p(text("À", { b: true, color: SLATE }))], [p(text("Équipe commerciale"))]],
            [[p(text("De", { b: true, color: SLATE }))], [p(text("Sophie Lambert, direction commerciale"))]],
            [[p(text("Date", { b: true, color: SLATE }))], [p(text("16 mars 2026"))]],
            [[p(text("Objet", { b: true, color: SLATE }))], [p(b("Nouvelle procédure de validation des remises"))]],
          ],
          undefined,
          [90, 550],
        ),
        rule(),
        p(
          text(
            "À compter du 1er avril, toute remise supérieure à 10 % devra être validée par la direction commerciale avant l'envoi du devis au client.",
          ),
        ),
        p(text("Cette mesure vise à protéger nos marges tout en gardant des délais de réponse courts :")),
        ul(
          "Remise jusqu'à 10 % : accord du commercial seul.",
          "Remise de 10 à 20 % : validation sous 24 h ouvrées via le formulaire dédié.",
          "Remise au-delà de 20 % : étude au cas par cas en comité hebdomadaire.",
        ),
        p(
          b("Action attendue : "),
          text("prenez connaissance du nouveau formulaire sur l'intranet et appliquez la procédure dès le 1er avril."),
        ),
        p(muted("Pour toute question, contactez Sophie Lambert (poste 4 21).", 14)),
      ),
    }),
  },
  {
    id: "proces-verbal",
    label: "Procès-verbal",
    description: "Procès-verbal d'assemblée ou de réunion formelle, avec résolutions.",
    category: "Réunion",
    page: { footer: "Procès-verbal — document confidentiel", showPageNumbers: true },
    build: () => ({
      title: "Procès-verbal d'assemblée générale",
      doc: doc(
        kicker("Association Les Jardins Partagés", "center"),
        h(1, "Procès-verbal de l'assemblée générale ordinaire", {}, "center"),
        pa("center", muted("Séance du samedi 14 mars 2026")),
        rule(),
        pa(
          "justify",
          text(
            "L'an deux mille vingt-six, le 14 mars à 14 h 30, les membres de l'association Les Jardins Partagés se sont réunis en assemblée générale ordinaire à la salle des fêtes de Villeurbanne, sur convocation du bureau en date du 20 février 2026.",
          ),
        ),
        layout(
          "grid",
          [
            [[p(b("Présents"))], [p(text("31 membres, dont 4 représentés par pouvoir"))]],
            [[p(b("Absents excusés"))], [p(text("6 membres"))]],
            [[p(b("Présidence"))], [p(text("Nadia Benali, présidente"))]],
            [[p(b("Secrétaire de séance"))], [p(text("Pierre Colin, secrétaire"))]],
          ],
          undefined,
          [200, 440],
        ),
        gap(),
        pa(
          "justify",
          text(
            "La présidente constate que le quorum (un quart des membres, soit 12 personnes) est atteint et déclare la séance ouverte.",
          ),
        ),
        h(2, "Première résolution — Rapport moral et d'activité"),
        pa(
          "justify",
          text(
            "L'assemblée entend le rapport d'activité 2025 présenté par la présidente. Mise aux voix, cette résolution est adoptée à ",
          ),
          b("l'unanimité"),
          text("."),
        ),
        h(2, "Deuxième résolution — Approbation des comptes"),
        pa(
          "justify",
          text(
            "Le trésorier présente les comptes de l'exercice clos au 31 décembre 2025, qui font apparaître un excédent de 2 340 €. Mise aux voix, cette résolution est adoptée à la majorité de ",
          ),
          b("33 voix pour, 1 contre, 1 abstention"),
          text("."),
        ),
        h(2, "Troisième résolution — Renouvellement du bureau"),
        pa(
          "justify",
          text(
            "Nadia Benali, Pierre Colin et Anne Girard sont réélus pour un mandat de deux ans, à l'unanimité des suffrages exprimés.",
          ),
        ),
        pa(
          "justify",
          text(
            "L'ordre du jour étant épuisé, la séance est levée à 16 h 45. Le présent procès-verbal est établi pour servir et valoir ce que de droit.",
          ),
        ),
        gap(),
        layout("minimal", [
          [
            [p(b("La présidente")), p(muted("Nadia Benali", 13)), p(), p()],
            [p(b("Le secrétaire")), p(muted("Pierre Colin", 13)), p(), p()],
          ],
        ]),
      ),
    }),
  },
  {
    id: "devis",
    label: "Devis",
    description: "Proposition chiffrée avec validité et conditions.",
    category: "Finance",
    page: { footer: "Atelier Lumière SAS · SIREN 912 345 678 · Devis valable 30 jours" },
    build: () => ({
      title: "Devis n° D-2026-017",
      doc: doc(
        layout("minimal", [
          [
            [
              p(text("Atelier Lumière", { b: true, size: 24, color: BLUE })),
              p(muted("12 rue des Tanneurs, 69002 Lyon", 13)),
              p(muted("contact@atelier-lumiere.fr · 04 78 00 00 00", 13)),
            ],
            [
              pa("right", text("DEVIS", { b: true, size: 26, spacing: "0.08em" })),
              pa("right", b("N° D-2026-017")),
              pa("right", muted("Émis le 2 mars 2026 · valable jusqu'au 1er avril 2026", 13)),
            ],
          ],
        ]),
        rule(),
        layout("minimal", [
          [
            [
              p(text("PROPOSÉ À", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Boulangerie Dupont")),
              p(text("8 place du Marché")),
              p(text("69003 Lyon")),
            ],
            [
              p(text("PROJET", { b: true, size: 12, color: BLUE, spacing: "0.1em" })),
              p(b("Identité visuelle et site vitrine")),
              p(text("Délai de réalisation : 6 semaines")),
            ],
          ],
        ]),
        gap(),
        table(
          "header-accent",
          ["Désignation", "Qté", "P.U. HT", "Total HT"],
          [
            ["Atelier de cadrage et moodboard", "1", "450,00 €", "450,00 €"],
            ["Création du logo et de la charte graphique", "1", "1 200,00 €", "1 200,00 €"],
            ["Site vitrine 5 pages, responsive", "1", "2 400,00 €", "2 400,00 €"],
            ["Shooting photo produits (demi-journée)", "1", "550,00 €", "550,00 €"],
            [
              [p()],
              [p()],
              [pa("right", text("Total HT", { b: true }))],
              [pa("right", text("4 600,00 €", { b: true }))],
            ],
          ],
          ["left", "right", "right", "right"],
          [300, 50, 140, 140],
        ),
        pa("right", muted("TVA 20 % : 920,00 €")),
        pa(
          "right",
          text("Total TTC : ", { size: 18, color: SLATE }),
          text("5 520,00 €", { b: true, size: 22, color: BLUE }),
        ),
        gap(),
        h(2, "Conditions"),
        ul(
          "Acompte de 30 % à la commande, solde à la livraison.",
          "Deux allers-retours de corrections inclus par livrable.",
          "Les droits d'utilisation sont cédés au paiement intégral.",
        ),
        gap(),
        layout("grid", [
          [
            [p(b("Bon pour accord")), p(muted("Date, signature et mention « Bon pour accord »", 12)), p(), p(), p()],
            [p(b("Atelier Lumière")), p(muted("Camille Roux, présidente", 13)), p(), p(), p()],
          ],
        ]),
      ),
    }),
  },
];
