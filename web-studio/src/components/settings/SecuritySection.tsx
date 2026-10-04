/**
 * Sécurité et clés : identité de signature, clé de réception, carnet de clés de
 * confiance, coffre local. Composant ISOLÉ : la phase « Elium Keys » le remplacera
 * en bloc ; il conserve exactement les props et handlers de l'ancien SettingsModal
 * pour que la fusion soit un simple remplacement de fichier.
 */
import { useState } from "react";
import { BookUser, Copy, KeyRound, Lock, ShieldCheck, Trash2, Unlock, UserPlus } from "lucide-react";
import { Alert, Badge, Button, Field } from "../../ui/components";
import { useI18n } from "../../i18n";
import type { EliumIdentity } from "../../sign/keys";
import type { TrustedContact } from "../../sign/trust-book";
import { fingerprintWords } from "../../sign/safety-words";
import type { RecipientPublic } from "../../crypto/recipient-key-store";
import KeyringPanel from "../KeyringPanel";
import { SectionCard } from "./parts";

export interface SecurityProps {
  identity: EliumIdentity | null;
  /** Carnet de clés de confiance (name→clé). */
  trustBook: TrustedContact[];
  onTrustContact: (name: string, publicKeyHex: string) => Promise<void> | void;
  onUntrustContact: (publicKeyHex: string) => void;
  onRegenerateIdentity: () => void;
  onForgetIdentity: () => void;
  onBackupIdentity: () => void;
  onImportIdentity: () => void;
  onCopy: (text: string, label: string) => void;
  /** Clé de réception (documents chiffrés pour des destinataires) — optionnel. */
  recipientPublic?: RecipientPublic | null;
  onGenerateRecipientKey?: () => void;
  onForgetRecipientKey?: () => void;
  /** True once the opt-in local vault is configured AND unlocked this session. */
  vaultEnabled: boolean;
  /** True while a vault operation (enable/change/disable, or any other app action) is in flight. */
  busy: boolean;
  onEnableVault: () => void;
  onChangeVaultPassword: () => void;
  onDisableVault: () => void;
}

/** « Mes clés » : le trousseau unifié (identité, clé de réception, sauvegardes) — composant isolé de la phase Elium Keys. */
export function IdentitySection(_p: SecurityProps) {
  void _p;
  return (
    <SectionCard id="sec_identity" titleKey="settings.sec.sec_identity" icon={<KeyRound size={15} />}>
      <KeyringPanel compact />
    </SectionCard>
  );
}

export function TrustSection(p: SecurityProps) {
  const { t } = useI18n();
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const canAdd = /^[0-9a-fA-F]{64}$/.test(newKey.trim());
  const addContact = async () => {
    if (!canAdd) return;
    await p.onTrustContact(newName.trim() || t("security.unnamed"), newKey.trim());
    setNewName("");
    setNewKey("");
  };
  return (
    <SectionCard id="sec_trust" titleKey="settings.sec.sec_trust" icon={<BookUser size={15} />}>
      <p className="muted">{t("security.trust_body")}</p>
      {p.trustBook.length === 0 ? (
        <p className="muted">{t("security.trust_empty")}</p>
      ) : (
        <ul className="trust-list">
          {p.trustBook.map((c) => (
            <li key={c.publicKeyHex} className="trust-list__item">
              <div className="trust-list__main">
                <span className="trust-list__name">
                  <ShieldCheck size={13} /> {c.name}
                </span>
                <code className="trust-list__words">{fingerprintWords(c.fingerprint)}</code>
              </div>
              <div className="trust-list__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("security.copy_fingerprint")}
                  onClick={() => p.onCopy(c.fingerprint, t("security.fingerprint_copied"))}
                >
                  <Copy size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${t("common.remove")} ${c.name}`}
                  onClick={() => p.onUntrustContact(c.publicKeyHex)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="trust-add">
        <Field label={t("security.trust_name")}>
          <input
            className="settings__input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("security.trust_name_placeholder")}
            spellCheck={false}
          />
        </Field>
        <Field label={t("security.trust_key")}>
          <input
            className="settings__input"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.trim())}
            placeholder="ex. 96dc0e0d…"
            spellCheck={false}
          />
        </Field>
        <Button variant="outline" size="sm" disabled={!canAdd} onClick={() => void addContact()}>
          <UserPlus size={14} /> {t("security.trust_add")}
        </Button>
        {newKey && !canAdd && <p className="muted">⚠ {t("security.trust_invalid")}</p>}
      </div>
    </SectionCard>
  );
}

export function VaultSection(p: SecurityProps) {
  const { t } = useI18n();
  return (
    <SectionCard
      id="sec_vault"
      titleKey="settings.sec.sec_vault"
      icon={p.vaultEnabled ? <Lock size={15} /> : <Unlock size={15} />}
    >
      <p className="muted">{t("security.vault_body")}</p>
      {p.vaultEnabled ? (
        <div className="settings__row">
          <Badge accent="success">
            <Lock size={12} /> {t("security.vault_active")}
          </Badge>
          <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onChangeVaultPassword}>
            {t("security.vault_change")}
          </Button>
          <Button variant="ghost" size="sm" disabled={p.busy} onClick={p.onDisableVault}>
            {t("security.vault_disable")}
          </Button>
        </div>
      ) : (
        <div className="settings__row">
          <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onEnableVault}>
            <Lock size={14} /> {t("security.vault_enable")}
          </Button>
        </div>
      )}
      <Alert tone="info">{t("security.vault_scope")}</Alert>
    </SectionCard>
  );
}
