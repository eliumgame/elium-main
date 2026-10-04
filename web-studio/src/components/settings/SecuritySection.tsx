/**
 * Sécurité et clés : identité de signature, clé de réception, carnet de clés de
 * confiance, coffre local. Composant ISOLÉ : la phase « Elium Keys » le remplacera
 * en bloc ; il conserve exactement les props et handlers de l'ancien SettingsModal
 * pour que la fusion soit un simple remplacement de fichier.
 */
import { useState } from "react";
import { BookUser, Copy, Download, KeyRound, Lock, ShieldCheck, Trash2, Unlock, Upload, UserPlus } from "lucide-react";
import { Alert, Badge, Button, Field } from "../../ui/components";
import { useI18n } from "../../i18n";
import type { EliumIdentity } from "../../sign/keys";
import type { TrustedContact } from "../../sign/trust-book";
import { fingerprintWords } from "../../sign/safety-words";
import type { RecipientPublic } from "../../crypto/recipient-key-store";
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

export function IdentitySection(p: SecurityProps) {
  const { t } = useI18n();
  return (
    <SectionCard id="sec_identity" titleKey="settings.sec.sec_identity" icon={<ShieldCheck size={15} />}>
      {p.identity ? (
        <div className="keyline">
          <span className="keyline__label">
            {t("security.fingerprint")} <Badge accent="success">Ed25519</Badge>
          </span>
          <code className="keyline__value">{p.identity.fingerprint}</code>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("security.copy_fingerprint")}
            onClick={() => p.onCopy(p.identity!.fingerprint, t("security.fingerprint_copied"))}
          >
            <Copy size={14} />
          </Button>
        </div>
      ) : (
        <p className="muted">{t("security.no_identity")}</p>
      )}
      <div className="settings__row">
        <Button variant="outline" size="sm" onClick={p.onRegenerateIdentity}>
          <KeyRound size={15} /> {p.identity ? t("security.regenerate") : t("security.generate")}
        </Button>
        {p.identity && (
          <Button variant="outline" size="sm" onClick={p.onBackupIdentity}>
            <Download size={15} /> {t("security.backup_key")}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={p.onImportIdentity}>
          <Upload size={15} /> {t("security.import_key")}
        </Button>
        {p.identity && (
          <Button variant="ghost" size="sm" onClick={p.onForgetIdentity}>
            {t("security.forget_identity")}
          </Button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {t("security.identity_note")}
      </p>
    </SectionCard>
  );
}

export function RecipientSection(p: SecurityProps) {
  const { t } = useI18n();
  return (
    <SectionCard id="sec_recipient" titleKey="settings.sec.sec_recipient" icon={<KeyRound size={15} />}>
      <p className="muted">{t("security.recipient_body")}</p>
      {p.recipientPublic ? (
        <div className="keyline">
          <span className="keyline__label">{t("security.recipient_fingerprint")}</span>
          <code className="keyline__value">{p.recipientPublic.fingerprint}</code>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("security.copy_fingerprint")}
            onClick={() => p.onCopy(p.recipientPublic!.fingerprint, t("security.fingerprint_copied"))}
          >
            <Copy size={14} />
          </Button>
        </div>
      ) : (
        <p className="muted">{t("security.recipient_none")}</p>
      )}
      <div className="settings__row">
        {p.onGenerateRecipientKey && (
          <Button variant="outline" size="sm" onClick={p.onGenerateRecipientKey}>
            <KeyRound size={15} /> {p.recipientPublic ? t("security.regenerate") : t("security.recipient_generate")}
          </Button>
        )}
        {p.recipientPublic && p.onForgetRecipientKey && (
          <Button variant="ghost" size="sm" onClick={p.onForgetRecipientKey}>
            {t("security.recipient_forget")}
          </Button>
        )}
      </div>
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
