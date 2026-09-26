/**
 * Signature panel (Acrobat's « Signatures » pane): each signature's verdict,
 * what changed after it, its certificate, and actions — trust the signer,
 * show the signed version, go to the field. Empty signature fields are listed
 * too, to be signed.
 */
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSignature,
  HelpCircle,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { PadesVerification } from "../ops/pades";

export interface SignatureView {
  list: PadesVerification[] | null;
  /** Unsigned signature fields: name and 0-based page. */
  empty: { name: string; page: number }[];
  error?: string;
}

export interface SignaturesPaneProps {
  view: SignatureView;
  pageLabel: (index: number) => string;
  onRefresh: () => void;
  onSignField: (name: string) => void;
  onGoToField: (name: string) => void;
  onSignedVersion: (v: PadesVerification) => void;
  onTrust: (v: PadesVerification) => void;
  onIdentities: () => void;
}

type Verdict = "valid" | "unknown" | "invalid";

export function verdictOf(v: PadesVerification): Verdict {
  if (!v.intact || v.modifications === "disallowed" || (v.error && !v.intact)) return "invalid";
  if (v.valid && v.trust === "trusted") return "valid";
  return "unknown";
}

/** One line summing up the document's signatures (the message bar). */
export function signaturesSummary(list: PadesVerification[]): { verdict: Verdict; text: string } {
  if (!list.length) return { verdict: "unknown", text: "Aucune signature." };
  const verdicts = list.map(verdictOf);
  const certified = list.find((v) => v.certification);
  const by = certified ? `Certifié par ${certified.signerName}. ` : "";
  if (verdicts.includes("invalid"))
    return { verdict: "invalid", text: `${by}Au moins une signature est invalide ou le document a été modifié.` };
  if (verdicts.every((x) => x === "valid"))
    return { verdict: "valid", text: `${by}Signé et toutes les signatures sont valides.` };
  return {
    verdict: "unknown",
    text: `${by}Au moins une signature présente un problème : identité du signataire non vérifiée ou certificat hors validité.`,
  };
}

const ICON: Record<Verdict, React.ReactNode> = {
  valid: <CheckCircle2 size={16} className="pdfx-sig__ok" />,
  unknown: <HelpCircle size={16} className="pdfx-sig__warn" />,
  invalid: <XCircle size={16} className="pdfx-sig__bad" />,
};

function when(iso?: string): string {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "medium" });
}

function Details({ v, p }: { v: PadesVerification; p: SignaturesPaneProps }) {
  const trustText =
    v.trust === "trusted"
      ? "L'identité du signataire est approuvée."
      : v.trust === "selfSigned"
        ? "Certificat auto-signé : l'identité du signataire n'a pas été vérifiée."
        : "L'autorité qui a délivré le certificat ne fait pas partie de vos identités approuvées.";
  return (
    <div className="pdfx-sig__details">
      <p>
        {v.intact
          ? "La signature est intacte : le document n'a pas été modifié depuis dans la version signée."
          : "La signature n'est pas intacte : le contenu signé a été modifié ou la signature est corrompue."}
      </p>
      <p>
        {v.modifications === "none"
          ? "Aucune modification depuis la signature."
          : v.modifications === "allowed"
            ? "Des modifications autorisées ont été apportées depuis :"
            : "Des modifications NON autorisées ont été apportées depuis :"}
      </p>
      {v.changes.length > 0 && (
        <ul>
          {v.changes.map((c, i) => (
            <li key={i} className={c.kind === "disallowed" ? "pdfx-sig__bad" : undefined}>
              {c.label}
            </li>
          ))}
        </ul>
      )}
      <p>{trustText}</p>
      {!v.certValidAtSigning && (
        <p className="pdfx-sig__bad">Le certificat n'était pas valide à la date de signature.</p>
      )}
      <p>
        {v.timeSource === "timestamp"
          ? `Horodatage de confiance : ${when(v.signedAt)}.`
          : `Heure de signature (horloge du signataire) : ${when(v.signedAt)}.`}
      </p>
      {v.certification && (
        <p>
          Signature de certification :{" "}
          {v.certification === 1
            ? "aucune modification autorisée."
            : v.certification === 2
              ? "remplissage de formulaires et signatures autorisés."
              : "formulaires, signatures et commentaires autorisés."}
        </p>
      )}
      {v.locks && <p>Verrouille {v.locks[0] === "*" ? "tous les champs" : `les champs ${v.locks.join(", ")}`}.</p>}
      {v.reason && <p>Motif : {v.reason}</p>}
      {v.location && <p>Lieu : {v.location}</p>}
      {v.contactInfo && <p>Contact : {v.contactInfo}</p>}
      {v.error && <p className="pdfx-sig__bad">{v.error}</p>}
      {v.chain.length > 0 && (
        <details>
          <summary>Certificat</summary>
          {v.chain.map((c, i) => (
            <dl key={i} className="pdfx-sig__cert">
              <dt>Sujet</dt>
              <dd>{c.subject}</dd>
              <dt>Émetteur</dt>
              <dd>{c.issuer}</dd>
              <dt>Validité</dt>
              <dd>
                {when(c.notBefore)} – {when(c.notAfter)}
              </dd>
              <dt>Numéro de série</dt>
              <dd>{c.serialHex}</dd>
            </dl>
          ))}
          <p className="pdfx-muted">
            {v.hash} · {v.keyType === "ec" ? "ECDSA" : "RSA"} · {v.subFilter}
          </p>
        </details>
      )}
      <div className="pdfx-sig__actions">
        <button className="eb eb--outline eb--sm" onClick={() => p.onGoToField(v.fieldName)}>
          Afficher le champ
        </button>
        {!v.coversWholeDocument && (
          <button className="eb eb--outline eb--sm" onClick={() => p.onSignedVersion(v)}>
            Afficher la version signée
          </button>
        )}
        {v.trust !== "trusted" && v.certificate && (
          <button className="eb eb--outline eb--sm" onClick={() => p.onTrust(v)}>
            <ShieldCheck size={14} /> Approuver ce certificat
          </button>
        )}
      </div>
    </div>
  );
}

