/**
 * CollabDeckStore — the Drive collaborative backend for the unified Présentations
 * editor. Backs the DeckStore contract with an end-to-end-encrypted Y.Doc (deck
 * Y.Map → slides Y.Array → per-element `elements` Y.Array) and live presence.
 * Multi-user, so `active` is per-user local state (each collaborator views their
 * own slide) and there is no undo history. Renders through the SAME <SlidesEditor>
 * as the local suite, so features stay in lockstep across both surfaces.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "./collab-provider";
import type { DriveApi } from "./api";
import {
  blankSlide, emptySlide, newSlideId, newElementId,
  type Deck, type Slide, type SlideElement, type SlideTheme, type SlideTransition,
} from "../slides/model";
import { slideToY, yToSlide, ensureElementsY, elToY } from "./collab-slides-crdt";
import type { DeckStore, DeckStatus, DeckPeer } from "../slides/store";

type YMap = Y.Map<unknown>;

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
export const colorForId = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]!; };
export const initialsOf = (s: string) => { const p = s.split(/[@\s.]+/).filter(Boolean); return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?"; };

const STATUS_MAP: Record<CollabStatus, DeckStatus> = { connecting: "connecting", open: "open", closed: "closed" };

export interface CollabDeckStoreOpts {
  api: DriveApi;
  nodeId: string;
  nodeKey: Uint8Array;
  user: { id: string; name: string };
  refetchKey?: () => Promise<Uint8Array | null>;
}

export function useCollabDeckStore({ api, nodeId, nodeKey, user, refetchKey }: CollabDeckStoreOpts): DeckStore {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [theme, setTheme] = useState<SlideTheme>("light");
  const [transition, setTransition] = useState<SlideTransition>("fade");
  const [active, setActiveState] = useState(0);
  const [peers, setPeers] = useState<DeckPeer[]>([]);

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorForId(user.id) }), [user.id, user.name]);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }));
  const deckMap = useMemo(() => ydoc.getMap("deck"), [ydoc]);

  const ySlides = (): Y.Array<YMap> => deckMap.get("slides") as Y.Array<YMap>;
  const slideAt = (i: number): YMap | undefined => ySlides()?.get(i);

  const refresh = () => {
    const arr = deckMap.get("slides") as Y.Array<YMap> | undefined;
    setSlides(arr ? arr.toArray().map(yToSlide) : []);
    setTheme((deckMap.get("theme") as SlideTheme) ?? "light");
    setTransition((deckMap.get("transition") as SlideTransition) ?? "fade");
  };

  useEffect(() => {
    let alive = true;
    const obs = () => { if (alive) refresh(); };
    deckMap.observeDeep(obs);
    provider.connect().then(() => {
      if (!alive) return;
      if (!deckMap.get("slides")) {
        ydoc.transact(() => {
          deckMap.set("theme", "light");
          deckMap.set("transition", "fade");
          const arr = new Y.Array<YMap>();
          arr.push([slideToY({ id: newSlideId(), title: "Titre de la présentation", body: "", bodyHtml: "<p>Sous-titre</p>", layout: "title" })]);
          deckMap.set("slides", arr);
        });
      }
      refresh();
    });
    return () => { alive = false; deckMap.unobserveDeep(obs); provider.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, deckMap, ydoc]);

  // presence: publish which slide we're viewing; read peers.
  useEffect(() => { provider.awareness.setLocalStateField("slide", active); }, [provider, active]);
  useEffect(() => {
    const upd = () => {
      const self = provider.awareness.clientID;
      const list: DeckPeer[] = [];
      provider.awareness.getStates().forEach((st, id) => {
        if (id === self) return;
        const u = (st as { user?: CollabUser }).user;
        const sl = (st as { slide?: number }).slide;
        if (u && typeof sl === "number") list.push({ color: u.color, name: u.name, slide: sl });
      });
      setPeers(list);
    };
    provider.awareness.on("change", upd); upd();
    return () => provider.awareness.off("change", upd);
  }, [provider]);

  // clamp active if slides shrink
  const activeRef = useRef(active); activeRef.current = active;
  useEffect(() => { if (active > slides.length - 1) setActiveState(Math.max(0, slides.length - 1)); }, [slides.length, active]);

  // --- element ops on the active slide's `elements` Y.Array ---
  const withActiveEls = (fn: (arr: Y.Array<YMap>) => void) => {
    if (!canWrite) return;
    const m = slideAt(activeRef.current); if (!m) return;
    ydoc.transact(() => fn(ensureElementsY(m)));
  };
  const updateEl = (id: string, patch: Partial<SlideElement>) => withActiveEls((arr) => {
    for (const em of arr.toArray()) if (em.get("id") === id) { for (const [k, v] of Object.entries(patch)) if (v !== undefined) em.set(k, v as unknown); break; }
  });
  const addEl = (el: SlideElement) => withActiveEls((arr) => arr.push([elToY(el)]));
  const removeEl = (id: string) => withActiveEls((arr) => {
    const idx = arr.toArray().findIndex((em) => em.get("id") === id);
    if (idx >= 0) arr.delete(idx, 1);
  });
  const reorderEl = (id: string, dir: "front" | "back") => withActiveEls((arr) => {
    const items = arr.toArray();
    const idx = items.findIndex((em) => em.get("id") === id);
    if (idx < 0) return;
    const snap = items[idx]!.toJSON() as SlideElement;
    arr.delete(idx, 1);
    arr.insert(dir === "front" ? arr.length : 0, [elToY(snap)]);
  });

  // --- slide + deck ops ---
  const setActive = (i: number) => setActiveState(i);
  const setDeckField = (patch: Partial<Deck>) => {
    if (!canWrite) return;
    ydoc.transact(() => { if (patch.theme !== undefined) deckMap.set("theme", patch.theme); if (patch.transition !== undefined) deckMap.set("transition", patch.transition); });
  };
  const replaceDeck = (d: Deck) => {
    if (!canWrite) return;
    ydoc.transact(() => {
      const arr = ySlides();
      if (arr) arr.delete(0, arr.length);
      const target = arr ?? (() => { const a = new Y.Array<YMap>(); deckMap.set("slides", a); return a; })();
      target.push((d.slides.length ? d.slides : [{ id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank" as const, elements: [] }]).map(slideToY));
      deckMap.set("theme", d.theme ?? "light");
      deckMap.set("transition", d.transition ?? "fade");
    });
    setActiveState(0);
  };
  const patchSlide = (patch: Partial<Slide>) => {
    if (!canWrite) return;
    const m = slideAt(activeRef.current); if (!m) return;
    ydoc.transact(() => { for (const [k, v] of Object.entries(patch)) { if (k === "elements" || k === "shapes") continue; m.set(k, v as unknown); } });
  };
  const addSlide = (blank = false) => {
    if (!canWrite) return;
    ydoc.transact(() => ySlides().insert(activeRef.current + 1, [slideToY(blank ? blankSlide() : emptySlide("title-content"))]));
    setActiveState((a) => a + 1);
  };
  const insertSlide = (slide: Slide) => {
    if (!canWrite) return;
    ydoc.transact(() => ySlides().insert(activeRef.current + 1, [slideToY(slide)]));
    setActiveState((a) => a + 1);
  };
  const removeSlide = (i: number) => {
    if (!canWrite) return;
    const arr = ySlides(); if (arr.length <= 1) return;
    ydoc.transact(() => arr.delete(i, 1));
    setActiveState((a) => Math.max(0, Math.min(a, arr.length - 2)));
  };
  const moveSlide = (i: number, dir: -1 | 1) => {
    if (!canWrite) return;
    const j = i + dir; const arr = ySlides();
    if (j < 0 || j >= arr.length) return;
    const s = yToSlide(arr.get(i));
    ydoc.transact(() => { arr.delete(i, 1); arr.insert(j, [slideToY(s)]); });
    setActiveState(j);
  };
  const duplicateSlide = (i: number) => {
    if (!canWrite) return;
    const s = yToSlide(ySlides().get(i));
    const dup: Slide = { ...s, id: newSlideId(), elements: (s.elements ?? []).map((e) => ({ ...e, id: newElementId(), morphKey: e.morphKey ?? e.id })) };
    ydoc.transact(() => ySlides().insert(i + 1, [slideToY(dup)]));
    setActiveState(i + 1);
  };

  const deck: Deck = { slides, active, theme, transition };

  return {
    deck, active, canWrite, collaborative: true,
    setActive, setDeckField, replaceDeck,
    addSlide, insertSlide, removeSlide, moveSlide, duplicateSlide, patchSlide,
    updateEl, addEl, removeEl, reorderEl,
    beginChange: () => {},
    presence: { me: { name: me.name, color: me.color }, peers },
    status: STATUS_MAP[status],
  };
}
