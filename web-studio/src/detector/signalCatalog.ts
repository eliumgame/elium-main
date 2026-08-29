/**
 * Registre humain de tous les `Finding.signal` que les moteurs d'analyse
 * peuvent produire — sert au réglage de sensibilité (activer/désactiver un
 * signal précis pour réduire les faux positifs) et à l'affichage des libellés
 * dans l'UI. `tests/detector-signal-catalog.test.ts` vérifie que ce registre
 * reste synchronisé avec les `signal:` réellement émis par les 4 moteurs —
 * mettre à jour ce fichier si un moteur gagne/perd un signal.
 *
 * `appliesTo` reflète une IMPOSSIBILITÉ STRUCTURELLE (pas juste "n'a rien
 * trouvé cette fois") — ex. un signal texte ne peut structurellement pas se
 * déclencher sur un fichier image seul (0 paragraphe), un signal de révisions
 * .docx ne peut pas se déclencher sur un PDF (le champ n'existe pas dans ses
 * métadonnées), un signal PNG ne peut pas se déclencher sur un JPEG. Sert
 * UNIQUEMENT à préconfigurer l'affichage du panneau de sensibilité selon le
 * fichier chargé — les moteurs eux-mêmes se gardent déjà correctement (ils
 * renvoient simplement 0 finding), donc ceci n'a aucun effet sur le score ou
 * l'analyse : c'est un confort de présentation, pas un filtre fonctionnel.
 */
import type { DocumentModel, SignalCategory } from "./types";

export interface SignalCatalogEntry {
  id: string;
  category: SignalCategory;
  label: string;
  description: string;
  /** false pour les champs purement informatifs (poids toujours 0, ex. auteur/titre déclarés). */
  affectsScore: boolean;
  /** Ce signal peut-il structurellement se déclencher pour ce document ? Par
   *  défaut (absent) toujours applicable. */
  appliesTo?: (model: Pick<DocumentModel, "paragraphs" | "images" | "metadata">) => boolean;
}

type ModelSlice = Pick<DocumentModel, "paragraphs" | "images" | "metadata">;

const hasText = (m: ModelSlice) => m.paragraphs.length > 0;
const hasImageOfType = (mime: string) => (m: ModelSlice) => m.images.some((i) => i.mime === mime);
const hasAnyRecognizedImage = (m: ModelSlice) =>
  m.images.some((i) => i.mime === "image/jpeg" || i.mime === "image/png");
const hasImages = (m: ModelSlice) => m.images.length > 0;
const hasMetadataField =
  (field: keyof DocumentModel["metadata"]) =>
  (m: ModelSlice) =>
    m.metadata[field] != null;

