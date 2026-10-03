/** Gestion de la liste de racines de confiance C2PA (import .pem/.cer/.crt). */
import { useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import { anchorsFromFile, loadUserAnchors, saveUserAnchors, type TrustAnchor } from "../c2pa/trust";

export default function TrustPanel() {
  const input = useRef<HTMLInputElement>(null);
  const [anchors, setAnchors] = useState<TrustAnchor[]>(() => loadUserAnchors());
  const [error, setError] = useState<string | null>(null);

  const commit = (next: TrustAnchor[]) => {
    try {
      saveUserAnchors(next);
      setAnchors(next);
      setError(null);
    } catch (err) {
      reportError("detector.trust", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const added: TrustAnchor[] = [];
      for (const f of Array.from(files)) added.push(...anchorsFromFile(new Uint8Array(await f.arrayBuffer())));
      const known = new Set(anchors.map((a) => a.fingerprint));
      commit([...anchors, ...added.filter((a) => !known.has(a.fingerprint))]);
    } catch (err) {
      reportError("detector.trust.import", err);
      setError("Fichier de certificats illisible : fournissez un certificat X.509 au format PEM ou DER (.pem, .cer, .crt).");
    }
  };

  return (
    <section className="det-trust" aria-labelledby="det-trust-title">
      <h3 id="det-trust-title">Racines de confiance C2PA</h3>
      <p>
        Une signature C2PA n'est « reconnue » que si sa chaîne aboutit à l'une de ces racines. Aucune liste n'est
        embarquée : importez les certificats que vous jugez dignes de confiance (par exemple la liste de confiance
        officielle C2PA). La révocation n'est pas vérifiée hors ligne.
      </p>
      {error && (
        <Alert tone="danger" title="Import impossible">
          {error}
        </Alert>
      )}
      <ul>
        {anchors.length === 0 && <li>Aucune racine importée : toute signature valide sera « émetteur non reconnu ».</li>}
        {anchors.map((a) => (
          <li key={a.fingerprint}>
            <strong>{a.name}</strong> <code title={a.fingerprint}>{a.fingerprint.slice(0, 16)}…</code>{" "}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Retirer la racine ${a.name}`}
              onClick={() => commit(anchors.filter((x) => x.fingerprint !== a.fingerprint))}
            >
              <Trash2 size={13} />
            </Button>
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={() => input.current?.click()}>
        <Upload size={14} /> Importer des racines…
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept=".pem,.cer,.crt,.der"
        className="visually-hidden"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
