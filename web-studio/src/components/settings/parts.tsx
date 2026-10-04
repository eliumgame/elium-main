/** Éléments communs des sections de Réglages. */
import { useI18n, type MessageKey } from "../../i18n";

export function SectionCard({
  id,
  titleKey,
  icon,
  children,
}: {
  id: string;
  titleKey: MessageKey;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="settings__section" id={`settings-${id}`} aria-labelledby={`settings-${id}-h`}>
      <h3 className="settings__title" id={`settings-${id}-h`}>
        {icon} {t(titleKey)}
      </h3>
      {children}
    </section>
  );
}
