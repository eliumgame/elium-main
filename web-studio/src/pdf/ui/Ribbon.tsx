import { useEffect, useRef, useState } from "react";
import {
  DYNAMIC_STAMPS,
  STANDARD_STAMPS,
  forgetCustomStamp,
  loadCustomStamps,
  type CustomStamp,
  type StampDef,
} from "../model/stamps";
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Baseline,
  Bold,
  BoxSelect,
  Circle,
  Cloud,
  ClipboardPaste,
  Combine,
  Contrast,
  Copy,
  Crop,
  Download,
  Droplet,
  Eraser,
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
  Hand,
  Hash,
  Link2,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Layers,
  LayoutGrid,
  FileCode,
  Lock,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  Move,
  PaintBucket,
  MoveHorizontal,
  RefreshCcw,
  Paperclip,
  PanelTop,
  PencilLine,
  PenSquare,
  PenTool,
  Pentagon,
  Printer,
  Redo2,
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
  Replace,
  Unlock,
  UserRound,
  Volume2,
  Waves,
  ZoomIn,
  ZoomOut,
  KeyRound,
  Check,
  X,
  Dot,
  CalendarDays,
  PenLine,
  PieChart,
} from "lucide-react";
import type { DraftStyle, Tool } from "../model/types";
import { HIGHLIGHT_SWATCHES, INK_SWATCHES } from "../model/types";
import { allFontNames } from "../../ui/fonts";
import type { RibbonTab } from "./state";

/**
 * The command surface: a tab strip plus one contextual ribbon per tab.
 *
 * Grouping mirrors Acrobat so muscle memory transfers, but the ribbon is a
 * single scrollable row of labelled groups rather than a two-storey toolbar —
 * it stays readable at 1280 px and collapses gracefully below that.
 */

export interface RibbonAction {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}

export interface RibbonProps {
  tab: RibbonTab;
  tool: Tool;
  style: DraftStyle;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasForm: boolean;
  /** « Préparer un formulaire » is on. */
  preparing?: boolean;
  busy: boolean;
  stickyTool: boolean;
  /** Documents' JavaScript is on (Acrobat's « Activer JavaScript »). */
  scriptsOn?: boolean;
  onTab: (tab: RibbonTab) => void;
  onTool: (tool: Tool) => void;
  onStyle: (patch: Partial<DraftStyle>) => void;
  onCommand: (id: string) => void;
  onStickyTool: (v: boolean) => void;
}

export const RIBBON_TABS: { id: RibbonTab; label: string }[] = [
  { id: "home", label: "Accueil" },
  { id: "comment", label: "Commenter" },
  { id: "edit", label: "Modifier" },
  { id: "organise", label: "Organiser" },
  { id: "forms", label: "Formulaires" },
  { id: "protect", label: "Protéger" },
  { id: "convert", label: "Convertir" },
  { id: "view", label: "Affichage" },
];

function Group({
  title,
  children,
  optional,
}: {
  title: string;
  children: React.ReactNode;
  /** Groupe secondaire : masqué en premier quand le ruban manque de place
   * sur petit écran (`@container editor (max-width: 700px)` dans
   * workspace.css) plutôt que de laisser le ruban défiler sur plusieurs
   * écrans de large. Réservé aux fonctionnalités avancées/peu fréquentes —
   * jamais aux groupes de base utilisés en continu. */
  optional?: boolean;
}) {
  return (
    <div className={`pdfx-group${optional ? " pdfx-group--optional" : ""}`}>
      <div className="pdfx-group__items">{children}</div>
      <div className="pdfx-group__title">{title}</div>
    </div>
  );
}

