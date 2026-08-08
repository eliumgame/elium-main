/**
 * Tableur collaboratif — une coque fine autour du <SheetEditor> partagé. Elle
 * fournit le backend Drive (useCollabSheetStore : Y.Doc chiffré plein-modèle +
 * présence en direct) et le chrome propre au collab (statut de connexion, avatars
 * des pairs, badge lecture seule, export XLSX). Toute la surface d'édition est le
 * composant partagé, si bien que l'éditeur cloud est, au pixel près, la même
 * expérience que la suite locale. Chiffré de bout en bout (updates Yjs opaques).
 */
import { Wifi, WifiOff, Loader, Download, Table2 } from "lucide-react";
import type { DriveApi } from "../api";
import SheetEditor from "../../sheet/SheetEditor";
import { useCollabSheetStore, initialsOf } from "../useCollabSheetStore";
import { workbookToXlsx } from "../../sheet/xlsx-export";
import { downloadBlob } from "../../export/exporters";

export default function CollabSheetEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi; nodeId: string; nodeKey: Uint8Array; title: string; user: { id: string; name: string }; onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const store = useCollabSheetStore({ api, nodeId, nodeKey, user, ...(refetchKey ? { refetchKey } : {}) });
  const status = store.status ?? "connecting";
  const { me, peers } = store.presence!;
  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";
  const uniquePeers = [...new Map(peers.map((p) => [p.name + p.color, p])).values()];

  const exportXlsx = () => {
    if (!store.wb.sheets.length) return;
    const base = (title || "classeur").replace(/\.[^.]+$/, "");
    downloadBlob(`${base}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbookToXlsx(store.wb));
  };

  const statusNode = (
    <>
      <span className={`dc-doc__status dc-doc__status--${status}`}>
        {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
      </span>
      <div className="dc-doc__peers">
        <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initialsOf(me.name)}</span>
        {uniquePeers.map((p, i) => (
          <span key={i} className="dc-doc-av" style={{ background: p.color }} title={p.name}>{initialsOf(p.name)}</span>
        ))}
      </div>
      {!store.canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
    </>
  );

  const headerActions = (
    <button className="eb eb--sm eb--outline" onClick={exportXlsx} disabled={!store.wb.sheets.length} title="Exporter en XLSX">
      <Download size={14} /> XLSX
    </button>
  );

  return (
    <div className="dc-modal-overlay dc-modal-overlay--full">
      <div className="dc-doc dc-sheet dc-doc--fullscreen">
        <SheetEditor store={store} chrome={{ title, titleIcon: <Table2 size={16} />, onClose, statusNode, headerActions, variant: "modal" }} />
      </div>
    </div>
  );
}
