/**
 * Certificate signing dialogs (Acrobat's « Signer avec un certificat » /
 * « Certifier », and Préférences › Signatures › Identités).
 */
import { useEffect, useRef, useState } from "react";
import { Download, KeyRound, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Modal } from "../../ui/components";
import type { PadesSignOptions, SignatureLook, SignerMaterial } from "../ops/pades";
import {
  addP12Id,
  addSelfId,
  addTrusted,
  listIds,
  listTrusted,
  removeId,
  removeTrusted,
  type DigitalId,
  type TrustedIdentity,
} from "./identities";
import { loadPdfPrefs, savePdfPrefs } from "./prefs";

export const SIGN_REASONS = [
  "Je suis l'auteur de ce document",
  "J'ai relu ce document",
  "J'approuve ce document",
  "J'accepte les termes définis par ce document",
  "Je certifie l'exactitude de ce document",
];

export interface SignChoice {
  material: SignerMaterial;
  options: Pick<
    PadesSignOptions,
    "reason" | "location" | "contactInfo" | "look" | "certify" | "lockDocument" | "tsaUrl"
  >;
  /** Show the placed picture in the appearance. */
  picture: boolean;
}

function certName(der: Uint8Array): Promise<string> {
  return import("../ops/der").then(({ parseCertificate }) => parseCertificate(der).commonName);
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** « Nouvel identifiant numérique » form (self-signed). */
function NewIdForm({ author, onDone }: { author: string; onDone: (id: DigitalId | null) => void }) {
  const [name, setName] = useState(author);
  const [org, setOrg] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const { createSelfSignedId } = await import("../ops/digital-id");
      const { key, cert } = await createSelfSignedId({
        name: name.trim(),
        organization: org.trim() || undefined,
        email: email.trim() || undefined,
      });
      onDone(await addSelfId(name.trim(), key, cert.der));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <fieldset className="pdfx-form__set">
      <legend>Nouvel identifiant numérique auto-signé</legend>
      <label className="pdfx-form__row">
        <span>Nom</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="pdfx-form__row">
        <span>Organisation</span>
        <input value={org} onChange={(e) => setOrg(e.target.value)} />
      </label>
      <label className="pdfx-form__row">
        <span>Adresse e-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <p className="pdfx-form__note">
        Clé RSA 2048 bits gardée par ce navigateur, sans possibilité d'export. Les destinataires verront une identité «
        non vérifiée » tant qu'ils n'auront pas approuvé votre certificat (exportable depuis Identités).
      </p>
      {error && <p className="pdfx-form__error">{error}</p>}
      <div className="pdfx-form__actions">
        <button className="eb eb--outline eb--sm" onClick={() => onDone(null)} disabled={busy}>
          Annuler
        </button>
        <button className="eb eb--primary eb--sm" onClick={create} disabled={busy || !name.trim()}>
          {busy ? "Création…" : "Créer"}
        </button>
      </div>
    </fieldset>
  );
}

