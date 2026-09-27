import {
  Accessibility,
  Archive,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Baseline,
  BookOpen,
  BoxSelect,
  CalendarDays,
  Check,
  Circle,
  ClipboardPaste,
  Cloud,
  Combine,
  Contrast,
  Copy,
  Crop,
  Dot,
  Download,
  Droplet,
  Eraser,
  FileCode,
  FileDown,
  FileImage,
  FileOutput,
  FilePlus2,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  FileText,
  FileType2,
  Focus,
  GitCompareArrows,
  Grid2x2,
  Grid3x3,
  Hand,
  Hash,
  Highlighter,
  Image as ImageIcon,
  Keyboard,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  Lock,
  Maximize2,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  Move,
  MoveHorizontal,
  PaintBucket,
  PanelTop,
  Paperclip,
  PencilLine,
  PenLine,
  PenSquare,
  PenTool,
  Pentagon,
  PieChart,
  Presentation,
  Printer,
  Redo2,
  RefreshCcw,
  Replace,
  RotateCcw,
  RotateCw,
  Ruler,
  Save,
  Scan,
  ScanText,
  Scissors,
  Shapes,
  Shield,
  ShieldCheck,
  Spline,
  Stamp,
  Strikethrough,
  Sun,
  Table,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  Unlock,
  UserRound,
  Volume2,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { Tool } from "../model/types";
import type { Permissions } from "../ops/security";
import type { RibbonTab } from "./state";

/**
 * The single list of what the PDF workspace can do: « Tous les outils », the
 * command palette, the context menus and the tool tips read it. Running an
 * entry goes through the workspace's own dispatch — `command(id)` for a
 * command or a toggle, `pickTool(tool)` for a tool — so a command behaves the
 * same wherever it is started from. Families and wording follow Acrobat's
 * « Tous les outils ».
 */

export type CommandKind = "tool" | "command" | "toggle";
export type CommandRight = keyof Permissions | "owner";

export type FamilyId =
  | "edit"
  | "export"
  | "create"
  | "combine"
  | "organise"
  | "comment"
  | "fillSign"
  | "protect"
  | "redact"
  | "prepareForm"
  | "ocr"
  | "compare"
  | "accessibility"
  | "standards"
  | "measure"
  | "print"
  | "file"
  | "view";

export interface CommandFamily {
  id: FamilyId;
  label: string;
  icon: LucideIcon;
  /** The ribbon tab showing this family's commands. */
  tab: RibbonTab;
  /** Listed by the palette only (file and view commands are not « outils » in Acrobat). */
  hidden?: boolean;
}

/** Acrobat's order. */
export const FAMILIES: CommandFamily[] = [
  { id: "edit", label: "Modifier le PDF", icon: TextCursorInput, tab: "edit" },
  { id: "export", label: "Exporter un PDF", icon: FileOutput, tab: "convert" },
  { id: "create", label: "Créer un PDF", icon: FilePlus2, tab: "organise" },
  { id: "combine", label: "Combiner des fichiers", icon: Combine, tab: "organise" },
  { id: "organise", label: "Organiser les pages", icon: Grid2x2, tab: "organise" },
  { id: "comment", label: "Commenter", icon: MessageSquarePlus, tab: "comment" },
  { id: "fillSign", label: "Remplir et signer", icon: PenTool, tab: "forms" },
  { id: "protect", label: "Protéger", icon: Lock, tab: "protect" },
  { id: "redact", label: "Caviarder", icon: Shield, tab: "protect" },
  { id: "prepareForm", label: "Préparer un formulaire", icon: LayoutGrid, tab: "forms" },
  { id: "ocr", label: "Numériser et OCR", icon: ScanText, tab: "convert" },
  { id: "compare", label: "Comparer des fichiers", icon: GitCompareArrows, tab: "convert" },
  { id: "accessibility", label: "Accessibilité", icon: Accessibility, tab: "convert" },
  { id: "standards", label: "Normes PDF", icon: Archive, tab: "convert" },
  { id: "measure", label: "Mesurer", icon: Ruler, tab: "view" },
  { id: "print", label: "Imprimer", icon: Printer, tab: "home" },
  { id: "file", label: "Fichier", icon: Save, tab: "home", hidden: true },
  { id: "view", label: "Affichage", icon: BookOpen, tab: "view", hidden: true },
];

/** What `when` looks at: the parts of the workspace that make a command meaningful. */
export interface CommandContext {
  hasForm: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasRedactions: boolean;
  encrypted: boolean;
  /** Pages in the document. */
  pageCount: number;
}

export interface CommandDef {
  /** `command(id)`'s id; a tool's is `tool:<tool>`. */
  id: string;
  label: string;
  family: FamilyId;
  icon: LucideIcon;
  kind: CommandKind;
  /** The tool a « tool » entry picks. */
  tool?: Tool;
  /** Shown beside the label (Acrobat's notation, French key names). */
  shortcut?: string;
  /** The single key that picks this tool (« Raccourcis à une touche »). */
  key?: string;
  /** Other words the palette matches. */
  keywords?: string[];
  /** Meaningful now? (a form to fill, something to undo…) */
  when?: (ctx: CommandContext) => boolean;
}

/** The right each command needs on a restricted document. */
export const COMMAND_RIGHT: Record<string, CommandRight[]> = {
  print: ["print"],
  printSummary: ["print"],
  exportImages: ["copy"],
  exportDocx: ["copy"],
  exportXlsx: ["copy"],
  exportPptx: ["copy"],
  exportRtf: ["copy"],
  exportText: ["copy"],
  exportHtml: ["copy"],
  exportTables: ["copy"],
  extract: ["assemble", "copy"],
  split: ["assemble", "copy"],
  merge: ["assemble", "copy"],
  organise: ["assemble"],
  insertBlank: ["assemble"],
  insertFile: ["assemble"],
  insertImage: ["assemble"],
  insertClipboard: ["assemble"],
  rotateDialog: ["assemble"],
  movePages: ["assemble"],
  replacePages: ["assemble"],
  rotateLeft: ["assemble"],
  rotateRight: ["assemble"],
  duplicatePage: ["assemble"],
  deletePage: ["assemble"],
  reverse: ["assemble"],
  crop: ["modify"],
  resize: ["modify"],
  pageLabels: ["modify"],
  editMode: ["modify"],
  addImage: ["modify"],
  formPrepare: ["modify"],
  detectFields: ["modify"],
  formFlatten: ["modify"],
  watermark: ["modify"],
  headerFooter: ["modify"],
  bates: ["modify"],
  redactSearch: ["modify"],
  redactApply: ["modify"],
  linksFromUrls: ["modify"],
  sanitise: ["modify"],
  optimise: ["modify"],
  ocr: ["modify"],
  bookmarkAdd: ["modify"],
  bookmarksFromHeadings: ["modify"],
  insertText: ["annotate"],
  replaceText: ["annotate"],
  addText: ["annotate"],
  attachFile: ["annotate"],
  stampCustom: ["annotate"],
  importComments: ["annotate"],
  importFormData: ["fillForms"],
  formReset: ["fillForms"],
  signature: ["fillForms"],
  signPades: ["fillForms"],
  signSelfSigned: ["fillForms"],
  certify: ["fillForms"],
  protect: ["owner"],
  unprotect: ["owner"],
  // A PDF/A copy carries no protection.
  pdfa: ["owner"],
};

const cmd = (
  id: string,
  label: string,
  family: FamilyId,
  icon: LucideIcon,
  more: Partial<CommandDef> = {},
): CommandDef => ({ id, label, family, icon, kind: "command", ...more });
const tool = (
  t: Tool,
  label: string,
  family: FamilyId,
  icon: LucideIcon,
  more: Partial<CommandDef> = {},
): CommandDef => ({
  id: `tool:${t}`,
  tool: t,
  label,
  family,
  icon,
  kind: "tool",
  ...more,
});
const hasForm = (c: CommandContext) => c.hasForm;

export const COMMANDS: CommandDef[] = [
  // --- Modifier le PDF -------------------------------------------------------
  cmd("editMode", "Modifier le texte et les images", "edit", TextCursorInput, {
    kind: "toggle",
    keywords: ["éditer", "réécrire", "contenu"],
  }),
  cmd("addText", "Ajouter du texte", "edit", TextCursorInput, { keywords: ["contenu", "écrire"] }),
  cmd("addImage", "Ajouter une image", "edit", ImageIcon, { keywords: ["photo", "insérer"] }),
  tool("image", "Image en tampon", "edit", ImageIcon, { keywords: ["annotation", "photo"] }),
  tool("typewriter", "Machine à écrire", "edit", Type, { keywords: ["texte", "taper"] }),
  tool("whiteout", "Masquer (blanc)", "edit", PaintBucket, { keywords: ["effacer", "blanc", "cacher"] }),
  tool("link", "Créer un lien", "edit", ArrowRight, { keywords: ["url", "hyperlien", "lien"] }),
  cmd("linksFromUrls", "Créer des liens à partir des adresses web", "edit", Link2, { keywords: ["url", "lien"] }),
  cmd("watermark", "Filigrane", "edit", Droplet, { keywords: ["marque", "arrière-plan", "watermark"] }),
  cmd("headerFooter", "En-tête et pied de page", "edit", PanelTop, { keywords: ["numéro", "entête"] }),
  cmd("bates", "Numérotation Bates", "edit", Hash, { keywords: ["numéroter", "juridique"] }),
  cmd("bookmarkAdd", "Ajouter un signet", "edit", FileText, { keywords: ["marque-page", "plan"] }),
  cmd("bookmarksFromHeadings", "Créer des signets depuis les titres", "edit", LayoutGrid, {
    keywords: ["marque-page", "plan", "automatique"],
  }),

  // --- Exporter un PDF -------------------------------------------------------
  cmd("exportDocx", "Exporter vers Word", "export", FileType2, { keywords: ["docx", "convertir"] }),
  cmd("exportXlsx", "Exporter vers Excel", "export", FileSpreadsheet, { keywords: ["xlsx", "tableur", "convertir"] }),
  cmd("exportPptx", "Exporter vers PowerPoint", "export", Presentation, { keywords: ["pptx", "diapositives"] }),
  cmd("exportImages", "Exporter en images", "export", FileImage, { keywords: ["png", "jpeg", "jpg"] }),
  cmd("exportText", "Exporter en texte", "export", FileText, { keywords: ["txt", "brut"] }),
  cmd("exportTables", "Exporter les tableaux (CSV)", "export", FileSpreadsheet, { keywords: ["csv", "tableur"] }),
  cmd("exportHtml", "Exporter en HTML", "export", FileOutput, { keywords: ["web", "page"] }),
  cmd("exportRtf", "Exporter en texte enrichi (RTF)", "export", FileText, { keywords: ["rtf"] }),

  // --- Créer un PDF ----------------------------------------------------------
  cmd("insertBlank", "Insérer une page blanche", "create", FilePlus2, { keywords: ["vierge", "nouvelle page"] }),
  cmd("insertImage", "Insérer des pages depuis une image", "create", FileImage, { keywords: ["photo", "scan"] }),
  cmd("insertClipboard", "Insérer depuis le presse-papiers", "create", ClipboardPaste, {
    keywords: ["coller", "presse-papiers"],
  }),

  // --- Combiner des fichiers -------------------------------------------------
  cmd("merge", "Combiner des fichiers", "combine", Combine, { keywords: ["fusionner", "assembler", "joindre"] }),
  cmd("insertFile", "Insérer des pages depuis un PDF", "combine", FileText, { keywords: ["ajouter", "fichier"] }),
  cmd("replacePages", "Remplacer des pages", "combine", Replace, { keywords: ["substituer"] }),

  // --- Organiser les pages ---------------------------------------------------
  cmd("organise", "Organiser les pages", "organise", Grid2x2, { kind: "toggle", keywords: ["vignettes", "ordre"] }),
  cmd("rotateLeft", "Faire pivoter à gauche", "organise", RotateCcw, { keywords: ["rotation", "tourner"] }),
  cmd("rotateRight", "Faire pivoter à droite", "organise", RotateCw, { keywords: ["rotation", "tourner"] }),
  cmd("rotateDialog", "Faire pivoter des pages…", "organise", RefreshCcw, {
    shortcut: "Ctrl+Maj+R",
    keywords: ["rotation", "tourner", "180"],
  }),
  cmd("movePages", "Déplacer des pages", "organise", MoveHorizontal, { keywords: ["ordre", "réorganiser"] }),
  cmd("duplicatePage", "Dupliquer la page", "organise", Copy, { keywords: ["copier"] }),
  cmd("deletePage", "Supprimer la page", "organise", Trash2, { keywords: ["effacer", "retirer"] }),
  cmd("extract", "Extraire des pages", "organise", Scissors, { keywords: ["enregistrer", "séparer"] }),
  cmd("split", "Diviser le document", "organise", Scissors, { keywords: ["séparer", "couper"] }),
  cmd("reverse", "Inverser l'ordre des pages", "organise", ArrowRight, { keywords: ["renverser"] }),
  cmd("crop", "Recadrer les pages", "organise", Crop, { keywords: ["rogner", "marges"] }),
  cmd("resize", "Redimensionner les pages", "organise", Move, { keywords: ["taille", "format", "a4"] }),
  cmd("pageLabels", "Étiquettes de page", "organise", Hash, { keywords: ["numérotation", "romain"] }),

  // --- Commenter -------------------------------------------------------------
  tool("highlight", "Surligner le texte", "comment", Highlighter, {
    shortcut: "Ctrl+Maj+H",
    key: "G",
    keywords: ["surlignage", "marquer"],
  }),
  tool("underline", "Souligner le texte", "comment", Underline, { key: "U", keywords: ["soulignement"] }),
  tool("strikeout", "Barrer le texte", "comment", Strikethrough, { key: "K", keywords: ["rayer", "barré"] }),
  tool("squiggly", "Souligner en ondulé", "comment", Waves, { keywords: ["vague"] }),
  cmd("insertText", "Insérer du texte au curseur", "comment", TextCursorInput, { keywords: ["caret", "ajout"] }),
  cmd("replaceText", "Remplacer le texte sélectionné", "comment", Replace, { keywords: ["correction"] }),
  tool("note", "Ajouter une note", "comment", MessageSquarePlus, {
    key: "N",
    keywords: ["commentaire", "note autocollante"],
  }),
  cmd("attachFile", "Joindre un fichier", "comment", Paperclip, { keywords: ["pièce jointe", "attacher"] }),
  tool("freetext", "Zone de texte", "comment", Type, { keywords: ["texte libre", "commentaire"] }),
  tool("callout", "Légende", "comment", Spline, { keywords: ["bulle", "flèche"] }),
  tool("stamp", "Tampon", "comment", Stamp, { keywords: ["approuvé", "cachet"] }),
  cmd("stampCustom", "Créer un tampon à partir d'une image", "comment", Stamp, { keywords: ["cachet", "logo"] }),
  tool("ink", "Dessin libre", "comment", PencilLine, { key: "D", keywords: ["crayon", "main levée"] }),
  tool("square", "Rectangle", "comment", BoxSelect, { key: "R", keywords: ["forme", "cadre"] }),
  tool("circle", "Ellipse", "comment", Circle, { key: "E", keywords: ["forme", "cercle", "ovale"] }),
  tool("line", "Trait", "comment", Minus, { key: "L", keywords: ["ligne", "forme"] }),
  tool("arrow", "Flèche", "comment", ArrowUpRight, { key: "A", keywords: ["forme"] }),
  tool("polygon", "Polygone", "comment", Pentagon, { keywords: ["forme"] }),
  tool("polyline", "Ligne brisée", "comment", Shapes, { keywords: ["forme", "polyligne"] }),
  tool("cloud", "Nuage", "comment", Cloud, { keywords: ["forme", "révision"] }),
  tool("eraser", "Gomme", "comment", Eraser, { key: "X", keywords: ["effacer"] }),
  cmd("exportComments", "Exporter les commentaires (XFDF)", "comment", FileDown, { keywords: ["xfdf", "annotations"] }),
  cmd("exportCommentsFdf", "Exporter les commentaires (FDF)", "comment", FileDown, {
    keywords: ["fdf", "annotations"],
  }),
  cmd("importComments", "Importer des commentaires", "comment", FileOutput, { keywords: ["xfdf", "fdf"] }),
  cmd("commentsReport", "Résumer les commentaires", "comment", FileText, { keywords: ["synthèse", "rapport"] }),
  cmd("printSummary", "Imprimer la synthèse des commentaires", "comment", Printer, { keywords: ["synthèse"] }),
  cmd("setAuthor", "Nom de l'auteur des commentaires", "comment", UserRound, { keywords: ["identité", "nom"] }),

  // --- Remplir et signer -----------------------------------------------------
  cmd("formMode", "Remplir le formulaire", "fillSign", PenSquare, { keywords: ["champs", "saisir"], when: hasForm }),
  cmd("formReset", "Effacer le formulaire", "fillSign", Ban, { keywords: ["réinitialiser"], when: hasForm }),
  cmd("fsCheck", "Ajouter une coche", "fillSign", Check, { keywords: ["cocher"] }),
  cmd("fsCross", "Ajouter une croix", "fillSign", X, { keywords: ["croix"] }),
  cmd("fsDot", "Ajouter un point", "fillSign", Dot, { keywords: ["point"] }),
  cmd("fsDate", "Ajouter la date", "fillSign", CalendarDays, { keywords: ["aujourd'hui", "jour"] }),
  cmd("signature", "Signer (signature manuscrite)", "fillSign", PenTool, { keywords: ["signer", "parapher"] }),
  cmd("initials", "Ajouter vos initiales", "fillSign", PenLine, { keywords: ["parapher"] }),

  // --- Protéger --------------------------------------------------------------
  cmd("protect", "Protéger par mot de passe", "protect", Lock, { keywords: ["chiffrer", "sécurité", "autorisations"] }),
  cmd("unprotect", "Retirer la protection", "protect", Unlock, {
    keywords: ["déverrouiller", "mot de passe"],
    when: (c) => c.encrypted,
  }),
  cmd("signPades", "Signer avec un certificat", "protect", PenSquare, { keywords: ["pades", "numérique"] }),
  cmd("certify", "Certifier le document", "protect", FileSignature, { keywords: ["certification"] }),
  cmd("verifyPades", "Vérifier les signatures", "protect", ShieldCheck, { keywords: ["validité", "panneau"] }),
  cmd("identities", "Identités numériques", "protect", KeyRound, { keywords: ["certificats", "p12", "pfx"] }),
  cmd("sanitise", "Assainir le document", "protect", Eraser, { keywords: ["métadonnées", "nettoyer"] }),
  cmd("inspect", "Inspecter le document", "protect", FileSearch, { keywords: ["caché", "métadonnées"] }),
  cmd("toggleScripts", "Activer JavaScript", "protect", FileCode, { kind: "toggle", keywords: ["scripts", "js"] }),

  // --- Caviarder -------------------------------------------------------------
  tool("redact", "Caviarder du texte et des images", "redact", BoxSelect, { keywords: ["marquer", "noircir"] }),
  cmd("redactSearch", "Rechercher et caviarder", "redact", FileSearch, { keywords: ["occurrences", "marquer"] }),
  cmd("redactApply", "Appliquer le caviardage", "redact", Shield, {
    keywords: ["supprimer", "définitif"],
    when: (c) => c.hasRedactions,
  }),

  // --- Préparer un formulaire ------------------------------------------------
  cmd("formPrepare", "Préparer un formulaire", "prepareForm", LayoutGrid, { kind: "toggle", keywords: ["champs"] }),
  tool("field:text", "Champ de texte", "prepareForm", Type, { keywords: ["champ"] }),
  tool("field:checkbox", "Case à cocher", "prepareForm", BoxSelect, { keywords: ["champ"] }),
  tool("field:radio", "Bouton radio", "prepareForm", Circle, { keywords: ["champ", "option"] }),
  tool("field:dropdown", "Liste déroulante", "prepareForm", Table, { keywords: ["champ", "menu"] }),
  tool("field:signature", "Champ de signature", "prepareForm", FileSignature, { keywords: ["champ"] }),
  cmd("detectFields", "Détecter les champs", "prepareForm", Scan, { keywords: ["automatique"] }),
  cmd("formFlatten", "Aplatir le formulaire", "prepareForm", Lock, { keywords: ["figer"], when: hasForm }),
  cmd("exportFormData", "Exporter les données (FDF)", "prepareForm", FileDown, { keywords: ["fdf"] }),
  cmd("exportFormXfdf", "Exporter les données (XFDF)", "prepareForm", FileDown, { keywords: ["xfdf", "xml"] }),
  cmd("exportFormCsv", "Exporter les données (CSV)", "prepareForm", FileSpreadsheet, { keywords: ["csv"] }),
  cmd("exportFormText", "Exporter les données (texte tabulé)", "prepareForm", FileSpreadsheet, {
    keywords: ["txt"],
  }),
  cmd("importFormData", "Importer des données de formulaire", "prepareForm", FileOutput, {
    keywords: ["fdf", "xfdf"],
  }),

  // --- Numériser et OCR ------------------------------------------------------
  cmd("ocr", "Reconnaître le texte (OCR)", "ocr", ScanText, { keywords: ["scan", "numérisé", "cherchable"] }),

  // --- Comparer des fichiers -------------------------------------------------
  cmd("compare", "Comparer des fichiers", "compare", GitCompareArrows, { keywords: ["différences", "versions"] }),

  // --- Accessibilité ---------------------------------------------------------
  cmd("accessibility", "Vérifier l'accessibilité", "accessibility", Accessibility, {
    keywords: ["balises", "langue", "titre"],
  }),
  cmd("readAloud", "Lire à voix haute", "accessibility", Volume2, { keywords: ["synthèse vocale", "audio"] }),

  // --- Normes PDF ------------------------------------------------------------
  cmd("pdfa", "Enregistrer au format PDF/A", "standards", Archive, { keywords: ["archivage", "pdfa"] }),
  cmd("optimise", "Optimiser le PDF", "standards", FileDown, { keywords: ["compresser", "réduire", "taille"] }),
  cmd("spaceAudit", "Audit de l'espace utilisé", "standards", PieChart, { keywords: ["poids", "taille"] }),

  // --- Mesurer ---------------------------------------------------------------
  tool("distance", "Distance", "measure", Ruler, { keywords: ["mesure", "longueur"] }),
  tool("perimeter", "Périmètre", "measure", Spline, { keywords: ["mesure"] }),
  tool("area", "Surface", "measure", Pentagon, { keywords: ["mesure", "aire"] }),
  cmd("measureScale", "Échelle de mesure", "measure", Ruler, { keywords: ["unité", "calibrer"] }),

  // --- Imprimer --------------------------------------------------------------
  cmd("print", "Imprimer", "print", Printer, { shortcut: "Ctrl+P", keywords: ["imprimante", "papier"] }),

  // --- Fichier (palette seulement) -------------------------------------------
  cmd("save", "Enregistrer", "file", Save, { shortcut: "Ctrl+S" }),
  cmd("saveAs", "Enregistrer sous…", "file", FileOutput, { shortcut: "Ctrl+Maj+S", keywords: ["copie"] }),
  cmd("saveElium", "Enregistrer en .elium", "file", ShieldCheck, { keywords: ["scellé", "elium"] }),
  cmd("downloadOriginal", "Télécharger l'original", "file", Download),
  cmd("properties", "Propriétés du document", "file", FileSearch, {
    shortcut: "Ctrl+D",
    keywords: ["métadonnées", "titre", "auteur"],
  }),
  cmd("undo", "Annuler", "file", Undo2, { shortcut: "Ctrl+Z", when: (c) => c.canUndo }),
  cmd("redo", "Rétablir", "file", Redo2, { shortcut: "Ctrl+Y", when: (c) => c.canRedo }),

  // --- Affichage (palette seulement) -----------------------------------------
  tool("select", "Sélectionner", "view", MousePointer2, { key: "V", keywords: ["objet", "flèche"] }),
  tool("textSelect", "Sélection de texte", "view", Baseline, { key: "T", keywords: ["copier"] }),
  tool("hand", "Main", "view", Hand, { key: "H", keywords: ["déplacer", "défiler"] }),
  tool("zoomArea", "Zoom sur une zone", "view", Focus, { key: "Z", keywords: ["loupe"] }),
  cmd("zoomIn", "Zoom avant", "view", ZoomIn, { shortcut: "Ctrl++", keywords: ["agrandir"] }),
  cmd("zoomOut", "Zoom arrière", "view", ZoomOut, { shortcut: "Ctrl+-", keywords: ["réduire"] }),
  cmd("fitPage", "Page entière", "view", Focus, { shortcut: "Ctrl+0", keywords: ["zoom", "ajuster"] }),
  cmd("fitWidth", "Largeur de page", "view", Move, { shortcut: "Ctrl+2", keywords: ["zoom", "ajuster"] }),
  cmd("fitVisible", "Zone de texte", "view", Maximize2, { shortcut: "Ctrl+3", keywords: ["zoom", "ajuster"] }),
  cmd("viewSingle", "Une page", "view", FileText, { kind: "toggle", keywords: ["disposition"] }),
  cmd("viewContinuous", "Défilement continu", "view", LayoutGrid, { kind: "toggle", keywords: ["disposition"] }),
  cmd("viewFacing", "Double page", "view", Grid2x2, { kind: "toggle", keywords: ["disposition", "deux pages"] }),
  cmd("spreadCover", "Afficher la page de couverture", "view", BookOpen, {
    kind: "toggle",
    keywords: ["double page", "couverture"],
  }),
  cmd("toggleGrid", "Grille et magnétisme", "view", Grid3x3, { kind: "toggle", keywords: ["aligner", "grille"] }),
  cmd("rotateView", "Faire pivoter la vue", "view", RotateCw, { keywords: ["rotation", "tourner"] }),
  cmd("theme", "Thème de lecture", "view", Sun, { keywords: ["nuit", "sépia", "contraste"] }),
  cmd("readingMode", "Mode lecture", "view", BookOpen, { kind: "toggle", shortcut: "Ctrl+H", keywords: ["lire"] }),
  cmd("fullscreen", "Plein écran", "view", Contrast, {
    kind: "toggle",
    shortcut: "Ctrl+L",
    keywords: ["présentation"],
  }),
  cmd("panelLayers", "Calques", "view", Layers, { keywords: ["contenu facultatif"] }),
  cmd("toggleSingleKeys", "Raccourcis à une touche", "view", Keyboard, {
    kind: "toggle",
    keywords: ["clavier", "préférence", "touches"],
  }),
];

export const COMMAND_BY_ID: ReadonlyMap<string, CommandDef> = new Map(COMMANDS.map((c) => [c.id, c]));

/** The tool each single key picks (« Raccourcis à une touche »). */
export const SINGLE_KEY_TOOLS: Readonly<Record<string, Tool>> = Object.fromEntries(
  COMMANDS.filter((c) => c.key && c.tool).map((c) => [c.key!.toLowerCase(), c.tool!]),
);

/** The single key of `tool`, if it has one. */
export function toolKey(t: Tool): string | undefined {
  return COMMAND_BY_ID.get(`tool:${t}`)?.key;
}

/** The rights an entry needs on a restricted document. */
export function rightsOf(def: CommandDef): CommandRight[] {
  if (def.tool) {
    if (def.tool.startsWith("field:")) return ["modify"];
    // Same test as `toolIsAnnot` (kept here to avoid importing the model at runtime).
    if (!["select", "hand", "textSelect", "zoomArea", "snapshot", "eraser"].includes(def.tool)) return ["annotate"];
    return [];
  }
  return COMMAND_RIGHT[def.id] ?? [];
}

/** Does `restrictions` (null: none) allow `right`? Same rule as the workspace's `requireRight`. */
export function hasRight(restrictions: Permissions | null, right: CommandRight): boolean {
  if (!restrictions) return true;
  if (right === "owner") return false;
  return restrictions[right] || (right === "fillForms" && restrictions.annotate);
}

/** Why an entry cannot run now, or null when it can. */
export function unavailableReason(
  def: CommandDef,
  ctx: CommandContext,
  restrictions: Permissions | null,
): string | null {
  if (!rightsOf(def).every((r) => hasRight(restrictions, r))) return "Interdit par la protection du document";
  if (def.when && !def.when(ctx)) return "Indisponible pour ce document";
  return null;
}

/** Lower case, accents removed: « Écran » matches « ecran ». */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * How well `query` matches `def` (higher is better), or 0. Every word of the
 * query must be found, in the label or the keywords; a word starting the
 * label counts most, then a word starting any word, then a subsequence.
 */
export function matchScore(def: CommandDef, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = fold(def.label);
  const family = fold(FAMILIES.find((f) => f.id === def.family)?.label ?? "");
  const extra = [...(def.keywords ?? []).map(fold), family];
  let total = 0;
  for (const w of words) {
    let best = 0;
    if (label.startsWith(w)) best = 10;
    else if (new RegExp(`(^|[\\s'(/-])${escapeRe(w)}`).test(label)) best = 8;
    else if (label.includes(w)) best = 6;
    else if (extra.some((k) => k.startsWith(w) || k.includes(` ${w}`))) best = 4;
    else if (extra.some((k) => k.includes(w))) best = 3;
    else if (isSubsequence(w, label)) best = 1;
    if (!best) return 0;
    total += best;
  }
  return total;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length && needle.length >= 3;
}
