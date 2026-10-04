import { Save, Eye, Pencil, Home, Settings, Loader2, MoreHorizontal, PanelRight } from "lucide-react";
import Menu, { type MenuItem } from "../ui/Menu";
import { useMediaQuery } from "../studio/useMediaQuery";
import { Button } from "../ui/components";
import StatusBadges from "./StatusBadges";
import type { Studio } from "../studio/types";
import { useI18n } from "../i18n";

export default function TopBar({
  studio,
  inspectorOpen,
  onToggleInspector,
}: {
  studio: Studio;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
}) {
  const { t } = useI18n();
  // Écran étroit : les actions secondaires passent dans un menu « Plus », seul « Enregistrer » / « Modifier » reste visible.
  const compact = useMediaQuery("(max-width: 640px)");
  const moreItems: MenuItem[] = [
    { id: "settings", label: t("home.settings"), icon: <Settings size={15} />, onSelect: () => studio.openSettings() },
    ...(onToggleInspector
      ? [
          {
            id: "panel",
            label: inspectorOpen ? "Fermer le panneau latéral" : "Panneau latéral (signatures, commentaires…)",
            icon: <PanelRight size={15} />,
            onSelect: onToggleInspector,
          },
        ]
      : []),
    studio.editable
      ? { id: "preview", label: t("topbar.preview"), icon: <Eye size={15} />, onSelect: () => studio.toViewer() }
      : { id: "home", label: t("topbar.home"), icon: <Home size={15} />, onSelect: () => studio.goHome() },
  ];
  return (
    <header className="topbar">
      <div className="topbar__left">
        <button className="brand brand--sm" onClick={() => studio.goHome()} title={t("topbar.home")}>
          <img src="/elium-logo.svg" alt="Elium" className="brand__logo" width={22} height={22} />
        </button>
        {studio.editable ? (
          <input
            className="title-input"
            value={studio.file.manifest.title}
            onChange={(e) => studio.setTitle(e.target.value)}
            placeholder={t("topbar.title_placeholder")}
            aria-label={t("topbar.title_placeholder")}
          />
        ) : (
          <span className="title-input title-input--ro">{studio.file.manifest.title}</span>
        )}
      </div>

      <div className="topbar__center">
        <StatusBadges studio={studio} />
      </div>

      <div className="topbar__right">
        {compact && <Menu label="Plus d’actions" trigger={<MoreHorizontal size={18} />} items={moreItems} />}
        {!compact && (
          <button
            className="icon-btn"
            onClick={() => studio.openSettings()}
            title={t("home.settings")}
            aria-label={t("home.settings")}
          >
            <Settings size={18} />
          </button>
        )}
        {/* Les libellés sont dans un span pour pouvoir disparaître sur très
            petit écran sans perdre l'info-bulle ni le nom accessible. */}
        {studio.editable ? (
          <>
            {!compact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => studio.toViewer()}
                title={t("topbar.preview_hint")}
                aria-label={t("topbar.preview")}
              >
                <Eye size={16} /> <span className="eb__label">{t("topbar.preview")}</span>
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => studio.save()}
              disabled={studio.busy}
              title={t("common.save")}
              aria-label={studio.busy ? t("topbar.saving") : t("common.save")}
            >
              {studio.busy ? <Loader2 size={16} className="icon-spin" /> : <Save size={16} />}{" "}
              <span className="eb__label">{studio.busy ? t("topbar.saving") : t("common.save")}</span>
            </Button>
          </>
        ) : (
          <>
            {!compact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => studio.goHome()}
                title={t("topbar.home")}
                aria-label={t("topbar.home")}
              >
                <Home size={16} /> <span className="eb__label">{t("topbar.home")}</span>
              </Button>
            )}
            <Button size="sm" onClick={() => studio.toEditor()} title={t("topbar.edit")} aria-label={t("topbar.edit")}>
              <Pencil size={16} /> <span className="eb__label">{t("topbar.edit")}</span>
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
