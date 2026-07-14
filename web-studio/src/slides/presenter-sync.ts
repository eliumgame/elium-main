/**
 * Presenter ↔ audience sync contract. The main editor window is the source of
 * truth: it broadcasts the deck + current position over a BroadcastChannel; the
 * speaker's presenter window (opened at ?presenter=1) renders from those messages
 * and posts back navigation intents. This works identically for the local suite
 * and the Drive collaborative editor because all data flows from the already-open
 * main window — the popup never needs the vault, the server, or the Y.Doc.
 */
import type { Slide, SlideTheme } from "./model";

export const PRESENTER_CHANNEL = "elium-presenter";

export interface PresenterDeckMsg { type: "deck"; slides: Slide[]; theme: SlideTheme; title: string }
export interface PresenterPosMsg { type: "pos"; idx: number; step: number; startedAt: number; presenting: boolean }
export interface PresenterNavMsg { type: "nav"; dir: "next" | "prev" }
export interface PresenterReadyMsg { type: "ready" }
export interface PresenterEndMsg { type: "end" }
export type PresenterMsg = PresenterDeckMsg | PresenterPosMsg | PresenterNavMsg | PresenterReadyMsg | PresenterEndMsg;
