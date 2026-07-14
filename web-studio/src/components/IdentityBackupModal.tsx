import { useState } from "react";
import { Copy, Download, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { Modal, Button, Alert, Badge } from "../ui/components";
import type { EliumIdentity } from "../sign/keys";

/**
 * Sauvegarde de l'identité Ed25519 : téléchargement du fichier .eliumkey
 * (chiffré), copie de la clé publique/empreinte, et — après déverrouillage —
 * affichage/copie de la clé privée en clair pour archivage personnel.
 */
export default function IdentityBackupModal({
  identity,
  justGenerated,
  onExportFile,
  onCopy,
  onRevealPrivateKey,
  onClose,
}: {
  identity: EliumIdentity;
  /** true juste après génération : message d'avertissement renforcé. */
  justGenerated: boolean;
  onExportFile: () => void;
  onCopy: (text: string, label: string) => void;
  /** Déverrouille la clé privée (mot de passe) et la retourne, ou null. */
  onRevealPrivateKey: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [privateHex, setPrivateHex] = useState<string | null>(identity.privateKeyHex ?? null);
  const [shown, setShown] = useState(false);

  const reveal = async () => {
    if (privateHex) {
      setShown((s) => !s);
      return;
    }
    const pk = await onRevealPrivateKey();
    if (pk) {
      setPrivateHex(pk);
      setShown(true);
    }
  };

  return (
    <Modal
      title={justGenerated ? "Sauvegardez votre nouvelle clé" : "Sauvegarde de la clé"}
      onClose={onClose}
      footer={<Button onClick={onClose}>{justGenerated ? "J'ai sauvegardé ma clé" : "Fermer"}</Button>}
    >
      <div className="settings">
        <Alert tone={justGenerated ? "warning" : "info"} title="Pourquoi sauvegarder ?">
          Cette clé est votre identité de signature et de scellement. Elle n'existe que dans ce
          navigateur : si son stockage est vidé (réinstallation, nettoyage…), elle est
          définitivement perdue et vous ne pourrez plus sceller vos documents avec la même
          identité. Conservez une sauvegarde en lieu sûr.
        </Alert>

        <section className="settings__section">
          <h3 className="settings__title"><Download size={15} /> Fichier de sauvegarde (recommandé)</h3>
          <p className="muted">
            Le fichier <code>.eliumkey</code> contient la clé privée <strong>chiffrée</strong> avec
            le mot de passe de votre clé (Argon2id + AES-256-GCM). Il peut être stocké sur un
            disque ou une clé USB, et réimporté via Paramètres → Importer une clé.
          </p>
          <div className="settings__row">
            <Button size="sm" onClick={onExportFile}>
              <Download size={15} /> Télécharger le fichier .eliumkey
            </Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title"><KeyRound size={15} /> Identité publique</h3>
          <div className="keyline">
            <span className="keyline__label">Empreinte <Badge accent="success">SHA-256</Badge></span>
            <code className="keyline__value">{identity.fingerprint}</code>
            <Button variant="ghost" size="sm" aria-label="Copier l'empreinte"
              onClick={() => onCopy(identity.fingerprint, "Empreinte copiée")}>
              <Copy size={14} />
            </Button>
          </div>
          <div className="keyline">
            <span className="keyline__label">Clé publique <Badge accent="success">Ed25519</Badge></span>
            <code className="keyline__value">{identity.publicKeyHex}</code>
            <Button variant="ghost" size="sm" aria-label="Copier la clé publique"
              onClick={() => onCopy(identity.publicKeyHex, "Clé publique copiée")}>
              <Copy size={14} />
            </Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title"><ShieldAlert size={15} /> Clé privée (sensible)</h3>
          <Alert tone="danger" title="À manipuler avec précaution">
            Quiconque possède cette clé peut signer et sceller en votre nom. Ne la collez
            jamais dans un e-mail, un chat ou un site web.
          </Alert>
          <div className="keyline">
            <span className="keyline__label">Clé privée</span>
            <code className="keyline__value keyline__value--secret">
              {privateHex && shown ? privateHex : "•".repeat(64)}
            </code>
            <Button variant="ghost" size="sm" aria-label={shown ? "Masquer la clé privée" : "Afficher la clé privée"} onClick={reveal}>
              {shown ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copier la clé privée"
              onClick={async () => {
                const pk = privateHex ?? (await onRevealPrivateKey());
                if (pk) {
                  setPrivateHex(pk);
                  onCopy(pk, "Clé privée copiée — collez-la en lieu sûr puis effacez le presse-papier");
                }
              }}
            >
              <Copy size={14} />
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
