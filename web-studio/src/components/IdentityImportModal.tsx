import { useRef, useState } from "react";
import { FileKey2, ClipboardPaste, Upload } from "lucide-react";
import { Modal, Button, Field, Alert, Tabs } from "../ui/components";

/**
 * Restauration d'une identité Ed25519 : depuis un fichier .eliumkey (chiffré)
 * ou en collant directement la clé privée hexadécimale (64 caractères).
 */
export default function IdentityImportModal({
  hasExistingIdentity,
  onImportFile,
  onImportHex,
  onClose,
}: {
  hasExistingIdentity: boolean;
  /** Lance la restauration depuis le contenu d'un .eliumkey (demande le mot de passe). */
  onImportFile: (text: string) => Promise<boolean>;
  /** Lance l'import d'une clé privée hex (demande un nouveau mot de passe). */
  onImportHex: (hex: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("file");
  const [hex, setHex] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const hexOk = /^[0-9a-fA-F]{64}$/.test(hex.trim().replace(/^0x/, ""));

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      if (await onImportFile(await f.text())) onClose();
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <Modal
      title="Importer une clé"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          {tab === "hex" && (
            <Button
              disabled={!hexOk || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (await onImportHex(hex)) onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Importer la clé
            </Button>
          )}
        </>
      }
    >
      <div className="settings">
        {hasExistingIdentity && (
          <Alert tone="warning" title="Une identité existe déjà">
            L'import remplacera l'identité actuelle de ce navigateur. Exportez-la d'abord
            (Paramètres → Sauvegarder la clé) si vous voulez pouvoir y revenir.
          </Alert>
        )}

        <Tabs
          tabs={[
            { id: "file", label: "Fichier .eliumkey" },
            { id: "hex", label: "Clé privée (hex)" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "file" ? (
          <section className="settings__section">
            <p className="muted">
              <FileKey2 size={14} style={{ verticalAlign: "-2px" }} /> Sélectionnez la sauvegarde
              chiffrée <code>.eliumkey</code> créée depuis Elium. Le mot de passe de la clé vous
              sera demandé pour la déverrouiller.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".eliumkey,application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <div className="settings__row">
              <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Upload size={15} /> Choisir le fichier…
              </Button>
            </div>
          </section>
        ) : (
          <section className="settings__section">
            <p className="muted">
              <ClipboardPaste size={14} style={{ verticalAlign: "-2px" }} /> Collez la clé privée
              Ed25519 (64 caractères hexadécimaux). Un nouveau mot de passe vous sera demandé pour
              la chiffrer dans ce navigateur.
            </p>
            <Field label="Clé privée (64 hex)">
              <input
                className="settings__input"
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                placeholder="ex. 4f8a…"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            {hex && !hexOk && <p className="muted">Format attendu : exactement 64 caractères hexadécimaux.</p>}
          </section>
        )}
      </div>
    </Modal>
  );
}
