import { Button, EmptyState } from "../ui/components";
import { Key, PenLine, Trash2, ShieldCheck, UserCheck, UserPlus } from "lucide-react";
import { verdictLabel } from "../sign/proof";
import { fingerprintWords } from "../sign/safety-words";
import { useDialogs } from "../ui/dialogs";
import type { Studio } from "../studio/types";

export default function SignaturesPanel({ studio }: { studio: Studio }) {
  const { file, identity, editable, verdicts, attributions } = studio;
  const { prompt } = useDialogs();

  // « Approuver cette clé comme X » : nomme la clé de la preuve dans le carnet.
  const approveKey = async (name: string | undefined, publicKeyHex: string, fingerprint: string) => {
    const chosen = await prompt({
      title: "Approuver cette clé de signature",
      label: "Nom du signataire",
      defaultValue: name ?? "",
      hint: `Mots de vérification : ${fingerprintWords(fingerprint)} — comparez-les avec le signataire par un canal de confiance avant d'approuver.`,
      confirmLabel: "Approuver",
    });
    if (chosen !== null) await studio.trustContact(chosen.trim() || name || "Sans nom", publicKeyHex);
  };

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
        <p className="muted" style={{ marginTop: 6 }}>
          Les signataires connus se gèrent dans le <strong>carnet de clés de confiance</strong> (Paramètres) —
          une signature dont la clé y figure est attribuée à son nom ci-dessous.
        </p>
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
              const attributedTo = attributions[s.id];
              // Une clé de preuve non encore attribuée peut être approuvée au carnet.
              const canApprove = editable && !!s.proof && !attributedTo;
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
                  {attributedTo && (
                    <div className="sig-list__attrib">
                      <UserCheck size={13} /> Signé par <strong>{attributedTo}</strong> (clé de confiance)
                    </div>
                  )}
                  {canApprove && (
                    <button
                      className="sig-list__approve"
                      onClick={(e) => {
                        e.stopPropagation();
                        void approveKey(s.signer.name, s.proof!.publicKeyHex, s.proof!.fingerprint);
                      }}
                    >
                      <UserPlus size={13} /> Approuver cette clé comme…
                    </button>
                  )}
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