export const SIGNAL_CATALOG: SignalCatalogEntry[] = [
  {
    id: "burstiness_faible",
    category: "texte",
    label: "Régularité de la longueur des phrases",
    description: "Les phrases du document ont une longueur anormalement régulière d'une phrase à l'autre.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "paragraphes_uniformes",
    category: "texte",
    label: "Régularité de la longueur des paragraphes",
    description: "Les paragraphes ont un nombre de mots anormalement régulier d'un paragraphe à l'autre.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "cliches_ia",
    category: "texte",
    label: "Tournures clichées typiques de l'IA",
    description: "Emploi fréquent de tournures/transitions sur-représentées dans les textes générés par IA (FR/EN).",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "amorces_repetees",
    category: "texte",
    label: "Amorces de phrase répétées",
    description: "Une même amorce de phrase (2-3 premiers mots) revient de façon anormalement dominante.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "tirets_cadratins_frequents",
    category: "texte",
    label: "Usage fréquent du tiret cadratin (—)",
    description: "Fréquence de tirets cadratins « — » supérieure à ce qu'on observe dans un texte rédigé à la main.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "densite_listes_elevee",
    category: "texte",
    label: "Densité de listes à puces élevée",
    description:
      "Proportion de paragraphes en liste à puces anormalement élevée pour un texte suivi — utile de désactiver pour un document technique qui utilise légitimement beaucoup de listes.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "police_incoherente",
    category: "mise_en_forme",
    label: "Police/taille incohérente entre paragraphes",
    description: "Un paragraphe utilise une police ou une taille différente du reste du document (bloc collé ?).",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "guillemets_incoherents",
    category: "mise_en_forme",
    label: "Style de guillemets incohérent",
    description: "Un paragraphe mélange guillemets droits et courbes par rapport au reste du document.",
    affectsScore: true,
    appliesTo: hasText,
  },
  {
    id: "niveau_titre_irregulier",
    category: "mise_en_forme",
    label: "Saut de niveau de titre",
    description: "Un titre saute plus d'un niveau par rapport au titre précédent (ex. H1 direct à H4).",
    affectsScore: false,
    appliesTo: hasText,
  },
  {
    id: "revisions_basses",
    category: "metadonnees",
    label: "Nombre de révisions anormalement bas",
    description: "Très peu de révisions enregistrées pour la taille du document (.docx uniquement).",
    affectsScore: true,
    appliesTo: hasMetadataField("revisionCount"),
  },
  {
    id: "temps_edition_bas",
    category: "metadonnees",
    label: "Temps d'édition anormalement bas",
    description: "Temps d'édition cumulé très court rapporté à la longueur du document (.docx uniquement).",
    affectsScore: true,
    appliesTo: hasMetadataField("editingMinutes"),
  },
  {
    id: "jamais_modifie",
    category: "metadonnees",
    label: "Jamais modifié après création",
    description: "Date de création et de dernière modification quasi identiques sur un document volumineux.",
    affectsScore: true,
    appliesTo: (m) => m.metadata.createdAt != null && m.metadata.modifiedAt != null,
  },
  {
    id: "creator_info",
    category: "metadonnees",
    label: "Application créatrice (informatif)",
    description: "Nom de l'application ayant produit le fichier — affiché à titre indicatif, jamais un indice à charge.",
    affectsScore: false,
    appliesTo: hasMetadataField("creator"),
  },
  {
    id: "producer_info",
    category: "metadonnees",
    label: "Application productrice PDF (informatif)",
    description: "Producteur PDF déclaré — affiché à titre indicatif, jamais un indice à charge.",
    affectsScore: false,
    appliesTo: hasMetadataField("producer"),
  },
  {
    id: "title_info",
    category: "metadonnees",
    label: "Titre déclaré (informatif)",
    description: "Titre du document tel que déclaré dans ses métadonnées.",
    affectsScore: false,
    appliesTo: hasMetadataField("title"),
  },
  {
    id: "author_info",
    category: "metadonnees",
    label: "Auteur déclaré (informatif)",
    description: "Auteur du document tel que déclaré dans ses métadonnées.",
    affectsScore: false,
    appliesTo: hasMetadataField("author"),
  },
  {
    id: "image_c2pa_ai_source",
    category: "image",
    label: "Provenance C2PA/IPTC déclarée IA",
    description:
      "Métadonnées C2PA/IPTC « digitalSourceType » déclarant explicitement un contenu généré/composé par IA — le signal le plus fiable disponible. Pris en charge pour JPEG (XMP/JUMBF) et PNG (chunk caBX).",
    affectsScore: true,
    appliesTo: hasAnyRecognizedImage,
  },
  {
    id: "image_exif_generator_tag",
    category: "image",
    label: "Balise EXIF d'un générateur IA connu",
    description:
      "Balise EXIF Make/Model/Software correspondant au nom d'un outil de génération d'image par IA connu. EXIF n'est lu que sur les images JPEG.",
    affectsScore: true,
    appliesTo: hasImageOfType("image/jpeg"),
  },
  {
    id: "image_png_generation_parameters",
    category: "image",
    label: "Métadonnées PNG de génération (Stable Diffusion)",
    description: "Bloc de métadonnées « parameters » caractéristique de Stable Diffusion WebUI — PNG uniquement.",
    affectsScore: true,
    appliesTo: hasImageOfType("image/png"),
  },
  {
    id: "image_png_generation_software",
    category: "image",
    label: "Métadonnées PNG « Software » d'un générateur IA connu",
    description: "Champ PNG « Software » correspondant au nom d'un outil de génération d'image par IA connu — PNG uniquement.",
    affectsScore: true,
    appliesTo: hasImageOfType("image/png"),
  },
  {
    id: "image_no_exif_generator_resolution",
    category: "image",
    label: "Résolution typique d'un générateur, sans EXIF",
    description:
      "Résolution parmi celles produites par défaut par des générateurs d'image IA, sans aucune métadonnée EXIF d'appareil — signal faible, à désactiver si le document contient beaucoup d'images recadrées/exportées légitimement.",
    affectsScore: true,
    appliesTo: hasImages,
  },
];

export function signalsByCategory(): Record<SignalCategory | "plagiat", SignalCatalogEntry[]> {
  const grouped: Record<string, SignalCatalogEntry[]> = {};
  for (const entry of SIGNAL_CATALOG) {
    (grouped[entry.category] ??= []).push(entry);
  }
  return grouped as Record<SignalCategory | "plagiat", SignalCatalogEntry[]>;
}
