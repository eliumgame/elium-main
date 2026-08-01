/**
 * Éditeur de document collaboratif — une coquille fine autour du VRAI éditeur
 * Documents (`RichEditor`), comme `CollabSlidesEditor` l'est autour de
 * `SlidesEditor`.
 *
 * L'ancien éditeur compact (barre plate réduite) est supprimé : le Drive donne
 * désormais exactement le même éditeur que la suite locale — ruban à sept
 * onglets, styles, colonnes, notes, renvois, index, formes, quadrillage,
 * correcteur embarqué, pagination et zoom. C'est la règle de parité
 * dual-plateforme : une fonction s'écrit une fois et marche des deux côtés.
 *
 * Ce composant n'ajoute que ce qui est propre au cloud : le branchement du Y.Doc
 * chiffré (Collaboration + curseurs colorés), l'état de connexion, les pastilles
 * de présence, et les réglages de page/quadrillage/filigrane tenus en mémoire
 * locale (un document collaboratif n'a pas de modèle de page côté serveur, il
 * pagine sur un A4 standard — parité avec la surface locale).
 */
import { useMemo, useState } from "react";
import { X, Wifi, WifiOff, Loader } from "lucide-react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { useEffect } from "react";
import RichEditor from "../../editor/RichEditor";
import { DEFAULT_PAGE } from "../../format/document";
import { ELIUM_DOC_SCHEMA, type EliumDocStyle, type EliumDocumentModel, type EliumWatermark, type PageSettings } from "../../format/types";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "../collab-provider";
import type { DriveApi } from "../api";

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
function initials(s: string): string {
  const p = s.split(/[@\s.]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function CollabDocEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi;
  nodeId: string;
  nodeKey: Uint8Array;
  title: string;
  user: { id: string; name: string };
  onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorFor(user.id) }), [user.id, user.name]);

  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(
    () => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }),
  );

  // Les extensions de collaboration sont construites ICI (Yjs importé côté Drive
  // uniquement, jamais dans le bundle de l'éditeur local) et passées au VRAI
  // éditeur, qui se charge de tout le reste.
  const collabExtensions = useMemo(
    () => [
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider: provider as unknown as { awareness: unknown } }),
    ],
    [ydoc, provider],
  );

  // Réglages de page/styles/filigrane/quadrillage : un document collaboratif n'a
  // pas de modèle persisté côté serveur, donc ils vivent en mémoire locale, sur
  // un A4 standard (mêmes valeurs par défaut que l'éditeur local).
  const [page, setPage] = useState<PageSettings>(() => ({ ...DEFAULT_PAGE }));
  const [styles, setStyles] = useState<EliumDocStyle[]>([]);
  const [watermark, setWatermark] = useState<EliumWatermark | undefined>(undefined);

  // Le contenu appartient au Y.Doc : le modèle ne porte qu'un document vide (le
  // vrai éditeur ignore ce contenu en mode collaboratif) et les réglages de page.
  const documentModel: EliumDocumentModel = useMemo(
    () => ({
      schema: ELIUM_DOC_SCHEMA,
      page,
      styles,
      ...(watermark ? { watermark } : {}),
      doc: { type: "doc", content: [{ type: "paragraph" }] },
    }),
    [page, styles, watermark],
  );

  useEffect(() => {
    void provider.connect();
    return () => provider.destroy();
  }, [provider]);

  useEffect(() => {
    const refresh = () => {
      const self = provider.awareness.clientID;
      const list: CollabUser[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === self) return;
        const u = (state as { user?: CollabUser }).user;
        if (u && u.name) list.push(u);
      });
      setPeers(list);
    };
    provider.awareness.on("change", refresh);
    refresh();
    return () => provider.awareness.off("change", refresh);
  }, [provider]);

  // Accès révoqué : le document se ferme en écriture pour de bon, même si le
  // dernier `canWrite` connu (d'avant la révocation) valait vrai.
  const writable = canWrite && status !== "revoked";

  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-doc dc-doc--full">
        <header className="dc-doc__head">
          <span className="dc-doc__title" title={title}>{title}</span>
          <span className={`dc-doc__status dc-doc__status--${status}`}>
            {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
          </span>
          <div className="dc-doc__peers">
            <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initials(me.name)}</span>
            {peers.map((p, i) => (
              <span key={i} className="dc-doc-av" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>
            ))}
          </div>
          <div className="dc-doc__spacer" />
          {!canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>

        {/* Le VRAI éditeur, en mode collaboratif. Signature/comparaison/
            publipostage sont masqués (propres au fichier local). */}
        <div className="dc-doc__editor">
          <RichEditor
            documentModel={documentModel}
            editable={writable}
            collab={{ extensions: collabExtensions }}
            commentAuthor={me.name}
            docTitle={title}
            signatures={[]}
            selectedSignatureId={null}
            onDocChange={() => {}}
            onAddSignatureRequest={() => {}}
            onUpdateSignature={() => {}}
            onSelectSignature={() => {}}
            onRemoveSignature={() => {}}
            numberedHeadings={page.numberedHeadings ?? false}
            onToggleNumberedHeadings={() => setPage((p) => ({ ...p, numberedHeadings: !(p.numberedHeadings ?? false) }))}
            onStylesChange={setStyles}
            onWatermarkChange={(m) => setWatermark(m)}
            onGridChange={(grid) => setPage((p) => ({ ...p, grid }))}
          />
        </div>
      </div>
    </div>
  );
}
