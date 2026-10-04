/**
 * Réglages : fenêtre à navigation latérale par catégories (Général, Apparence,
 * Édition, Polices, Raccourcis, Espace de travail, Sécurité & clés, Mises à jour,
 * Confidentialité & données, À propos) avec une recherche qui retrouve une
 * section par son nom ou un synonyme. Chaque section est un composant à part
 * (components/settings/) ; les sections « Sécurité & clés » sont isolées dans
 * SecuritySection.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import FontManager from "./FontManager";
import { Modal, Button } from "../ui/components";
import type { Theme } from "../ui/theme";
import type { EliumIdentity } from "../sign/keys";
import type { TrustedContact } from "../sign/trust-book";
import type { RecipientPublic } from "../crypto/recipient-key-store";
import { useI18n } from "../i18n";
import { CATEGORIES, SECTIONS, searchSections, sectionsOf, type CategoryId, type SectionId } from "./settings/sections";
import {
  AboutSection,
  DensitySection,
  EditAutosaveSection,
  EditDefaultsSection,
  EditSpellSection,
  FontsSection,
  LanguageSection,
  StartupSection,
  ThemeSection,
} from "./settings/BasicSections";
import ShortcutsSection from "./settings/ShortcutsSection";
import { ClearDataSection, CrashLogSection } from "./settings/PrivacySection";
import {
  IdentitySection,
  RecipientSection,
  TrustSection,
  VaultSection,
  type SecurityProps,
} from "./settings/SecuritySection";
import {
  BackupSection,
  IndexSection,
  RestoreSection,
  TrashSettingsSection,
  type WorkspaceSettingsBridge,
} from "./settings/WorkspaceSection";
import UpdatesPanel from "./UpdatesPanel";
import PortSettings from "./PortSettings";
import { SectionCard } from "./settings/parts";

export interface SettingsProps {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
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
  onClearStorage: () => void;
  onClose: () => void;
  /** True once the opt-in local vault is configured AND unlocked this session. */
  vaultEnabled: boolean;
  /** True while a vault operation (enable/change/disable, or any other app action) is in flight. */
  busy: boolean;
  onEnableVault: () => void;
  onChangeVaultPassword: () => void;
  onDisableVault: () => void;
  // --- Ajouts de l'espace de travail (tous optionnels) ---
  recipientPublic?: RecipientPublic | null;
  onGenerateRecipientKey?: () => void;
  onForgetRecipientKey?: () => void;
  /** Pont vers l'espace de travail (sauvegarde, corbeille, index). Absent : la catégorie reste visible mais inactive. */
  workspace?: WorkspaceSettingsBridge;
  onOpenDocumentation?: () => void;
  /** Ouvre directement une catégorie / une section (ex. depuis la palette de commandes). */
  initialCategory?: CategoryId;
  initialSection?: SectionId;
}

