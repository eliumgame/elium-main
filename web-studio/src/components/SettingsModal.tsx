import { Sun, Moon, KeyRound, Trash2, ShieldCheck, Copy, Download, Upload, Lock, Unlock } from "lucide-react";
import { Modal, Button, Field, Alert, Badge } from "../ui/components";
import type { Theme } from "../ui/theme";
import type { EliumIdentity } from "../sign/keys";
import { useDialogs } from "../ui/dialogs";

export interface SettingsProps {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  identity: EliumIdentity | null;
  trustedKey: string;
  onSetTrustedKey: (k: string) => void;
  onRegenerateIdentity: () => void;
  onForgetIdentity: () => void;
  onBackupIdentity: () => void;
  onImportIdentity: () => void;
  onCopy: (text: string, label: string) => void;
  onClearStorage: () => void;
  onClose: () => void;
  /** True once the opt-in local vault is configured AND unlocked this session. */
  vaultEnabled: boolean;
  /** True while a vault operation (enable/change/disable, or any other app action) is in flight. */
  busy: boolean;
  onEnableVault: () => void;
  onChangeVaultPassword: () => void;
  onDisableVault: () => void;
}

export default function SettingsModal(p: SettingsProps) {
  const { confirm } = useDialogs();
  return (
    <Modal title="Paramètres" onClose={p.onClose} footer={<Button onClick={p.onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Apparence</h3>
          <div className="theme-seg" role="group" aria-label="Thème">
            <Button variant={p.theme === "light" ? "primary" : "outline"} size="sm" onClick={() => p.onSetTheme("light")}>
              <Sun size={15} /> Clair
            </Button>
            <Button variant={p.theme === "dark" ? "primary" : "outline"} size="sm" onClick={() => p.onSetTheme("dark")}>
              <Moon size={15} /> Sombre
            </Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Langue</h3>
          <select className="settings__select" defaultValue="fr" aria-label="Langue de l'interface">
            <option value="fr">Français</option>
            <option value="en" disabled>English (bientôt)</option>
          </select>
        </section>

        <section className="settings__section">
          <h3 className="settings__title"><ShieldCheck size={15} /> Identité de signature</h3>
          {p.identity ? (
            <div className="keyline">
              <span className="keyline__label">Empreinte <Badge accent="success">Ed25519</Badge></span>
              <code className="keyline__value">{p.identity.fingerprint}</code>
              <Button variant="ghost" size="sm" aria-label="Copier l'empreinte"
                onClick={() => p.onCopy(p.identity!.fingerprint, "Empreinte copiée")}>
                <Copy size={14} />
              </Button>
            </div>
          ) : (
            <p className="muted">Aucune identité. Générez-en une pour signer cryptographiquement.</p>
          )}
          <div className="settings__row">
            <Button variant="outline" size="sm" onClick={p.onRegenerateIdentity}>
              <KeyRound size={15} /> {p.identity ? "Régénérer" : "Générer une identité"}
            </Button>
            {p.identity && (
              <Button variant="outline" size="sm" onClick={p.onBackupIdentity}>
                <Download size={15} /> Sauvegarder la clé
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={p.onImportIdentity}>
              <Upload size={15} /> Importer une clé
            </Button>
            {p.identity && (
              <Button variant="ghost" size="sm" onClick={p.onForgetIdentity}>Oublier l'identité</Button>
            )}
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            La clé privée est chiffrée au repos (Argon2id + AES-GCM) et n'existe en clair qu'après déverrouillage.
            Sans sauvegarde (.eliumkey ou copie de la clé), elle est irrécupérable si ce navigateur est réinitialisé.
          </p>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Clé de confiance</h3>
          <Field label="Clé publique attendue d'un signataire (hex)" hint="Permet d'attribuer une signature/un sceau « valide » à une identité connue.">
            <input
              className="settings__input"
              value={p.trustedKey}
              onChange={(e) => p.onSetTrustedKey(e.target.value.trim())}
              placeholder="ex. 96dc0e0d…"
              spellCheck={false}
            />
          </Field>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">{p.vaultEnabled ? <Lock size={15} /> : <Unlock size={15} />} Coffre local</h3>
          <p className="muted">
            Chiffre la bibliothèque « Récents » et le Parapheur dans ce navigateur avec un mot de passe séparé de celui de vos
            documents. Optionnel — sans lui, ces deux index restent lisibles localement comme aujourd'hui.
          </p>
          {p.vaultEnabled ? (
            <div className="settings__row">
              <Badge accent="success"><Lock size={12} /> Actif</Badge>
              <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onChangeVaultPassword}>Changer le mot de passe</Button>
              <Button variant="ghost" size="sm" disabled={p.busy} onClick={p.onDisableVault}>Désactiver</Button>
            </div>
          ) : (
            <div className="settings__row">
              <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onEnableVault}>
                <Lock size={14} /> Activer le coffre local
              </Button>
            </div>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Données locales</h3>
          <Alert tone="warning" title="Stockage navigateur">
            Identité chiffrée, clé de confiance et thème sont stockés dans ce navigateur uniquement.
            Aucune donnée n'est envoyée en ligne.
          </Alert>
          <div className="settings__row" style={{ marginTop: 8 }}>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                if (await confirm({ title: "Effacer les données locales", message: "Effacer l'identité, la clé de confiance et les préférences de ce navigateur ?", danger: true, confirmLabel: "Effacer" })) {
                  p.onClearStorage();
                }
              }}
            >
              <Trash2 size={15} /> Effacer les données locales
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
