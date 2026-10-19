/** Sauvegarde du passeport dans le Drive entreprise (serveur) : manuelle ou automatique. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Download, FileText, Upload } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { useDialogs } from "../../ui/dialogs";
import { reportError } from "../../ui/crash-log";
import type { OpsCtx } from "../../drive-cloud/ops";
import { useDrive } from "../../drive-cloud/session";
import { isConflict, pullPassport, pushPassport, readAuto, readLink, writeAuto, type DriveLink } from "../drive-sync";
import { readAuto as readAutoFlag, writeAuto as writeAutoFlag } from "../../drive-cloud/named-file";
import { docsFolderName, publishPassportDocs } from "../drive-docs";
import type { PassportData } from "../types";

interface Props {
  data: PassportData;
  onRestore: (data: PassportData) => Promise<void>;
  onOpenDrive?: () => void;
  /** Lit les octets d'une annexe (pour les publier dans le Drive avec les documents). */
  loadAnnexe?: (id: string) => Promise<Uint8Array | undefined>;
}

const AUTO_DELAY_MS = 20_000;

type Result = { kind: "idle" | "busy" | "ok" | "error" | "conflict"; message?: string };

export default function DriveSyncSection({ data, onRestore, onOpenDrive, loadAnnexe }: Props) {
  const d = useDrive();
  const { confirm } = useDialogs();
  const ctx = useMemo<OpsCtx | null>(() => {
    if (!d.keys || !d.user || !d.currentOrg) return null;
    return {
      api: d.api,
      keys: d.keys,
      userId: d.user.id,
      orgId: d.currentOrg.id,
      orgPublicHex: d.currentOrg.orgPublicHex,
      roleIdByKey: d.roleIdByKey,
    };
  }, [d.api, d.keys, d.user, d.currentOrg, d.roleIdByKey]);

  const [pw, setPw] = useState("");
  const [docsAuto, setDocsAuto] = useState(false);
  const [docs, setDocs] = useState<Result>({ kind: "idle" });
  const [auto, setAuto] = useState(false);
  const [link, setLink] = useState<DriveLink | null>(null);
  const [res, setRes] = useState<Result>({ kind: "idle" });
  const dataRef = useRef(data);
  dataRef.current = data;
  const busy = useRef(false);

  const ctxId = ctx ? `${ctx.userId}:${ctx.orgId}` : "";
  useEffect(() => {
    if (!ctx) return;
    setAuto(readAuto(ctx));
    setDocsAuto(readAutoFlag("passport-docs", ctx));
    setDocs({ kind: "idle" });
    setLink(readLink(ctx));
    setRes({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx change = changement de compte / d'organisation
  }, [ctxId]);

  const push = async (force = false) => {
    if (!ctx || busy.current) return;
    busy.current = true;
    setRes({ kind: "busy" });
    try {
      const l = await pushPassport(ctx, dataRef.current, { force });
      setLink(l);
      setRes({ kind: "ok", message: "Passeport enregistré dans le Drive." });
      if (readAutoFlag("passport-docs", ctx)) void publishDocs();
    } catch (e) {
      if (isConflict(e))
        setRes({
          kind: "conflict",
          message: "Un passeport plus récent (ou d'un autre appareil) existe déjà dans le Drive.",
        });
      else {
        reportError("passeport.drive.push", e);
        setRes({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      busy.current = false;
    }
  };

  const publishDocs = async () => {
    if (!ctx) return;
    setDocs({ kind: "busy", message: "Préparation…" });
    try {
      const r = await publishPassportDocs(
        ctx,
        dataRef.current,
        (done, total, name) =>
          setDocs({ kind: "busy", message: name ? `Envoi ${done + 1}/${total} — ${name}` : "Terminé" }),
        loadAnnexe,
      );
      setDocs({
        kind: "ok",
        message: `${r.count} document(s) (PDF et Word) publiés dans le dossier « ${r.folder} » du Drive.`,
      });
    } catch (e) {
      reportError("passeport.drive.docs", e);
      setDocs({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const restore = async () => {
    if (!ctx || busy.current) return;
    busy.current = true;
    setRes({ kind: "busy" });
    try {
      const got = await pullPassport(ctx);
      if (!got)
        return void setRes({ kind: "error", message: "Aucun passeport n'a encore été enregistré dans le Drive." });
      const ok = await confirm({
        title: "Remplacer le passeport local ?",
        message: `Le passeport du Drive contient ${got.data.situations.length} situation(s). Le passeport de cet appareil sera remplacé.`,
        confirmLabel: "Remplacer",
        danger: true,
      });
      if (!ok) return void setRes({ kind: "idle" });
      await onRestore(got.data);
      setLink(got.link);
      setRes({ kind: "ok", message: "Passeport restauré depuis le Drive." });
    } catch (e) {
      reportError("passeport.drive.pull", e);
      setRes({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current = false;
    }
  };

  // Synchronisation automatique : une écriture 20 s après la dernière modification.
  useEffect(() => {
    if (!ctx || !auto || res.kind === "conflict") return;
    if (link && link.syncedAt >= data.updatedAt) return;
    const id = setTimeout(() => void push(), AUTO_DELAY_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `push` lit toujours les dernières données via dataRef
  }, [data.updatedAt, auto, ctxId, res.kind]);

  return (
    <section className="pp-card">
      <h3>
        <Cloud size={18} aria-hidden="true" /> Sauvegarde sur le serveur (Drive entreprise)
      </h3>
      <p className="pp-note">
        Si vous utilisez Elium via un serveur, enregistrez votre passeport dans le Drive : il est chiffré de bout en
        bout, versionné et vous le retrouvez depuis n'importe quel appareil. Sans cela, il reste uniquement dans ce
        navigateur.
      </p>
      {!ctx ? (
        d.status === "locked" ? (
          <form
            className="pp-unlock"
            onSubmit={(e) => {
              e.preventDefault();
              if (pw) void d.unlock(pw).then(() => setPw(""));
            }}
          >
            <p className="pp-note">
              Votre session Drive est verrouillée (les clés ne sont jamais conservées). Saisissez votre mot de passe
              pour sauvegarder le passeport.
            </p>
            <div className="pp-actions">
              <input
                className="pp-input pp-unlock__input"
                type="password"
                autoComplete="current-password"
                aria-label="Mot de passe du Drive"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <Button type="submit" disabled={!pw || d.busy}>
                Déverrouiller
              </Button>
            </div>
            {d.error && <Alert tone="danger">{d.error}</Alert>}
          </form>
        ) : (
          <Alert tone="info">
            Vous n'êtes pas connecté au Drive entreprise.{" "}
            {onOpenDrive && (
              <Button size="sm" variant="outline" onClick={onOpenDrive}>
                Ouvrir le Drive entreprise
              </Button>
            )}
          </Alert>
        )
      ) : (
        <>
          <p className="pp-note">
            Connecté : {d.user?.email}
            {d.currentOrg ? ` — ${d.currentOrg.name}` : ""}.{" "}
            {link
              ? `Dernière synchronisation : ${new Date(link.syncedAt).toLocaleString("fr-FR")}.`
              : "Pas encore synchronisé."}
          </p>
          <div className="pp-actions">
            <Button onClick={() => void push()} disabled={res.kind === "busy"}>
              <Upload size={16} /> Enregistrer dans le Drive
            </Button>
            <Button variant="outline" onClick={() => void restore()} disabled={res.kind === "busy"}>
              <Download size={16} /> Restaurer depuis le Drive
            </Button>
          </div>
          <label className="pp-check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => {
                setAuto(e.target.checked);
                writeAuto(ctx, e.target.checked);
              }}
            />
            Synchroniser automatiquement après chaque modification
          </label>
          <div className="pp-docs">
            <p className="pp-note">
              Le fichier ci-dessus est la sauvegarde technique du passeport (JSON, pour le restaurer). Les{" "}
              <b>documents eux-mêmes</b> — passeport synoptique, fiches d'analyse, dossier complet, en PDF et Word — se
              publient dans un dossier du Drive : « {docsFolderName(data)} ».
            </p>
            <div className="pp-actions">
              <Button variant="outline" onClick={() => void publishDocs()} disabled={docs.kind === "busy"}>
                <FileText size={16} /> Publier les documents (PDF + Word) dans le Drive
              </Button>
            </div>
            <label className="pp-check">
              <input
                type="checkbox"
                checked={docsAuto}
                onChange={(e) => {
                  setDocsAuto(e.target.checked);
                  writeAutoFlag("passport-docs", ctx, e.target.checked);
                }}
              />
              Publier aussi les documents à chaque sauvegarde automatique
            </label>
            {docs.kind === "busy" && <p className="pp-note">{docs.message}</p>}
            {docs.kind === "ok" && <Alert tone="success">{docs.message}</Alert>}
            {docs.kind === "error" && <Alert tone="danger">{docs.message}</Alert>}
          </div>
          {res.kind === "busy" && <p className="pp-note">Synchronisation en cours…</p>}
          {res.kind === "ok" && <Alert tone="success">{res.message}</Alert>}
          {res.kind === "error" && <Alert tone="danger">{res.message}</Alert>}
          {res.kind === "conflict" && (
            <Alert tone="warning" title="Conflit">
              {res.message}
              <div className="pp-actions">
                <Button size="sm" variant="outline" onClick={() => void restore()}>
                  Restaurer la version du Drive
                </Button>
                <Button size="sm" variant="danger" onClick={() => void push(true)}>
                  Écraser avec ce passeport
                </Button>
              </div>
            </Alert>
          )}
        </>
      )}
    </section>
  );
}
