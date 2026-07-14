/** Starter templates (see Cahier des charges §6 — Modèles). */
import type { ProseMirrorNode } from "../format/types";

const text = (t: string, marks?: { type: string }[]): ProseMirrorNode =>
  ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const b = (t: string) => text(t, [{ type: "bold" }]);
const h = (level: number, t: string): ProseMirrorNode => ({ type: "heading", attrs: { level }, content: [text(t)] });
const p = (...c: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", ...(c.length ? { content: c } : {}) });
const li = (t: string): ProseMirrorNode => ({ type: "listItem", content: [p(text(t))] });
const ul = (...items: string[]): ProseMirrorNode => ({ type: "bulletList", content: items.map(li) });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

export interface Template {
  id: string;
  label: string;
  description: string;
  build(): { title: string; doc: ProseMirrorNode };
}

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Document vierge",
    description: "Page blanche pour démarrer librement.",
    build: () => ({ title: "Document sans titre", doc: doc(h(1, "Titre du document"), p(text("Commencez à rédiger…"))) }),
  },
  {
    id: "contrat",
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
            { type: "tableRow", content: ["Désignation", "Quantité", "P.U. HT", "Total HT"].map((t) => ({ type: "tableHeader", content: [p(text(t))] })) },
            { type: "tableRow", content: ["Prestation ……", "1", "0,00 €", "0,00 €"].map((t) => ({ type: "tableCell", content: [p(text(t))] })) },
          ],
        },
        p(b("Total TTC : 0,00 €")),
      ),
    }),
  },
  {
    id: "courrier",
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
];
