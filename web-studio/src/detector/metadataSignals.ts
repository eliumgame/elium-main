/**
 * Signaux "métadonnées" — l'historique d'édition d'un fichier (nombre de
 * révisions, temps d'édition cumulé, dates de création/modification) trahit
 * souvent un texte généré puis collé en une fois plutôt que rédigé au fil de
 * l'eau. Les champs purement descriptifs (auteur, application) sont
 * remontés à titre informatif uniquement — l'application qui a produit le
 * fichier n'est jamais, à elle seule, une preuve d'IA.
 */
import type { DocumentMetadata, Finding, ParagraphModel } from "./types";

const LARGE_DOC_MIN_PARAGRAPHS = 40;
const LARGE_DOC_MIN_WORDS = 4000;
const LOW_REVISION_COUNT = 2;
const MIN_MINUTES_PER_500_WORDS = 1;
const UNCHANGED_WINDOW_MINUTES = 2;

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

function totalWords(paragraphs: ParagraphModel[]): number {
  return paragraphs.reduce((sum, p) => sum + wordCount(p.text), 0);
}

export function analyzeMetadataSignals(metadata: DocumentMetadata, paragraphs: ParagraphModel[]): Finding[] {
  const findings: Finding[] = [];
  const words = totalWords(paragraphs);
  const isLargeDoc = paragraphs.length >= LARGE_DOC_MIN_PARAGRAPHS || words >= LARGE_DOC_MIN_WORDS;

  // ---- Nombre de révisions anormalement bas --------------------------------
  if (metadata.revisionCount !== undefined && metadata.revisionCount <= LOW_REVISION_COUNT && isLargeDoc) {
    findings.push({
      id: "meta-revisions",
      category: "metadonnees",
      signal: "revisions_basses",
      label: "Nombre de révisions anormalement bas",
      explanation:
        `Le document ne compte que ${metadata.revisionCount} révision${metadata.revisionCount > 1 ? "s" : ""} ` +
        `pour ${paragraphs.length} paragraphes et environ ${words} mots, ` +
        "ce qui est peu pour un document de cette taille rédigé par étapes successives.",
      severity: "moyen",
      weight: 0.5,
      location: { label: "Métadonnées du document" },
      evidence: `revisionCount = ${metadata.revisionCount}`,
    });
  }

  // ---- Temps d'édition anormalement bas -------------------------------------
  if (metadata.editingMinutes !== undefined && words > 0) {
    const expectedMinimum = (words / 500) * MIN_MINUTES_PER_500_WORDS;
    if (metadata.editingMinutes < expectedMinimum) {
      findings.push({
        id: "meta-editing-minutes",
        category: "metadonnees",
        signal: "temps_edition_bas",
        label: "Temps d'édition anormalement bas",
        explanation:
          `Le fichier indique seulement ${metadata.editingMinutes} minute${metadata.editingMinutes > 1 ? "s" : ""} ` +
          `de temps d'édition cumulé pour environ ${words} mots, ` +
          "soit bien moins que le temps qu'une rédaction ou une relecture humaine demanderait normalement.",
        severity: "moyen",
        weight: 0.45,
        location: { label: "Métadonnées du document" },
        evidence: `editingMinutes = ${metadata.editingMinutes}`,
      });
    }
  }

  // ---- Jamais modifié après création, sur un document long -------------------
  if (metadata.createdAt && metadata.modifiedAt && isLargeDoc) {
    const created = Date.parse(metadata.createdAt);
    const modified = Date.parse(metadata.modifiedAt);
    if (!Number.isNaN(created) && !Number.isNaN(modified)) {
      const diffMinutes = Math.abs(modified - created) / 60000;
      if (diffMinutes <= UNCHANGED_WINDOW_MINUTES) {
        findings.push({
          id: "meta-unchanged",
          category: "metadonnees",
          signal: "jamais_modifie",
          label: "Jamais modifié après sa création",
          explanation:
            `Les dates de création (${metadata.createdAt}) et de dernière modification (${metadata.modifiedAt}) ` +
            `sont quasi identiques (écart de ${diffMinutes.toFixed(1)} minute${diffMinutes >= 2 ? "s" : ""}) ` +
            `alors que le document compte ${paragraphs.length} paragraphes, ` +
            "ce qui suggère un texte produit d'un seul bloc plutôt qu'écrit puis retravaillé.",
          severity: "info",
          weight: 0.15,
          location: { label: "Métadonnées du document" },
        });
      }
    }
  }

  // ---- Champs informatifs uniquement (aucun poids) --------------------------
  if (metadata.creator) {
    findings.push(informationalField("meta-creator", "creator_info", "Application créatrice", metadata.creator));
  }
  if (metadata.producer) {
    findings.push(
      informationalField("meta-producer", "producer_info", "Application productrice (PDF)", metadata.producer),
    );
  }
  if (metadata.title) {
    findings.push(informationalField("meta-title", "title_info", "Titre du document", metadata.title));
  }
  if (metadata.author) {
    findings.push(informationalField("meta-author", "author_info", "Auteur déclaré", metadata.author));
  }

  return findings;
}

function informationalField(id: string, signal: string, label: string, value: string): Finding {
  return {
    id,
    category: "metadonnees",
    signal,
    label,
    explanation:
      `${label} : « ${value} ». Information affichée à titre indicatif uniquement — ` +
      "l'application ou l'auteur déclaré dans les métadonnées n'est pas en soi une preuve de contenu généré par IA.",
    severity: "info",
    weight: 0,
    location: { label: "Métadonnées du document" },
    evidence: value,
  };
}