function Cmd({
  icon,
  label,
  onClick,
  active,
  disabled,
  danger,
  title,
  big,
}: {
  icon: React.ReactNode;
  label?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  big?: boolean;
}) {
  return (
    <button
      type="button"
      className={`pdfx-cmd ${big ? "pdfx-cmd--big" : ""} ${active ? "is-active" : ""} ${danger ? "is-danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      <span className="pdfx-cmd__icon">{icon}</span>
      {label && <span className="pdfx-cmd__label">{label}</span>}
    </button>
  );
}

/**
 * The Tampon button and its library: Acrobat's standard and dynamic stamps,
 * the user's picture stamps, and « Créer à partir d'une image… ».
 */
function StampMenu(p: {
  style: DraftStyle;
  active: boolean;
  onPick: (patch: Partial<DraftStyle>) => void;
  onCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<CustomStamp[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setCustom(loadCustomStamps());
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (patch: Partial<DraftStyle>) => {
    setOpen(false);
    p.onPick(patch);
  };
  const item = (s: StampDef) => (
    <button
      key={s.id}
      type="button"
      role="menuitem"
      className={`pdfx-stampmenu__item ${!p.style.stampSrc && p.style.stamp === s.id ? "is-active" : ""}`}
      onClick={() => pick({ stamp: s.id, stampSrc: null })}
    >
      <span className="pdfx-stamp" data-tone={s.tone}>
        <span className="pdfx-stamp__label">{s.label}</span>
        {s.dynamic && <span className="pdfx-stamp__sub">par vous, date et heure</span>}
      </span>
    </button>
  );
  return (
    <div className="pdfx-stampmenu" ref={box}>
      <Cmd icon={<Stamp size={17} />} onClick={() => setOpen((v) => !v)} active={p.active || open} title="Tampon" />
      {open && (
        <div className="pdfx-stampmenu__panel" role="menu" aria-label="Tampons">
          <div className="pdfx-stampmenu__title">Standard</div>
          <div className="pdfx-stampmenu__grid">{STANDARD_STAMPS.map(item)}</div>
          <div className="pdfx-stampmenu__title">Dynamiques</div>
          <div className="pdfx-stampmenu__grid">{DYNAMIC_STAMPS.map(item)}</div>
          <div className="pdfx-stampmenu__title">Personnalisés</div>
          <div className="pdfx-stampmenu__grid">
            {custom.map((c) => (
              <span key={c.id} className="pdfx-stampmenu__custom">
                <button
                  type="button"
                  role="menuitem"
                  className={`pdfx-stampmenu__item ${p.style.stampSrc === c.src ? "is-active" : ""}`}
                  title={c.label}
                  onClick={() => pick({ stampSrc: c.src, stampRatio: c.ratio })}
                >
                  <img src={c.src} alt={c.label} />
                </button>
                <button
                  type="button"
                  className="pdfx-stampmenu__forget"
                  aria-label={`Oublier ${c.label}`}
                  onClick={() => setCustom(forgetCustomStamp(c.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            className="pdfx-stampmenu__create"
            onClick={() => {
              setOpen(false);
              p.onCustom();
            }}
          >
            Créer à partir d'une image…
          </button>
        </div>
      )}
    </div>
  );
}

function Swatches({
  colours,
  value,
  onPick,
}: {
  colours: readonly string[];
  value: string;
  onPick: (c: string) => void;
}) {
  return (
    <div className="pdfx-swatches">
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          className={`pdfx-swatch ${value.toLowerCase() === c.toLowerCase() ? "is-active" : ""}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
          title={c}
        />
      ))}
    </div>
  );
}