export default function SettingsModal(p: SettingsProps) {
  const { t } = useI18n();
  const [category, setCategory] = useState<CategoryId>(
    p.initialCategory ??
      (p.initialSection ? SECTIONS.find((s) => s.id === p.initialSection)?.category : undefined) ??
      "general",
  );
  const [query, setQuery] = useState("");
  const [fontsOpen, setFontsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => searchSections(query, t), [query, t]);
  const searching = query.trim() !== "";

  // Section demandée à l'ouverture : on la fait défiler dans la vue.
  useEffect(() => {
    if (!p.initialSection) return;
    document.getElementById(`settings-${p.initialSection}`)?.scrollIntoView({ block: "start" });
  }, [p.initialSection]);

  // Une seule fenêtre modale à la fois (piège de focus) : le gestionnaire remplace les réglages le temps de l'utiliser.
  if (fontsOpen) return <FontManager onClose={() => setFontsOpen(false)} />;

  const security: SecurityProps = {
    identity: p.identity,
    trustBook: p.trustBook,
    onTrustContact: p.onTrustContact,
    onUntrustContact: p.onUntrustContact,
    onRegenerateIdentity: p.onRegenerateIdentity,
    onForgetIdentity: p.onForgetIdentity,
    onBackupIdentity: p.onBackupIdentity,
    onImportIdentity: p.onImportIdentity,
    onCopy: p.onCopy,
    recipientPublic: p.recipientPublic,
    onGenerateRecipientKey: p.onGenerateRecipientKey,
    onForgetRecipientKey: p.onForgetRecipientKey,
    vaultEnabled: p.vaultEnabled,
    busy: p.busy,
    onEnableVault: p.onEnableVault,
    onChangeVaultPassword: p.onChangeVaultPassword,
    onDisableVault: p.onDisableVault,
  };

  const unavailable = (id: SectionId) => (
    <SectionCard id={id} titleKey={SECTIONS.find((s) => s.id === id)!.titleKey}>
      <p className="muted">{t("settings.unavailable_here")}</p>
    </SectionCard>
  );

  const render = (id: SectionId): React.ReactNode => {
    const ws = p.workspace;
    switch (id) {
      case "language":
        return <LanguageSection />;
      case "startup":
        return <StartupSection />;
      case "theme":
        return <ThemeSection theme={p.theme} onSetTheme={p.onSetTheme} />;
      case "density":
        return <DensitySection />;
      case "edit_defaults":
        return <EditDefaultsSection />;
      case "edit_autosave":
        return <EditAutosaveSection />;
      case "edit_spell":
        return <EditSpellSection />;
      case "fonts_manager":
        return <FontsSection onOpenManager={() => setFontsOpen(true)} />;
      case "shortcuts_list":
        return <ShortcutsSection />;
      case "ws_backup":
        return ws ? <BackupSection bridge={ws} /> : unavailable(id);
      case "ws_restore":
        return ws ? <RestoreSection bridge={ws} /> : unavailable(id);
      case "ws_trash":
        return ws ? <TrashSettingsSection bridge={ws} /> : unavailable(id);
      case "ws_index":
        return ws ? <IndexSection bridge={ws} /> : unavailable(id);
      case "sec_identity":
        return <IdentitySection {...security} />;
      case "sec_recipient":
        return <RecipientSection {...security} />;
      case "sec_trust":
        return <TrustSection {...security} />;
      case "sec_vault":
        return <VaultSection {...security} />;
      case "upd_versions":
        return (
          <SectionCard id={id} titleKey="settings.sec.upd_versions">
            <UpdatesPanel withPort={false} />
          </SectionCard>
        );
      case "upd_port":
        return (
          <SectionCard id={id} titleKey="settings.sec.upd_port">
            <PortSettings />
          </SectionCard>
        );
      case "priv_clear":
        return <ClearDataSection onClearStorage={p.onClearStorage} />;
      case "priv_log":
        return <CrashLogSection onCopied={(m) => p.workspace?.notify(m)} />;
      case "about_app":
        return <AboutSection onOpenDocumentation={() => (p.onOpenDocumentation ?? (() => undefined))()} />;
    }
  };

  const catLabel = (id: CategoryId) => t(CATEGORIES.find((c) => c.id === id)!.labelKey);

  return (
    <Modal
      title={t("settings.title")}
      wide
      onClose={p.onClose}
      footer={<Button onClick={p.onClose}>{t("common.close")}</Button>}
    >
      <div className="settings-shell">
        <div className="settings-shell__side">
          <div className="settings-shell__search">
            <Search size={15} aria-hidden />
            <input
              type="search"
              value={query}
              placeholder={t("settings.search_placeholder")}
              aria-label={t("settings.search_placeholder")}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="icon-btn" aria-label={t("search.clear")} onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </div>
          <nav aria-label={t("settings.categories")}>
            <ul className="settings-shell__nav">
              {CATEGORIES.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`settings-shell__item ${!searching && category === c.id ? "is-active" : ""}`}
                    aria-current={!searching && category === c.id ? "page" : undefined}
                    onClick={() => {
                      setQuery("");
                      setCategory(c.id);
                      contentRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    {t(c.labelKey)}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div
          className="settings settings-shell__content"
          ref={contentRef}
          role="region"
          aria-label={searching ? t("settings.search_results") : catLabel(category)}
        >
          {searching ? (
            matches.length === 0 ? (
              <p className="muted" role="status">
                {t("settings.search_none", { query })}
              </p>
            ) : (
              matches.map((s) => (
                <div key={s.id}>
                  <p className="settings-shell__crumb">{catLabel(s.category)}</p>
                  {render(s.id)}
                </div>
              ))
            )
          ) : (
            <>
              <h2 className="settings-shell__heading">{catLabel(category)}</h2>
              {sectionsOf(category).map((s) => (
                <div key={s.id}>{render(s.id)}</div>
              ))}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
