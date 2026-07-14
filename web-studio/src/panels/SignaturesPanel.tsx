import { Button, Field, EmptyState } from "../ui/components";
import { Key, PenLine, Trash2, ShieldCheck } from "lucide-react";
import { verdictLabel } from "../sign/proof";
import type { Studio } from "../studio/types";

export default function SignaturesPanel({ studio }: { studio: Studio }) {
  const { file, identity, editable, verdicts } = studio;

  return (
    <div className="panel">
      <section className="panel-section">
        <h3 className="panel-title"><Key size={15} /> Identité Ed25519</h3>
        {identity ? (
          <div className="id-box">
            <div className="id-box__head"><ShieldCheck size={14} /> Clé chargée</div>
            <code className="fp">{identity.fingerprint.slice(0, 28)}…</code>
            <Button variant="ghost" size="sm" onClick={() => studio.generateIdentity()}>Régénérer</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => studio.generateIdentity()}>
            <Key size={14} /> Générer une identité
          </Button>
        )}
        <Field label="Clé publique de confiance (hex)" hint="Pour vérifier l'auteur attendu d'une signature.">
          <input
            className="input"
            value={studio.trustedKey}
            onChange={(e) => studio.setTrustedKey(e.target.value)}
            placeholder="64 caractères hexadécimaux…"
          />
        </Field>
      </section>

      <section className="panel-section">
        <div className="panel-title-row">
          <h3 className="panel-title"><PenLine size={15} /> Signatures · {file.signatures.length}</h3>
          {editable && <Button size="sm" onClick={() => studio.openSignatureCreator()}>Créer</Button>}
        </div>

        {file.signatures.length === 0 ? (
          <EmptyState title="Aucune signature" hint="Créez une signature et placez-la librement dans le document." />
        ) : (
          <ul className="sig-list">
            {file.signatures.map((s) => {
              const verdict = verdicts[s.id] ?? (s.proof ? "unknown_key" : "visual_only");
              return (
                <li
                  key={s.id}
                  className={`sig-list__item ${studio.selectedSig === s.id ? "is-selected" : ""}`}
                  onClick={() => studio.selectSignature(s.id)}
                >
                  <div className="sig-list__main">
                    <span className="sig-list__name">{s.signer.name || s.visual.text || s.kind}</span>
                    <span className={`sig-tag sig-tag--${verdict}`}>{verdictLabel(verdict)}</span>
                  </div>
                  <div className="sig-list__meta">
                    {s.kind}
                    {s.signer.role ? ` · ${s.signer.role}` : ""}
                    {s.proof ? " · preuve crypto" : ""}
                  </div>
                  {editable && (
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={(e) => { e.stopPropagation(); studio.removeSignature(s.id); }}
                      aria-label="Supprimer la signature"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
