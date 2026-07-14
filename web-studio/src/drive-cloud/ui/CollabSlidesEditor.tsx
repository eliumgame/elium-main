/**
 * Collaborative presentation editor — a thin shell around the shared
 * <SlidesEditor>. It supplies the Drive backend (useCollabDeckStore: encrypted
 * Y.Doc on the free-canvas `elements` model + live presence) and the collab-only
 * chrome (connection status, peer avatars, read-only badge). The whole editing
 * surface is the shared component, so the cloud editor is byte-for-byte the same
 * experience as the local suite. End-to-end encrypted (opaque Yjs updates).
 */
import { Wifi, WifiOff, Loader, Presentation } from "lucide-react";
import type { DriveApi } from "../api";
import SlidesEditor from "../../slides/SlidesEditor";
import { useCollabDeckStore, initialsOf } from "../useCollabDeckStore";

export default function CollabSlidesEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi; nodeId: string; nodeKey: Uint8Array; title: string; user: { id: string; name: string }; onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const store = useCollabDeckStore({ api, nodeId, nodeKey, user, ...(refetchKey ? { refetchKey } : {}) });
  const status = store.status ?? "connecting";
  const { me, peers } = store.presence!;
  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";
  const uniquePeers = [...new Map(peers.map((p) => [p.name + p.color, p])).values()];

  const statusNode = (
    <>
      <span className={`dc-doc__status dc-doc__status--${status}`}>
        {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
      </span>
      <div className="dc-doc__peers">
        <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initialsOf(me.name)}</span>
        {uniquePeers.map((p, i) => (
          <span key={i} className="dc-doc-av" style={{ background: p.color }} title={`${p.name} · diapo ${p.slide + 1}`}>{initialsOf(p.name)}</span>
        ))}
      </div>
      {!store.canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
    </>
  );

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-doc dc-slides">
        <SlidesEditor store={store} chrome={{ title, titleIcon: <Presentation size={16} />, onClose, statusNode, variant: "modal" }} />
      </div>
    </div>
  );
}