export default function SignaturesPane(p: SignaturesPaneProps) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { list, empty, error } = p.view;
  const summary = list ? signaturesSummary(list) : null;
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <div className="pdfx-panel pdfx-sig">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Signatures</span>
        <span className="pdfx-panel__count">{list?.length ?? ""}</span>
        <button className="pdfx-icon" title="Tout valider" onClick={p.onRefresh}>
          <RefreshCw size={15} />
        </button>
        <button className="pdfx-icon" title="Identités et certificats approuvés" onClick={p.onIdentities}>
          <ShieldCheck size={15} />
        </button>
      </div>
      <div className="pdfx-panel__body">
        {error && (
          <p className="pdfx-sig__bar pdfx-sig__bar--invalid">
            <AlertTriangle size={14} /> {error}
          </p>
        )}
        {!list && !error && <p className="pdfx-empty">Vérification des signatures…</p>}
        {summary && list!.length > 0 && (
          <p className={`pdfx-sig__bar pdfx-sig__bar--${summary.verdict}`}>
            {ICON[summary.verdict]} {summary.text}
          </p>
        )}
        {list && !list.length && !empty.length && (
          <p className="pdfx-empty">Ce document ne contient aucune signature.</p>
        )}
        <ul className="pdfx-sig__list">
          {list?.map((v) => {
            const k = `${v.revision}:${v.fieldName}`;
            const verdict = verdictOf(v);
            return (
              <li key={k}>
                <button className="pdfx-sig__row" onClick={() => toggle(k)} aria-expanded={open.has(k)}>
                  {open.has(k) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {ICON[verdict]}
                  <span>
                    <b>
                      Rév. {v.revision} : {v.certification ? "certifié" : "signé"} par {v.signerName || "inconnu"}
                    </b>
                    <span className="pdfx-row__sub">
                      {verdict === "valid"
                        ? "La signature est valide"
                        : verdict === "invalid"
                          ? "La signature est invalide"
                          : "Validité inconnue"}{" "}
                      · {when(v.signedAt)}
                    </span>
                  </span>
                </button>
                {open.has(k) && <Details v={v} p={p} />}
              </li>
            );
          })}
          {empty.map((f) => (
            <li key={`empty:${f.name}`}>
              <button className="pdfx-sig__row" onClick={() => p.onSignField(f.name)}>
                <FileSignature size={16} />
                <span>
                  <b>Champ de signature vide : {f.name}</b>
                  <span className="pdfx-row__sub">Page {p.pageLabel(f.page)} · cliquer pour signer</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
