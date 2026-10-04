/** Starter templates (see Cahier des charges §6 — Modèles). */
import type { PageSettings, ProseMirrorNode } from "../format/types";

const text = (t: string, marks?: { type: string }[]): ProseMirrorNode => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const b = (t: string) => text(t, [{ type: "bold" }]);
const h = (level: number, t: string): ProseMirrorNode => ({ type: "heading", attrs: { level }, content: [text(t)] });
const p = (...c: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", ...(c.length ? { content: c } : {}) });
const li = (t: string): ProseMirrorNode => ({ type: "listItem", content: [p(text(t))] });
const ul = (...items: string[]): ProseMirrorNode => ({ type: "bulletList", content: items.map(li) });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

export type TemplateCategory = "Général" | "Courrier" | "Professionnel" | "Réunion" | "Finance";

export interface Template {
  id: string;
  label: string;
  description: string;
  category?: TemplateCategory;
  /** Mise en page propre au modèle (en-tête, pied de page, marges, numéros). */
  page?: Partial<PageSettings>;
  build(): { title: string; doc: ProseMirrorNode };
}

const cell = (t: string, header = false): ProseMirrorNode => ({
  type: header ? "tableHeader" : "tableCell",
  content: [p(text(t))],
});
const row = (cells: string[], header = false): ProseMirrorNode => ({
  type: "tableRow",
  content: cells.map((t) => cell(t, header)),
});
const table = (head: string[], ...rows: string[][]): ProseMirrorNode => ({
  type: "table",
  content: [row(head, true), ...rows.map((r) => row(r))],
});

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
    build: () => ({
      title: "Contrat",
      doc: doc(
        h(1, "Contrat de prestation"),
        p(b("Entre les soussignés :")),
        p(text("La société ……………, ci-après « le Prestataire »,")),
        p(text("et ……………, ci-après « le Client ».")),
        h(2, "Article 1 — Objet"),
        p(text("Le présent contrat a pour objet …")),
        h(2, "Article 2 — Durée"),
        p(text("Le contrat prend effet le …… pour une durée de ……")),
        h(2, "Article 3 — Conditions financières"),
        p(text("Le montant de la prestation s'élève à …… € HT.")),
        h(2, "Signatures"),
        p(text("Fait à ……………, le ……………, en deux exemplaires.")),
      ),
    }),
  },
  {
    id: "attestation",
    category: "Courrier",
    label: "Attestation",
    description: "Attestation officielle datée et signée.",
    build: () => ({
      title: "Attestation",
      doc: doc(
        h(1, "Attestation sur l'honneur"),
        p(text("Je soussigné(e) ……………, demeurant ……………,")),
        p(text("atteste sur l'honneur que ……………")),
        p(text("Cette attestation est délivrée pour servir et valoir ce que de droit.")),
        p(text("Fait à ……………, le ……………")),
      ),
    }),
  },
  {
    id: "rapport",
    category: "Professionnel",
    label: "Rapport",
    description: "Rapport structuré avec sections et synthèse.",
    build: () => ({
      title: "Rapport",
      doc: doc(
        h(1, "Rapport"),
        h(2, "Résumé"),
        p(text("Synthèse en quelques lignes …")),
        h(2, "Contexte"),
        p(text("…")),
        h(2, "Analyse"),
        ul("Point 1", "Point 2", "Point 3"),
        h(2, "Conclusion"),
        p(text("…")),
      ),
    }),
  },
  {
    id: "facture",
    category: "Finance",
    label: "Facture",
    description: "Facture avec tableau de lignes et total.",
    build: () => ({
      title: "Facture",
      doc: doc(
        h(1, "Facture n° 2026-001"),
        p(text("Date : ……  ·  Échéance : ……")),
        p(b("Émetteur : ……………"), text("    "), b("Client : ……………")),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: ["Désignation", "Quantité", "P.U. HT", "Total HT"].map((t) => ({
                type: "tableHeader",
                content: [p(text(t))],
              })),
            },
            {
              type: "tableRow",
              content: ["Prestation ……", "1", "0,00 €", "0,00 €"].map((t) => ({
                type: "tableCell",
                content: [p(text(t))],
              })),
            },
          ],
        },
        p(b("Total TTC : 0,00 €")),
      ),
    }),
  },
  {
    id: "courrier",
    category: "Courrier",
    label: "Courrier",
    description: "Lettre administrative formelle.",
    build: () => ({
      title: "Courrier",
      doc: doc(
        p(text("Nom Prénom")),
        p(text("Adresse")),
        p(text("")),
        p({ type: "text", text: "Objet : ……………", marks: [{ type: "bold" }] }),
        p(text("Madame, Monsieur,")),
        p(text("Par la présente, je me permets de …")),
        p(text("Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.")),
        p(text("Signature")),
      ),
    }),
  },
  {
    id: "fiche",
    category: "Professionnel",
    label: "Fiche technique",
    description: "Caractéristiques d'un produit ou service.",
    build: () => ({
      title: "Fiche technique",
      doc: doc(
        h(1, "Fiche technique — ……………"),
        h(2, "Caractéristiques"),
        ul("Référence : ……", "Dimensions : ……", "Matériaux : ……"),
        h(2, "Description"),
        p(text("…")),
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
      title: "CV",
      doc: doc(
        h(1, "Prénom NOM"),
        p(text("Intitulé du poste recherché · Ville · 06 00 00 00 00 · prenom.nom@exemple.fr")),
        h(2, "Profil"),
        p(text("Deux ou trois phrases présentant votre parcours et votre objectif.")),
        h(2, "Expérience professionnelle"),
        p(b("Poste — Entreprise"), text("   (2022 – aujourd'hui)")),
        ul("Mission ou réalisation chiffrée", "Mission ou réalisation chiffrée"),
        p(b("Poste — Entreprise"), text("   (2019 – 2022)")),
        ul("Mission ou réalisation chiffrée"),
        h(2, "Formation"),
        p(b("Diplôme — Établissement"), text("   (2019)")),
        h(2, "Compétences"),
        ul("Compétence 1", "Compétence 2", "Langues : français (natif), anglais (courant)"),
      ),
    }),
  },
  {
    id: "lettre-motivation",
    label: "Lettre de motivation",
    description: "Lettre de candidature avec coordonnées et formule de politesse.",
    category: "Courrier",
    build: () => ({
      title: "Lettre de motivation",
      doc: doc(
        p(b("Prénom NOM")),
        p(text("Adresse · Code postal Ville")),
        p(text("Téléphone · Courriel")),
        p(text("")),
        p(text("Entreprise destinataire — Service Recrutement")),
        p(text("Fait à ……………, le ……………")),
        p(b("Objet : candidature au poste de ……………")),
        p(text("Madame, Monsieur,")),
        p(text("Votre annonce a retenu toute mon attention car …")),
        p(text("Mon expérience de … m'a permis de …")),
        p(text("Je serais ravi(e) de vous rencontrer pour échanger sur ma candidature.")),
        p(
          text("Dans l'attente, je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées."),
        ),
        p(text("Prénom NOM")),
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
        h(1, "Compte rendu de réunion"),
        p(b("Date : "), text("……  "), b("Lieu : "), text("……  "), b("Rédacteur : "), text("……")),
        h(2, "Participants"),
        ul("Nom — fonction", "Nom — fonction"),
        h(2, "Ordre du jour"),
        ul("Point 1", "Point 2"),
        h(2, "Décisions"),
        p(text("…")),
        h(2, "Actions à suivre"),
        table(["Action", "Responsable", "Échéance"], ["……", "……", "……"]),
        p(text("Prochaine réunion : ……")),
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
        h(1, "MÉMO"),
        table(["", ""], ["À", "……"], ["De", "……"], ["Date", "……"], ["Objet", "……"]),
        p(text("")),
        p(text("Message : exposez l'essentiel dès la première phrase, puis détaillez si nécessaire.")),
        p(b("Action attendue : "), text("……")),
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
      title: "Procès-verbal",
      doc: doc(
        h(1, "Procès-verbal de l'assemblée du ……………"),
        p(text("L'an ……, le ……, à ……h……, les membres de ……………, se sont réunis à ……………")),
        p(b("Présents : "), text("……………")),
        p(b("Absents ou excusés : "), text("……………")),
        p(text("La séance est ouverte sous la présidence de ……………, qui constate que le quorum est atteint.")),
        h(2, "Première résolution"),
        p(text("…… Mise aux voix, cette résolution est adoptée à l'unanimité / à la majorité de …… voix.")),
        h(2, "Deuxième résolution"),
        p(text("……")),
        p(text("L'ordre du jour étant épuisé, la séance est levée à ……h……")),
        p(text("Le président de séance                                   Le secrétaire")),
      ),
    }),
  },
  {
    id: "devis",
    label: "Devis",
    description: "Proposition chiffrée avec validité et conditions.",
    category: "Finance",
    build: () => ({
      title: "Devis",
      doc: doc(
        h(1, "Devis n° D-2026-001"),
        p(text("Date : ……  ·  Valable jusqu'au : ……")),
        p(b("Prestataire : ……………"), text("    "), b("Client : ……………")),
        table(["Désignation", "Quantité", "P.U. HT", "Total HT"], ["Prestation ……", "1", "0,00 €", "0,00 €"]),
        p(b("Total HT : 0,00 €  ·  TVA 20 % : 0,00 €  ·  Total TTC : 0,00 €")),
        p(text("Bon pour accord — date et signature du client :")),
      ),
    }),
  },
];
