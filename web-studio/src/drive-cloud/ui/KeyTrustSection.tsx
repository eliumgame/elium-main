import { useEffect, useState } from "react";
import {
  acceptKeyChange,
  dismissKeyPinNotice,
  keyFingerprint,
  keyPinAlerts,
  keyPinNotices,
  onKeyPinAlerts,
  onKeyPinNotices,
  PIN_KIND_LABEL,
} from "../key-pins";
import { useDialogs } from "../../ui/dialogs";

export default function KeyTrustSection() {
  const [alerts, setAlerts] = useState(keyPinAlerts);
  const [notices, setNotices] = useState(keyPinNotices);
  const dialogs = useDialogs();
  useEffect(() => onKeyPinAlerts(setAlerts), []);
  useEffect(() => onKeyPinNotices(setNotices), []);
  if (!alerts.length && !notices.length) return null;
  return (
    <>
      {alerts.length > 0 && (
        <section className="dc-security-section">
          <h3>Clés Drive modifiées — envoi bloqué</h3>
          <p>Comparez les mots de sécurité par un autre canal avec le destinataire ou votre administrateur.</p>
          {alerts.map((a) => (
            <div key={`${a.kind}:${a.id}`}>
              <p>
                Clé {PIN_KIND_LABEL[a.kind]} : {a.label ?? a.id}
              </p>
              <button
                className="eb eb--outline"
                onClick={() =>
                  void (async () => {
                    const [before, after] = await Promise.all([
                      keyFingerprint(a.pinnedHex),
                      keyFingerprint(a.presentedHex),
                    ]);
                    if (
                      await dialogs.confirm({
                        title: "Vérifier une nouvelle clé Drive",
                        message: `Ancienne empreinte : ${before.words}\nNouvelle empreinte : ${after.words}\n${after.grouped}\nConfirmez uniquement après vérification avec son propriétaire.`,
                        confirmLabel: "Empreinte vérifiée",
                      })
                    )
                      acceptKeyChange(a.kind, a.id);
                  })()
                }
              >
                Comparer et vérifier
              </button>
            </div>
          ))}
        </section>
      )}
      {notices.length > 0 && (
        <section className="dc-security-section">
          <h3>Nouveaux destinataires non vérifiés</h3>
          <p>
            Ces clés ont été reçues du serveur pour la première fois et mémorisées telles quelles (confiance au premier
            usage). Un serveur compromis aurait pu en fournir une fausse : comparez les mots de sécurité par un autre
            canal.
          </p>
          {notices.map((n) => (
            <div key={`${n.kind}:${n.id}`}>
              <p>
                Clé {PIN_KIND_LABEL[n.kind]} : {n.label ?? n.id}
              </p>
              <button
                className="eb eb--outline"
                onClick={() =>
                  void (async () => {
                    const fp = await keyFingerprint(n.publicHex);
                    if (
                      await dialogs.confirm({
                        title: "Vérifier une clé Drive",
                        message: `Empreinte : ${fp.words}\n${fp.grouped}\nConfirmez uniquement après comparaison avec son propriétaire.`,
                        confirmLabel: "Empreinte vérifiée",
                      })
                    )
                      dismissKeyPinNotice(n.kind, n.id);
                  })()
                }
              >
                Comparer et vérifier
              </button>
              <button className="eb eb--outline" onClick={() => dismissKeyPinNotice(n.kind, n.id)}>
                Ignorer
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
