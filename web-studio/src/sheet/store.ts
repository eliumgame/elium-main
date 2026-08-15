/**
 * SheetStore — le contrat de persistance derrière le Tableur unifié. Le composant
 * partagé <SheetEditor> rend toute la grille, la barre de mise en forme, la barre
 * de formule, les onglets de feuilles, les graphiques et les fenêtres de
 * configuration UNIQUEMENT à travers cette interface. Une fonctionnalité écrite
 * une fois s'allume donc sur LES DEUX surfaces :
 *   - suite locale → LocalSheetStore  (useUndoable + IndexedDB sheet-store)
 *   - Drive cloud  → CollabSheetStore (Y.Doc chiffré, présence en direct)
 *
 * Les données du classeur + les mutations vivent dans le store ; l'état d'IHM
 * propre à l'utilisateur (sélection, saisie en cours, menus/fenêtres ouverts,
 * poignée de recopie, redimensionnement de colonne) reste dans <SheetEditor>.
 * `active` fait partie du store car il vit à des endroits différents selon le
 * backend (dans le classeur en local vs. état React par utilisateur en collab).
 */
import type { ReactNode } from "react";
import type { Workbook, SheetData, CellStyle, ChartSpec, CondRule, DataValidation } from "./model";
import type { Rect } from "./structural";

export type SheetStatus = "connecting" | "open" | "closed" | "revoked";

/** La cellule survolée/éditée d'un collaborateur (backend collab uniquement). */
export interface SheetPeer {
  color: string;
  name: string;
  s: number; // index de feuille
  ref: string; // référence A1 de la cellule
}

export interface SheetPresence {
  me: { color: string; name: string };
  peers: SheetPeer[];
}

export interface SheetStore {
  /** Instantané courant du classeur (objets simples ; référence neuve à chaque changement). */
  wb: Workbook;
  /** Index de la feuille que l'utilisateur local consulte/édite. */
  active: number;
  /** L'utilisateur courant peut-il muter le classeur (lecteur collab en lecture seule = false). */
  canWrite: boolean;
  /** Vrai pour le backend collaboratif Drive (active la présence, etc.). */
  collaborative: boolean;

  setActive(i: number): void;
  addSheet(name?: string): void;
  renameSheet(i: number, name: string): void;
  removeSheet(i: number): void;
  /** Remplace tout le classeur (import XLSX/CSV). Optionnel : un lecteur seul ne peut pas. */
  replaceWorkbook?(wb: Workbook): void;
  /** Ajoute une feuille depuis une SheetData (résultat d'un TCD) ; rend son index. */
  addSheetFromData?(data: SheetData): number;

  // --- cellules & mise en forme (agissent sur la feuille `s`) ---
  setCell(s: number, ref: string, raw: string): void;
  clearRange(s: number, rect: Rect): void;
  applyStyle(s: number, refs: string[], patch: Partial<CellStyle>): void;
  pasteBlock(s: number, atR: number, atC: number, grid: string[][]): void;

  // --- structure : lignes / colonnes ---
  insertRow(s: number, at: number): void;
  deleteRow(s: number, at: number): void;
  insertCol(s: number, at: number): void;
  deleteCol(s: number, at: number): void;
  sortRange(s: number, key: number, region: Rect, dir: 1 | -1, displayOf: (c: number, r: number) => string): void;
  fillRange(s: number, src: Rect, to: { c: number; r: number }): void;
  /** Agrandit la feuille (boutons collab « + Lignes / + Colonnes »). Optionnel. */
  growSheet?(s: number, key: "rows" | "cols", by: number): void;

  // --- géométrie & vue ---
  setColWidth(s: number, col: number, w: number): void;
  setFreeze(s: number, rows: number, cols: number): void;
  setFilter(s: number, col: number, query: string): void;
  toggleMerge(s: number, rect: Rect): void;

  // --- mise en forme conditionnelle / validation / graphiques ---
  setCondRule(s: number, rule: CondRule): void;
  removeCondRule(s: number, id: string): void;
  setValidation(s: number, v: DataValidation): void;
  removeValidation(s: number, id: string): void;
  setChart(s: number, chart: ChartSpec): void;
  removeChart(s: number, id: string): void;

  // --- plages nommées (portée classeur) ---
  setName(name: string, ref: string): void;
  removeName(name: string): void;

  // --- annulation (optionnelle : le local a un vrai historique ; le collab un UndoManager) ---
  beginChange(): void; // point de reprise avant un geste (glissé)
  undo?(): void;
  redo?(): void;
  canUndo?: boolean;
  canRedo?: boolean;

  // --- collab uniquement ---
  /** Publie la cellule sélectionnée dans la présence (la sélection vit dans <SheetEditor>). */
  setPresence?(s: number, ref: string): void;
  presence?: SheetPresence;
  status?: SheetStatus;
}

/** Chrome injecté par la coque (page vs. modale, exports, statut/pairs). Miroir de SlidesEditorChrome. */
export interface SheetEditorChrome {
  title: string;
  titleIcon?: ReactNode;
  onHome?: () => void;
  onClose?: () => void;
  /** Boutons supplémentaires dans la barre supérieure (ex. export). */
  headerActions?: ReactNode;
  /** Nœud de statut de connexion / pairs (collab), placé après l'espaceur. */
  statusNode?: ReactNode;
  variant?: "page" | "modal";
}
