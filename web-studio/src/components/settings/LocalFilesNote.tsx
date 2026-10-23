import { t } from "../../i18n";
import type { MirrorStatus } from "../../storage/file-mirror";

/** État du miroir en fichiers locaux (app Windows). Rien sur le site : le statut est alors null. */
export default function LocalFilesNote({ status }: { status: MirrorStatus | null }) {
  if (!status) return null;
  const text =
    status.state === "idle"
      ? t("localfiles.ok", {
          root: status.root ?? "Documents\\Elium",
          date: status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "—",
        })
      : status.state === "syncing"
        ? t("localfiles.syncing")
        : t(status.state === "blocked" ? "localfiles.blocked" : "localfiles.error", { message: status.message });
  return (
    <p className="muted" role="status" title={t("localfiles.title")}>
      {text}
    </p>
  );
}