export default function Ribbon(p: RibbonProps) {
  const fontRef = useRef<HTMLSelectElement>(null);
  const T = (tool: Tool) => () => p.onTool(tool);
  const C = (id: string) => () => p.onCommand(id);
  const textTool = ["freetext", "typewriter", "callout"].includes(p.tool);
  const shapeTool = ["square", "circle", "line", "arrow", "polygon", "polyline", "cloud", "ink"].includes(p.tool);
  const markupTool = ["highlight", "underline", "strikeout", "squiggly"].includes(p.tool);

  return (
    <div className="pdfx-ribbon" role="region" aria-label="Barre d'outils PDF">
      <div className="pdfx-tabs" role="tablist">
        {RIBBON_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            className={`pdfx-tab ${p.tab === t.id ? "is-active" : ""}`}
            onClick={() => p.onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="pdfx-ribbon__body">
        <Group title="Édition">
          <Cmd icon={<Undo2 size={17} />} onClick={C("undo")} disabled={!p.canUndo} title="Annuler (Ctrl+Z)" />
          <Cmd icon={<Redo2 size={17} />} onClick={C("redo")} disabled={!p.canRedo} title="Rétablir (Ctrl+Y)" />
        </Group>

        <Group title="Navigation">
          <Cmd
            icon={<MousePointer2 size={17} />}
            onClick={T("select")}
            active={p.tool === "select"}
            title="Sélectionner (V)"
          />
          <Cmd
            icon={<Baseline size={17} />}
            onClick={T("textSelect")}
            active={p.tool === "textSelect"}
            title="Sélection de texte (T)"
          />
          <Cmd icon={<Hand size={17} />} onClick={T("hand")} active={p.tool === "hand"} title="Main (H)" />
          <Cmd
            icon={<Focus size={17} />}
            onClick={T("zoomArea")}
            active={p.tool === "zoomArea"}
            title="Zoom sur une zone (Z)"
          />
        </Group>

        {p.tab === "home" && (
          <>
            <Group title="Fichier">
              <Cmd
                big
                icon={<Save size={19} />}
                label="Enregistrer"
                onClick={C("save")}
                disabled={p.busy}
                title="Enregistrer dans le fichier (Ctrl+S)"
              />
              <Cmd
                icon={<FileOutput size={17} />}
                onClick={C("saveAs")}
                disabled={p.busy}
                title="Enregistrer sous… / une copie (Ctrl+Maj+S)"
              />
              <Cmd
                big
                icon={<ShieldCheck size={19} />}
                label=".elium"
                onClick={C("saveElium")}
                title="Enregistrer scellé et re-modifiable"
              />
              <Cmd big icon={<Printer size={19} />} label="Imprimer" onClick={C("print")} title="Imprimer (Ctrl+P)" />
              <Cmd icon={<Download size={17} />} onClick={C("downloadOriginal")} title="Télécharger l'original" />
            </Group>
            <Group title="Outils rapides">
              <Cmd
                big
                icon={<Highlighter size={19} />}
                label="Surligner"
                onClick={T("highlight")}
                active={p.tool === "highlight"}
              />
              <Cmd
                big
                icon={<MessageSquarePlus size={19} />}
                label="Note"
                onClick={T("note")}
                active={p.tool === "note"}
              />
              <Cmd big icon={<PenTool size={19} />} label="Signer" onClick={C("signature")} />
              <Cmd big icon={<TextCursorInput size={19} />} label="Modifier le texte" onClick={C("editMode")} />
            </Group>
            <Group title="Document">
              <Cmd icon={<FileSearch size={17} />} onClick={C("properties")} label="Propriétés" />
              <Cmd
                icon={<Combine size={17} />}
                onClick={C("merge")}
                label="Combiner"
                title="Combiner des fichiers (PDF et images) en un nouveau document"
              />
              <Cmd icon={<Scissors size={17} />} onClick={C("split")} label="Diviser" />
            </Group>
          </>
        )}

        {p.tab === "comment" && (
          <>
            <Group title="Texte">
              <Cmd
                icon={<Highlighter size={17} />}
                onClick={T("highlight")}
                active={p.tool === "highlight"}
                title="Surligner (Ctrl+Maj+H)"
              />
              <Cmd
                icon={<Underline size={17} />}
                onClick={T("underline")}
                active={p.tool === "underline"}
                title="Souligner"
              />
              <Cmd
                icon={<Strikethrough size={17} />}
                onClick={T("strikeout")}
                active={p.tool === "strikeout"}
                title="Barrer"
              />
              <Cmd
                icon={<TextCursorInput size={17} />}
                onClick={C("insertText")}
                title="Insérer du texte au curseur (cliquez d'abord dans le texte)"
              />
              <Cmd icon={<Replace size={17} />} onClick={C("replaceText")} title="Remplacer le texte sélectionné" />
              <Cmd
                icon={<Waves size={17} />}
                onClick={T("squiggly")}
                active={p.tool === "squiggly"}
                title="Souligner en ondulé"
              />
            </Group>
            <Group title="Notes">
              <Cmd
                icon={<MessageSquarePlus size={17} />}
                onClick={T("note")}
                active={p.tool === "note"}
                title="Note autocollante"
              />
              <Cmd
                icon={<Paperclip size={17} />}
                onClick={C("attachFile")}
                active={p.tool === "attachment"}
                title="Joindre un fichier"
              />
              <Cmd
                icon={<Type size={17} />}
                onClick={T("freetext")}
                active={p.tool === "freetext"}
                title="Zone de texte"
              />
              <Cmd icon={<Spline size={17} />} onClick={T("callout")} active={p.tool === "callout"} title="Légende" />
              <StampMenu
                style={p.style}
                active={p.tool === "stamp"}
                onPick={(patch) => {
                  p.onStyle(patch);
                  p.onTool("stamp");
                }}
                onCustom={C("stampCustom")}
              />
            </Group>
            <Group title="Dessin">
              <Cmd icon={<PencilLine size={17} />} onClick={T("ink")} active={p.tool === "ink"} title="Dessin libre" />
              <Cmd
                icon={<BoxSelect size={17} />}
                onClick={T("square")}
                active={p.tool === "square"}
                title="Rectangle"
              />
              <Cmd icon={<Circle size={17} />} onClick={T("circle")} active={p.tool === "circle"} title="Ellipse" />
              <Cmd icon={<Minus size={17} />} onClick={T("line")} active={p.tool === "line"} title="Trait" />
              <Cmd icon={<ArrowUpRight size={17} />} onClick={T("arrow")} active={p.tool === "arrow"} title="Flèche" />
              <Cmd
                icon={<Pentagon size={17} />}
                onClick={T("polygon")}
                active={p.tool === "polygon"}
                title="Polygone"
              />
              <Cmd
                icon={<Shapes size={17} />}
                onClick={T("polyline")}
                active={p.tool === "polyline"}
                title="Ligne brisée"
              />
              <Cmd icon={<Cloud size={17} />} onClick={T("cloud")} active={p.tool === "cloud"} title="Nuage" />
              <Cmd icon={<Eraser size={17} />} onClick={T("eraser")} active={p.tool === "eraser"} title="Gomme" />
            </Group>
            <Group title="Révision" optional>
              <Cmd
                icon={<FileDown size={17} />}
                onClick={C("exportComments")}
                label="Exporter"
                title="Exporter les commentaires (XFDF)"
              />
              <Cmd
                icon={<FileDown size={17} />}
                onClick={C("exportCommentsFdf")}
                label="Exporter FDF"
                title="Exporter les commentaires (FDF, format natif d'Acrobat)"
              />
              <Cmd
                icon={<UserRound size={17} />}
                onClick={C("setAuthor")}
                label="Auteur"
                title="Nom de l'auteur de vos commentaires"
              />
              <Cmd
                icon={<FileOutput size={17} />}
                onClick={C("importComments")}
                label="Importer"
                title="Importer des commentaires (XFDF)"
              />
              <Cmd
                icon={<FileText size={17} />}
                onClick={C("commentsReport")}
                label="Synthèse"
                title="Résumer les commentaires (PDF : pages et commentaires reliés)"
              />
              <Cmd
                icon={<Printer size={17} />}
                onClick={C("printSummary")}
                title="Imprimer la synthèse des commentaires"
              />
            </Group>
          </>
        )}

        {p.tab === "edit" && (
          <>
            <Group title="Contenu">
              <Cmd
                big
                icon={<TextCursorInput size={19} />}
                label="Modifier le texte"
                onClick={C("editMode")}
                title="Réécrire le texte du PDF"
              />
              <Cmd
                big
                icon={<TextCursorInput size={19} />}
                label="Ajouter du texte"
                onClick={C("addText")}
                title="Ajouter du texte dans la page (contenu du PDF, pas un commentaire)"
              />
              <Cmd
                big
                icon={<ImageIcon size={19} />}
                label="Ajouter une image"
                onClick={C("addImage")}
                title="Ajouter une image dans la page (contenu du PDF, déplaçable dans « Modifier le texte »)"
              />
              <Cmd
                icon={<ImageIcon size={17} />}
                onClick={T("image")}
                active={p.tool === "image"}
                title="Image en tampon (annotation par-dessus la page)"
              />
              <Cmd
                icon={<Type size={17} />}
                onClick={T("typewriter")}
                active={p.tool === "typewriter"}
                title="Machine à écrire"
              />
              <Cmd
                icon={<PaintBucket size={17} />}
                onClick={T("whiteout")}
                active={p.tool === "whiteout"}
                title="Masquer (blanc)"
              />
              <Cmd
                icon={<ArrowRight size={17} />}
                onClick={T("link")}
                active={p.tool === "link"}
                title="Liens : tracer un lien, ou choisir un lien existant pour le modifier"
              />
              <Cmd
                icon={<Link2 size={17} />}
                onClick={C("linksFromUrls")}
                title="Créer des liens à partir des adresses web du texte"
              />
            </Group>
            <Group title="Marques" optional>
              <Cmd icon={<Droplet size={17} />} onClick={C("watermark")} label="Filigrane" />
              <Cmd icon={<PanelTop size={17} />} onClick={C("headerFooter")} label="En-tête / pied" />
              <Cmd icon={<Hash size={17} />} onClick={C("bates")} label="Numérotation" />
            </Group>
            <Group title="Signets">
              <Cmd
                icon={<FileText size={17} />}
                onClick={C("bookmarkAdd")}
                label="Ajouter"
                title="Signet sur la page courante"
              />
              <Cmd
                icon={<LayoutGrid size={17} />}
                onClick={C("bookmarksFromHeadings")}
                label="Auto"
                title="Créer des signets depuis les titres"
              />
            </Group>
          </>
        )}

        {p.tab === "organise" && (
          <>
            <Group title="Pages">
              <Cmd
                big
                icon={<Grid2x2 size={19} />}
                label="Organiser"
                onClick={C("organise")}
                title="Vue d'organisation des pages"
              />
              <Cmd icon={<RotateCcw size={17} />} onClick={C("rotateLeft")} title="Pivoter à gauche" />
              <Cmd icon={<RotateCw size={17} />} onClick={C("rotateRight")} title="Pivoter à droite" />
              <Cmd
                icon={<RefreshCcw size={17} />}
                onClick={C("rotateDialog")}
                title="Faire pivoter… (180°, paires, impaires, plage)"
              />
              <Cmd icon={<MoveHorizontal size={17} />} onClick={C("movePages")} title="Déplacer vers la page…" />
              <Cmd icon={<Copy size={17} />} onClick={C("duplicatePage")} title="Dupliquer" />
              <Cmd icon={<Trash2 size={17} />} onClick={C("deletePage")} danger title="Supprimer" />
            </Group>
            <Group title="Insérer">
              <Cmd icon={<FilePlus2 size={17} />} onClick={C("insertBlank")} label="Page blanche" />
              <Cmd icon={<FileText size={17} />} onClick={C("insertFile")} label="Depuis un PDF" />
              <Cmd icon={<FileImage size={17} />} onClick={C("insertImage")} label="Depuis une image" />
              <Cmd
                icon={<ClipboardPaste size={17} />}
                onClick={C("insertClipboard")}
                label="Presse-papiers"
                title="Insérer le contenu du presse-papiers (image, texte) comme page(s)"
              />
              <Cmd
                icon={<Replace size={17} />}
                onClick={C("replacePages")}
                label="Remplacer"
                title="Remplacer des pages par celles d'un autre PDF"
              />
            </Group>
            <Group title="Géométrie" optional>
              <Cmd icon={<Crop size={17} />} onClick={C("crop")} label="Recadrer" />
              <Cmd icon={<Move size={17} />} onClick={C("resize")} label="Redimensionner" />
              <Cmd icon={<ArrowRight size={17} />} onClick={C("reverse")} label="Inverser l'ordre" />
              <Cmd icon={<Hash size={17} />} onClick={C("pageLabels")} label="Étiquettes" />
            </Group>
            <Group title="Extraction" optional>
              <Cmd icon={<Scissors size={17} />} onClick={C("extract")} label="Extraire" />
              <Cmd
                icon={<Combine size={17} />}
                onClick={C("merge")}
                label="Combiner"
                title="Combiner des fichiers (PDF et images) en un nouveau document"
              />
              <Cmd icon={<FileOutput size={17} />} onClick={C("split")} label="Diviser" />
            </Group>
          </>
        )}

        {p.tab === "forms" && (
          <>
            <Group title="Remplir">
              <Cmd
                big
                icon={<PenSquare size={19} />}
                label="Remplir"
                onClick={C("formMode")}
                disabled={!p.hasForm}
                title={p.hasForm ? "Remplir les champs" : "Ce document n'a pas de formulaire"}
              />
              <Cmd icon={<Ban size={17} />} onClick={C("formReset")} label="Réinitialiser" disabled={!p.hasForm} />
              <Cmd icon={<Lock size={17} />} onClick={C("formFlatten")} label="Aplatir" disabled={!p.hasForm} />
            </Group>
            <Group title="Remplir et signer">
              <Cmd
                icon={<Type size={17} />}
                onClick={T("typewriter")}
                active={p.tool === "typewriter"}
                label="Ajouter du texte"
                title="Taper du texte n'importe où sur la page"
              />
              <Cmd icon={<Check size={17} />} onClick={C("fsCheck")} label="Coche" title="Ajouter une coche" />
              <Cmd icon={<X size={17} />} onClick={C("fsCross")} label="Croix" title="Ajouter une croix" />
              <Cmd icon={<Dot size={17} />} onClick={C("fsDot")} label="Point" title="Ajouter un point" />
              <Cmd
                icon={<CalendarDays size={17} />}
                onClick={C("fsDate")}
                label="Date"
                title="Ajouter la date du jour"
              />
              <Cmd
                big
                icon={<PenTool size={19} />}
                label="Signer"
                onClick={C("signature")}
                title="Ajouter votre signature manuscrite"
              />
              <Cmd
                icon={<PenLine size={17} />}
                onClick={C("initials")}
                label="Initiales"
                title="Ajouter vos initiales"
              />
            </Group>
            <Group title="Créer des champs">
              <Cmd
                big
                icon={<LayoutGrid size={19} />}
                label="Préparer"
                onClick={C("formPrepare")}
                active={!!p.preparing}
                title="Préparer un formulaire : créer, déplacer, redimensionner et configurer les champs"
              />
              <Cmd icon={<Type size={17} />} onClick={T("field:text")} active={p.tool === "field:text"} label="Texte" />
              <Cmd
                icon={<BoxSelect size={17} />}
                onClick={T("field:checkbox")}
                active={p.tool === "field:checkbox"}
                label="Case"
              />
              <Cmd
                icon={<Circle size={17} />}
                onClick={T("field:radio")}
                active={p.tool === "field:radio"}
                label="Radio"
              />
              <Cmd
                icon={<Table size={17} />}
                onClick={T("field:dropdown")}
                active={p.tool === "field:dropdown"}
                label="Liste"
              />
              <Cmd
                icon={<FileSignature size={17} />}
                onClick={T("field:signature")}
                active={p.tool === "field:signature"}
                label="Signature"
              />
              <Cmd
                icon={<Scan size={17} />}
                onClick={C("detectFields")}
                label="Détecter"
                title="Détecter automatiquement les champs"
              />
            </Group>
            <Group title="Données" optional>
              <Cmd
                icon={<FileDown size={17} />}
                onClick={C("exportFormData")}
                label="FDF"
                title="Exporter les données du formulaire (FDF, lisible par Acrobat)"
              />
              <Cmd
                icon={<FileDown size={17} />}
                onClick={C("exportFormXfdf")}
                label="XFDF"
                title="Exporter les données du formulaire (XFDF, XML)"
              />
              <Cmd
                icon={<FileOutput size={17} />}
                onClick={C("importFormData")}
                label="Importer"
                title="Importer des données (FDF, XFDF, texte tabulé)"
              />
              <Cmd
                icon={<FileSpreadsheet size={17} />}
                onClick={C("exportFormCsv")}
                label="CSV"
                title="Exporter les données pour un tableur (CSV)"
              />
              <Cmd
                icon={<FileSpreadsheet size={17} />}
                onClick={C("exportFormText")}
                label="Texte"
                title="Exporter les données en texte tabulé (format d'Acrobat, réimportable)"
              />
            </Group>
          </>
        )}

        {p.tab === "protect" && (
          <>
            <Group title="Chiffrement">
              <Cmd
                big
                icon={<Lock size={19} />}
                label="Protéger"
                onClick={C("protect")}
                title="Mot de passe et autorisations"
              />
              <Cmd icon={<Unlock size={17} />} onClick={C("unprotect")} label="Retirer" />
              <Cmd
                icon={<FileCode size={17} />}
                onClick={C("toggleScripts")}
                active={p.scriptsOn !== false}
                label="JavaScript"
                title="Exécuter le JavaScript des documents (calculs et contrôles des formulaires). Désactivé : les champs se remplissent sans leurs scripts."
              />
            </Group>
            <Group title="Signature électronique">
              <Cmd
                big
                icon={<PenSquare size={19} />}
                label="Signer"
                onClick={C("signPades")}
                title="Signer numériquement avec un certificat (PAdES) : votre identifiant Elium ou un fichier .p12/.pfx. Les signatures déjà présentes restent valides."
              />
              <Cmd
                icon={<FileSignature size={17} />}
                label="Certifier"
                onClick={C("certify")}
                title="Certifier le document (première signature) et choisir les modifications encore autorisées"
              />
              <Cmd
                icon={<ShieldCheck size={17} />}
                onClick={C("verifyPades")}
                label="Signatures"
                title="Panneau Signatures : vérifier les signatures du document"
              />
              <Cmd
                icon={<KeyRound size={17} />}
                onClick={C("identities")}
                label="Identités"
                title="Vos identifiants numériques et les certificats approuvés"
              />
            </Group>
            <Group title="Caviardage" optional>
              <Cmd
                big
                icon={<BoxSelect size={19} />}
                label="Marquer"
                onClick={T("redact")}
                active={p.tool === "redact"}
                title="Marquer une zone à caviarder"
              />
              <Cmd
                icon={<FileSearch size={17} />}
                onClick={C("redactSearch")}
                label="Rechercher"
                title="Marquer toutes les occurrences d'un texte"
              />
              <Cmd
                icon={<Shield size={17} />}
                onClick={C("redactApply")}
                label="Appliquer"
                danger
                title="Supprimer définitivement le contenu marqué"
              />
            </Group>
            <Group title="Nettoyage" optional>
              <Cmd
                icon={<Eraser size={17} />}
                onClick={C("sanitise")}
                label="Assainir"
                title="Supprimer métadonnées, scripts et pièces jointes"
              />
              <Cmd
                icon={<FileSearch size={17} />}
                onClick={C("inspect")}
                label="Inspecter"
                title="Voir ce que le document contient de caché"
              />
            </Group>
          </>
        )}

        {p.tab === "convert" && (
          <>
            <Group title="Exporter vers">
              <Cmd big icon={<FileType2 size={19} />} label="Word" onClick={C("exportDocx")} />
              <Cmd big icon={<FileImage size={19} />} label="Images" onClick={C("exportImages")} />
              <Cmd big icon={<FileText size={19} />} label="Texte" onClick={C("exportText")} />
              <Cmd
                icon={<FileSpreadsheet size={17} />}
                onClick={C("exportTables")}
                label="Tableaux"
                title="Détecter les tableaux et exporter en CSV"
              />
              <Cmd icon={<FileOutput size={17} />} onClick={C("exportHtml")} label="HTML" />
            </Group>
            <Group title="Reconnaissance" optional>
              <Cmd
                big
                icon={<ScanText size={19} />}
                label="OCR"
                onClick={C("ocr")}
                title="Rendre un document scanné cherchable"
              />
            </Group>
            <Group title="Comparer et alléger" optional>
              <Cmd icon={<GitCompareArrows size={17} />} onClick={C("compare")} label="Comparer" />
              <Cmd icon={<FileDown size={17} />} onClick={C("optimise")} label="Optimiser" />
              <Cmd
                icon={<PieChart size={17} />}
                onClick={C("spaceAudit")}
                label="Espace utilisé"
                title="Audit de l'espace utilisé : ce qui pèse dans le fichier"
              />
            </Group>
          </>
        )}

        {p.tab === "view" && (
          <>
            <Group title="Zoom">
              <Cmd icon={<ZoomOut size={17} />} onClick={C("zoomOut")} title="Dézoomer (Ctrl+-)" />
              <Cmd icon={<ZoomIn size={17} />} onClick={C("zoomIn")} title="Zoomer (Ctrl++)" />
              <Cmd icon={<Focus size={17} />} onClick={C("fitPage")} label="Page entière" />
              <Cmd icon={<Move size={17} />} onClick={C("fitWidth")} label="Largeur" />
            </Group>
            <Group title="Disposition">
              <Cmd icon={<FileText size={17} />} onClick={C("viewSingle")} label="Une page" />
              <Cmd icon={<LayoutGrid size={17} />} onClick={C("viewContinuous")} label="Continu" />
              <Cmd icon={<Grid2x2 size={17} />} onClick={C("viewFacing")} label="Double page" />
              <Cmd icon={<RotateCw size={17} />} onClick={C("rotateView")} label="Pivoter la vue" />
            </Group>
            <Group title="Confort" optional>
              <Cmd
                icon={<Sun size={17} />}
                onClick={C("theme")}
                label="Thème"
                title="Papier, sépia, nuit, contraste inversé"
              />
              <Cmd icon={<Contrast size={17} />} onClick={C("fullscreen")} label="Plein écran" title="F11" />
              <Cmd icon={<Layers size={17} />} onClick={C("panelLayers")} label="Calques" />
              <Cmd icon={<Volume2 size={17} />} onClick={C("readAloud")} label="Lire à voix haute" />
            </Group>
            <Group title="Mesures" optional>
              <Cmd icon={<Ruler size={17} />} onClick={T("distance")} active={p.tool === "distance"} label="Distance" />
              <Cmd
                icon={<Spline size={17} />}
                onClick={T("perimeter")}
                active={p.tool === "perimeter"}
                label="Périmètre"
              />
              <Cmd icon={<Pentagon size={17} />} onClick={T("area")} active={p.tool === "area"} label="Surface" />
              <Cmd icon={<Ruler size={17} />} onClick={C("measureScale")} label="Échelle" />
            </Group>
          </>
        )}
      </div>

      {(markupTool || shapeTool || textTool || p.tool === "redact") && (
        <div className="pdfx-optionbar">
          <span className="pdfx-optionbar__title">
            <PenTool size={13} /> Options de l'outil
          </span>

          <Swatches
            colours={markupTool ? HIGHLIGHT_SWATCHES : INK_SWATCHES}
            value={p.style.color}
            onPick={(c) => p.onStyle({ color: c })}
          />
          <label className="pdfx-colorbtn" title="Couleur personnalisée">
            <input type="color" value={p.style.color} onChange={(e) => p.onStyle({ color: e.target.value })} />
          </label>

          {(shapeTool || p.tool === "square" || p.tool === "circle") && (
            <label className="pdfx-field" title="Remplissage">
              <PaintBucket size={13} />
              <input
                type="color"
                value={p.style.fill ?? "#ffffff"}
                onChange={(e) => p.onStyle({ fill: e.target.value })}
              />
              <button className="pdfx-mini" onClick={() => p.onStyle({ fill: null })} title="Sans remplissage">
                <Ban size={12} />
              </button>
            </label>
          )}

          {(shapeTool || markupTool) && (
            <label className="pdfx-field" title="Épaisseur du trait">
              <Minus size={13} />
              <input
                type="range"
                min={0.5}
                max={16}
                step={0.5}
                value={p.style.strokeWidth}
                onChange={(e) => p.onStyle({ strokeWidth: Number(e.target.value) })}
              />
              <span className="pdfx-field__value">{p.style.strokeWidth}</span>
            </label>
          )}

          <label className="pdfx-field" title="Opacité">
            <Contrast size={13} />
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={p.style.opacity}
              onChange={(e) => p.onStyle({ opacity: Number(e.target.value) })}
            />
            <span className="pdfx-field__value">{Math.round(p.style.opacity * 100)}%</span>
          </label>

          {shapeTool && p.tool !== "ink" && (
            <select
              className="pdfx-select"
              value={p.style.borderStyle}
              onChange={(e) => p.onStyle({ borderStyle: e.target.value as DraftStyle["borderStyle"] })}
              title="Style de bordure"
            >
              <option value="solid">Continu</option>
              <option value="dashed">Tirets</option>
              <option value="cloudy">Nuage</option>
            </select>
          )}

          {(p.tool === "line" || p.tool === "arrow" || p.tool === "polyline") && (
            <>
              <select
                className="pdfx-select"
                value={p.style.lineStart}
                onChange={(e) => p.onStyle({ lineStart: e.target.value as DraftStyle["lineStart"] })}
                title="Début de ligne"
              >
                <option value="none">—</option>
                <option value="arrow">Flèche</option>
                <option value="circle">Rond</option>
                <option value="square">Carré</option>
                <option value="diamond">Losange</option>
              </select>
              <select
                className="pdfx-select"
                value={p.style.lineEnd}
                onChange={(e) => p.onStyle({ lineEnd: e.target.value as DraftStyle["lineEnd"] })}
                title="Fin de ligne"
              >
                <option value="none">—</option>
                <option value="arrow">Flèche</option>
                <option value="circle">Rond</option>
                <option value="square">Carré</option>
                <option value="diamond">Losange</option>
              </select>
            </>
          )}

          {textTool && (
            <>
              <select
                ref={fontRef}
                className="pdfx-select pdfx-select--font"
                value={p.style.fontFamily}
                onChange={(e) => p.onStyle({ fontFamily: e.target.value })}
                title="Police"
              >
                {allFontNames().map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <select
                className="pdfx-select pdfx-select--size"
                value={p.style.fontSize}
                onChange={(e) => p.onStyle({ fontSize: Number(e.target.value) })}
                title="Taille"
              >
                {[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Cmd
                icon={<Bold size={15} />}
                onClick={() => p.onStyle({ bold: !p.style.bold })}
                active={p.style.bold}
                title="Gras"
              />
              <Cmd
                icon={<Italic size={15} />}
                onClick={() => p.onStyle({ italic: !p.style.italic })}
                active={p.style.italic}
                title="Italique"
              />
              <Cmd
                icon={<Underline size={15} />}
                onClick={() => p.onStyle({ underline: !p.style.underline })}
                active={p.style.underline}
                title="Souligné"
              />
              <select
                className="pdfx-select"
                value={p.style.align}
                onChange={(e) => p.onStyle({ align: e.target.value as DraftStyle["align"] })}
                title="Alignement"
              >
                <option value="left">Gauche</option>
                <option value="center">Centre</option>
                <option value="right">Droite</option>
              </select>
            </>
          )}

          <label className="pdfx-check" title="Garder l'outil actif après chaque usage">
            <input type="checkbox" checked={p.stickyTool} onChange={(e) => p.onStickyTool(e.target.checked)} />
            Outil persistant
          </label>
        </div>
      )}
    </div>
  );
}
