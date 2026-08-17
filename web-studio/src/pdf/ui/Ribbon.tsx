import { useRef } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Baseline,
  Bold,
  BoxSelect,
  Circle,
  Cloud,
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
  Highlighter,
  Image as ImageIcon,
  Italic,
  Layers,
  LayoutGrid,
  Lock,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  Move,
  PaintBucket,
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
  Unlock,
  Volume2,
  Waves,
  ZoomIn,
  ZoomOut,
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
  busy: boolean;
  stickyTool: boolean;
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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pdfx-group">
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
                title="Exporter le PDF (Ctrl+S)"
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
              <Cmd icon={<Combine size={17} />} onClick={C("merge")} label="Fusionner" />
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
                icon={<Type size={17} />}
                onClick={T("freetext")}
                active={p.tool === "freetext"}
                title="Zone de texte"
              />
              <Cmd icon={<Spline size={17} />} onClick={T("callout")} active={p.tool === "callout"} title="Légende" />
              <Cmd icon={<Stamp size={17} />} onClick={C("stamp")} active={p.tool === "stamp"} title="Tampon" />
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
            <Group title="Révision">
              <Cmd
                icon={<FileDown size={17} />}
                onClick={C("exportComments")}
                label="Exporter"
                title="Exporter les commentaires (XFDF)"
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
                title="Récapitulatif des commentaires"
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
              <Cmd big icon={<ImageIcon size={19} />} label="Image" onClick={T("image")} active={p.tool === "image"} />
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
                title="Créer un lien"
              />
            </Group>
            <Group title="Marques">
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
              <Cmd icon={<Copy size={17} />} onClick={C("duplicatePage")} title="Dupliquer" />
              <Cmd icon={<Trash2 size={17} />} onClick={C("deletePage")} danger title="Supprimer" />
            </Group>
            <Group title="Insérer">
              <Cmd icon={<FilePlus2 size={17} />} onClick={C("insertBlank")} label="Page blanche" />
              <Cmd icon={<FileText size={17} />} onClick={C("insertFile")} label="Depuis un PDF" />
              <Cmd icon={<FileImage size={17} />} onClick={C("insertImage")} label="Depuis une image" />
            </Group>
            <Group title="Géométrie">
              <Cmd icon={<Crop size={17} />} onClick={C("crop")} label="Recadrer" />
              <Cmd icon={<Move size={17} />} onClick={C("resize")} label="Redimensionner" />
              <Cmd icon={<ArrowRight size={17} />} onClick={C("reverse")} label="Inverser l'ordre" />
              <Cmd icon={<Hash size={17} />} onClick={C("pageLabels")} label="Étiquettes" />
            </Group>
            <Group title="Extraction">
              <Cmd icon={<Scissors size={17} />} onClick={C("extract")} label="Extraire" />
              <Cmd icon={<Combine size={17} />} onClick={C("merge")} label="Fusionner" />
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
            <Group title="Créer des champs">
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
            <Group title="Données">
              <Cmd icon={<FileDown size={17} />} onClick={C("exportFormData")} label="Exporter" />
              <Cmd icon={<FileOutput size={17} />} onClick={C("importFormData")} label="Importer" />
              <Cmd icon={<FileSpreadsheet size={17} />} onClick={C("exportFormCsv")} label="CSV" />
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
            </Group>
            <Group title="Signature électronique">
              <Cmd
                big
                icon={<PenSquare size={19} />}
                label="Signer (auto-signé)"
                onClick={C("signSelfSigned")}
                title="Signer la signature placée en PAdES avec un certificat auto-signé (reconnu par Adobe ; identité non vérifiée)"
              />
              <Cmd
                icon={<FileSignature size={17} />}
                label="Signer (certificat)"
                onClick={C("signPades")}
                title="Signature électronique PAdES avec votre certificat X.509 / PKCS#12 (coche verte « approuvé »)"
              />
              <Cmd
                icon={<ShieldCheck size={17} />}
                onClick={C("verifyPades")}
                label="Vérifier"
                title="Vérifier les signatures électroniques du document"
              />
            </Group>
            <Group title="Caviardage">
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
            <Group title="Nettoyage">
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
            <Group title="Reconnaissance">
              <Cmd
                big
                icon={<ScanText size={19} />}
                label="OCR"
                onClick={C("ocr")}
                title="Rendre un document scanné cherchable"
              />
            </Group>
            <Group title="Comparer et alléger">
              <Cmd icon={<GitCompareArrows size={17} />} onClick={C("compare")} label="Comparer" />
              <Cmd icon={<FileDown size={17} />} onClick={C("optimise")} label="Optimiser" />
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
            <Group title="Confort">
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
            <Group title="Mesures">
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