export function SignDialog({
  author,
  placement,
  hasPicture,
  canCertify,
  initialCertify = false,
  onConfirm,
  onClose,
}: {
  author: string;
  /** Where the signature goes, in words. */
  placement: string;
  hasPicture: boolean;
  /** The document has no signature yet: it may be certified. */
  canCertify: boolean;
  /** Opened from « Certifier ». */
  initialCertify?: boolean;
  onConfirm: (c: SignChoice) => void;
  onClose: () => void;
}) {
  const prefs = loadPdfPrefs().signature ?? {};
  const [ids, setIds] = useState<DigitalId[] | null>(null);
  const [chosen, setChosen] = useState<string>(prefs.lastId ?? "");
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [remember, setRemember] = useState(true);
  const [mode, setMode] = useState<"approve" | 1 | 2 | 3>(initialCertify && canCertify ? 2 : "approve");
  const [reason, setReason] = useState(prefs.reason ?? "");
  const [location, setLocation] = useState(prefs.location ?? "");
  const [contact, setContact] = useState(prefs.contact ?? "");
  const [look, setLook] = useState<SignatureLook>(
    prefs.look ?? { name: true, date: true, reason: true, location: true, labels: true, dn: false },
  );
  const [textShown, setTextShown] = useState(prefs.text ?? true);
  const [picture, setPicture] = useState(hasPicture);
  const [lock, setLock] = useState(false);
  const [useTsa, setUseTsa] = useState(!!prefs.useTsa);
  const [tsaUrl, setTsaUrl] = useState(prefs.tsaUrl ?? "https://freetsa.org/tsr");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listIds().then((l) => {
      setIds(l);
      if (!l.some((i) => i.id === chosen)) setChosen(l[0]?.id ?? (l.length ? "" : "new"));
      if (!l.length) setCreating(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const id = ids?.find((i) => i.id === chosen);
  const needsPassword = chosen === "file" ? !!file : id?.kind === "p12";

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let material: SignerMaterial;
      if (chosen === "file") {
        if (!file) throw new Error("Choisissez un fichier de certificat (.p12, .pfx).");
        const { loadPkcs12 } = await import("../ops/pades");
        material = await loadPkcs12(file.bytes, password);
        if (remember) {
          const saved = await addP12Id(material.cert.commonName, file.name, file.bytes, material.cert.der);
          savePdfPrefs({ signature: { ...loadPdfPrefs().signature, lastId: saved.id } });
        }
      } else if (id?.kind === "p12") {
        const { loadPkcs12 } = await import("../ops/pades");
        material = await loadPkcs12(id.p12, password);
      } else if (id?.kind === "self") {
        const { materialOf } = await import("../ops/digital-id");
        material = materialOf(id.key, id.cert);
      } else {
        throw new Error("Choisissez un identifiant numérique.");
      }
      savePdfPrefs({
        signature: {
          ...loadPdfPrefs().signature,
          ...(chosen !== "file" ? { lastId: chosen } : {}),
          reason,
          location,
          contact,
          look,
          text: textShown,
          useTsa,
          tsaUrl,
        },
      });
      onConfirm({
        material,
        options: {
          reason: reason.trim() || undefined,
          location: location.trim() || undefined,
          contactInfo: contact.trim() || undefined,
          look: textShown ? look : false,
          certify: mode === "approve" ? undefined : mode,
          lockDocument: lock || undefined,
          tsaUrl: useTsa && tsaUrl.trim() ? tsaUrl.trim() : undefined,
        },
        picture,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const toggle = (k: keyof SignatureLook) => setLook((l) => ({ ...l, [k]: !l[k] }));

  return (
    <Modal
      title={mode === "approve" ? "Signer avec un certificat" : "Certifier le document"}
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            disabled={busy || creating || !ids || (!id && chosen !== "file") || (chosen === "file" && !file)}
            onClick={confirm}
          >
            {busy ? "Signature…" : mode === "approve" ? "Signer" : "Certifier"}
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">{placement}</p>
        <fieldset className="pdfx-form__set">
          <legend>Identifiant numérique</legend>
          {ids === null && <p className="pdfx-form__note">Chargement…</p>}
          {ids?.map((i) => (
            <label key={i.id} className="pdfx-radio">
              <input type="radio" checked={chosen === i.id} onChange={() => setChosen(i.id)} />
              <KeyRound size={14} /> {i.name}{" "}
              <em className="pdfx-muted">{i.kind === "self" ? "auto-signé" : i.fileName}</em>
            </label>
          ))}
          <label className="pdfx-radio">
            <input type="radio" checked={chosen === "file"} onChange={() => setChosen("file")} />
            Fichier de certificat (.p12, .pfx)…
          </label>
          {chosen === "file" && (
            <div className="pdfx-form__row">
              <span>{file ? file.name : "Aucun fichier"}</span>
              <button className="eb eb--outline eb--sm" onClick={() => fileInput.current?.click()}>
                <Upload size={14} /> Choisir…
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".p12,.pfx"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) setFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
                }}
              />
            </div>
          )}
          {needsPassword && (
            <label className="pdfx-form__row">
              <span>Mot de passe du certificat</span>
              <input
                type="password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && void confirm()}
              />
            </label>
          )}
          {chosen === "file" && (
            <label className="pdfx-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Mémoriser ce certificat dans ce navigateur (son mot de passe sera redemandé)
            </label>
          )}
          {creating ? (
            <NewIdForm
              author={author}
              onDone={(created) => {
                setCreating(false);
                if (created) {
                  setIds((l) => [...(l ?? []), created]);
                  setChosen(created.id);
                }
              }}
            />
          ) : (
            <button className="eb eb--ghost eb--sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> Nouvel identifiant auto-signé
            </button>
          )}
        </fieldset>

        <label className="pdfx-form__row">
          <span>Type</span>
          <select
            value={String(mode)}
            onChange={(e) => setMode(e.target.value === "approve" ? "approve" : (Number(e.target.value) as 1 | 2 | 3))}
          >
            <option value="approve">Signature d'approbation</option>
            {canCertify && <option value="1">Certifier : aucune modification autorisée</option>}
            {canCertify && <option value="2">Certifier : remplissage de formulaires et signatures</option>}
            {canCertify && <option value="3">Certifier : formulaires, signatures et commentaires</option>}
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Motif</span>
          <input list="pdfx-sign-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
          <datalist id="pdfx-sign-reasons">
            {SIGN_REASONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label className="pdfx-form__row">
          <span>Lieu</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className="pdfx-form__row">
          <span>Contact</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>

        <fieldset className="pdfx-form__set">
          <legend>Apparence</legend>
          {hasPicture && (
            <label className="pdfx-check">
              <input type="checkbox" checked={picture} onChange={(e) => setPicture(e.target.checked)} />
              Image de la signature placée
            </label>
          )}
          <label className="pdfx-check">
            <input type="checkbox" checked={textShown} onChange={(e) => setTextShown(e.target.checked)} />
            Texte
          </label>
          {textShown && (
            <div className="pdfx-form__inline">
              {(
                [
                  ["name", "Nom"],
                  ["date", "Date"],
                  ["reason", "Motif"],
                  ["location", "Lieu"],
                  ["dn", "Nom distinctif"],
                  ["labels", "Libellés"],
                ] as [keyof SignatureLook, string][]
              ).map(([k, label]) => (
                <label key={k} className="pdfx-check">
                  <input type="checkbox" checked={!!look[k]} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label className="pdfx-check">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
          Verrouiller le document après la signature
        </label>
        <label className="pdfx-check">
          <input type="checkbox" checked={useTsa} onChange={(e) => setUseTsa(e.target.checked)} />
          Horodater la signature (serveur RFC 3161)
        </label>
        {useTsa && (
          <label className="pdfx-form__row">
            <span>Serveur d'horodatage</span>
            <input value={tsaUrl} onChange={(e) => setTsaUrl(e.target.value)} placeholder="https://…" />
          </label>
        )}
        {error && <p className="pdfx-form__error">{error}</p>}
        <p className="pdfx-form__note">
          La signature est ajoutée à la fin du fichier : les signatures déjà présentes restent valides. Vous choisirez
          ensuite où enregistrer le document signé.
        </p>
      </div>
    </Modal>
  );
}

/** Digital IDs and trusted identities. */
export function IdentitiesDialog({ author, onClose }: { author: string; onClose: () => void }) {
  const [tab, setTab] = useState<"ids" | "trusted">("ids");
  const [ids, setIds] = useState<DigitalId[]>([]);
  const [trusted, setTrusted] = useState<TrustedIdentity[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void listIds().then(setIds);
    void listTrusted().then(setTrusted);
  };
  useEffect(refresh, []);

  const exportCert = async (name: string, der: Uint8Array) => {
    const { certificatePem } = await import("../ops/digital-id");
    download(`${name.replace(/[\\/:*?"<>|]+/g, "_")}.cer`, certificatePem(der), "application/pkix-cert");
  };

  return (
    <Modal
      title="Identités et certificats approuvés"
      onClose={onClose}
      footer={
        <button className="eb eb--primary eb--sm" onClick={onClose}>
          Fermer
        </button>
      }
    >
      <div className="pdfx-form">
        <div className="pdfx-segment pdfx-segment--wide">
          <button className={tab === "ids" ? "is-on" : ""} onClick={() => setTab("ids")}>
            Mes identifiants numériques
          </button>
          <button className={tab === "trusted" ? "is-on" : ""} onClick={() => setTab("trusted")}>
            Identités approuvées
          </button>
        </div>
        {tab === "ids" ? (
          <>
            {!ids.length && <p className="pdfx-form__note">Aucun identifiant enregistré dans ce navigateur.</p>}
            <ul className="pdfx-idlist">
              {ids.map((i) => (
                <li key={i.id}>
                  <KeyRound size={14} />
                  <span>
                    {i.name} <em className="pdfx-muted">{i.kind === "self" ? "auto-signé" : i.fileName}</em>
                  </span>
                  <button
                    className="eb eb--ghost eb--sm"
                    title="Exporter le certificat"
                    onClick={() => exportCert(i.name, i.cert)}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    className="eb eb--ghost eb--sm"
                    title="Supprimer"
                    onClick={async () => {
                      if (
                        !confirm(
                          `Supprimer l'identifiant « ${i.name} » ? ${i.kind === "self" ? "Sa clé sera perdue." : ""}`,
                        )
                      )
                        return;
                      await removeId(i.id);
                      refresh();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {creating ? (
              <NewIdForm
                author={author}
                onDone={() => {
                  setCreating(false);
                  refresh();
                }}
              />
            ) : (
              <button className="eb eb--outline eb--sm" onClick={() => setCreating(true)}>
                <Plus size={14} /> Nouvel identifiant auto-signé
              </button>
            )}
          </>
        ) : (
          <>
            <p className="pdfx-form__note">
              Une signature dont la chaîne de certificats aboutit à l'une de ces identités est affichée comme approuvée.
              Vos propres identifiants le sont aussi.
            </p>
            <ul className="pdfx-idlist">
              {trusted.map((t) => (
                <li key={t.id}>
                  <ShieldCheck size={14} />
                  <span>{t.name}</span>
                  <button className="eb eb--ghost eb--sm" title="Exporter" onClick={() => exportCert(t.name, t.cert)}>
                    <Download size={14} />
                  </button>
                  <button
                    className="eb eb--ghost eb--sm"
                    title="Retirer"
                    onClick={async () => {
                      await removeTrusted(t.id);
                      refresh();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <button className="eb eb--outline eb--sm" onClick={() => input.current?.click()}>
              <Upload size={14} /> Importer un certificat (.cer, .crt, .pem)…
            </button>
            <input
              ref={input}
              type="file"
              accept=".cer,.crt,.pem,.der"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setError("");
                try {
                  const { readCertificateFile } = await import("../ops/digital-id");
                  const der = readCertificateFile(new Uint8Array(await f.arrayBuffer()));
                  await addTrusted(await certName(der), der);
                  refresh();
                } catch {
                  setError("Ce fichier n'est pas un certificat X.509.");
                }
              }}
            />
          </>
        )}
        {error && <p className="pdfx-form__error">{error}</p>}
      </div>
    </Modal>
  );
}
