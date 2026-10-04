/**
 * Sections simples des Réglages : Général, Apparence, Édition, Polices (accès au
 * gestionnaire), À propos.
 */
import { useEffect, useState } from "react";
import { BookOpen, Moon, Sun, Type } from "lucide-react";
import { Button } from "../../ui/components";
import { LOCALES, setLocale, useI18n, type Locale } from "../../i18n";
import { allFontNames } from "../../ui/fonts";
import { useFontsVersion } from "../../ui/useFonts";
import { listUserFonts } from "../../ui/font-library";
import type { Theme } from "../../ui/theme";
import { setPrefs, usePrefs, type Density, type StartupView } from "../../settings/prefs";
import { SectionCard } from "./parts";

const LOCALE_NAMES: Record<Locale, string> = { fr: "Français", en: "English" };

export function LanguageSection() {
  const { t, locale } = useI18n();
  return (
    <SectionCard id="language" titleKey="settings.sec.language">
      <select
        className="settings__select"
        value={locale}
        aria-label={t("settings.language_label")}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
      <p className="muted">{t("settings.language_hint")}</p>
    </SectionCard>
  );
}

export function StartupSection() {
  const { t } = useI18n();
  const prefs = usePrefs();
  return (
    <SectionCard id="startup" titleKey="settings.sec.startup">
      <label className="field">
        <span className="field__label">{t("settings.startup_view")}</span>
        <select
          className="settings__select"
          value={prefs.startupView}
          onChange={(e) => setPrefs({ startupView: e.target.value as StartupView })}
        >
          <option value="home">{t("shell.nav.home")}</option>
          <option value="library">{t("shell.nav.library")}</option>
          <option value="recent">{t("shell.nav.recent")}</option>
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t("settings.recent_count")}</span>
        <input
          className="settings__input"
          type="number"
          min={4}
          max={24}
          value={prefs.recentCount}
          onChange={(e) => setPrefs({ recentCount: Number(e.target.value) })}
        />
        <span className="field__hint">{t("settings.recent_count_hint")}</span>
      </label>
    </SectionCard>
  );
}

export function ThemeSection({ theme, onSetTheme }: { theme: Theme; onSetTheme: (t: Theme) => void }) {
  const { t } = useI18n();
  return (
    <SectionCard id="theme" titleKey="settings.sec.theme">
      <div className="theme-seg" role="group" aria-label={t("settings.theme_label")}>
        <Button
          variant={theme === "light" ? "primary" : "outline"}
          size="sm"
          aria-pressed={theme === "light"}
          onClick={() => onSetTheme("light")}
        >
          <Sun size={15} /> {t("settings.theme_light")}
        </Button>
        <Button
          variant={theme === "dark" ? "primary" : "outline"}
          size="sm"
          aria-pressed={theme === "dark"}
          onClick={() => onSetTheme("dark")}
        >
          <Moon size={15} /> {t("settings.theme_dark")}
        </Button>
      </div>
    </SectionCard>
  );
}

export function DensitySection() {
  const { t } = useI18n();
  const prefs = usePrefs();
  return (
    <SectionCard id="density" titleKey="settings.sec.density">
      <div className="theme-seg" role="group" aria-label={t("settings.density_label")}>
        {(["comfortable", "compact"] as Density[]).map((d) => (
          <Button
            key={d}
            variant={prefs.density === d ? "primary" : "outline"}
            size="sm"
            aria-pressed={prefs.density === d}
            onClick={() => setPrefs({ density: d })}
          >
            {t(d === "comfortable" ? "settings.density_comfortable" : "settings.density_compact")}
          </Button>
        ))}
      </div>
      <p className="muted">{t("settings.density_hint")}</p>
    </SectionCard>
  );
}

export function EditDefaultsSection() {
  const { t } = useI18n();
  const prefs = usePrefs();
  useFontsVersion(); // la liste suit les polices importées
  return (
    <SectionCard id="edit_defaults" titleKey="settings.sec.edit_defaults">
      <label className="field">
        <span className="field__label">{t("settings.default_font")}</span>
        <select
          className="settings__select"
          value={prefs.defaultFont}
          onChange={(e) => setPrefs({ defaultFont: e.target.value })}
        >
          <option value="">{t("settings.default_font_template")}</option>
          {allFontNames().map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t("settings.default_size")}</span>
        <select
          className="settings__select"
          value={prefs.defaultFontSize}
          onChange={(e) => setPrefs({ defaultFontSize: Number(e.target.value) })}
        >
          <option value={0}>{t("settings.default_font_template")}</option>
          {[9, 10, 11, 12, 13, 14, 16, 18, 20].map((n) => (
            <option key={n} value={n}>
              {n} px
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{t("settings.default_hint")}</p>
    </SectionCard>
  );
}

export function EditAutosaveSection() {
  const { t, tn } = useI18n();
  const prefs = usePrefs();
  return (
    <SectionCard id="edit_autosave" titleKey="settings.sec.edit_autosave">
      <label className="field">
        <span className="field__label">{t("settings.autosave_every")}</span>
        <input
          className="settings__input"
          type="number"
          min={1}
          max={60}
          value={prefs.autosaveSeconds}
          onChange={(e) => setPrefs({ autosaveSeconds: Number(e.target.value) })}
        />
        <span className="field__hint">{tn("settings.autosave_hint", prefs.autosaveSeconds)}</span>
      </label>
    </SectionCard>
  );
}

export function EditSpellSection() {
  const { t } = useI18n();
  const [lang, setLang] = useState<"fr" | "en" | null>(null);
  const [native, setNative] = useState(false);
  // Le correcteur vit dans le module éditeur (lourd) : chargé à la demande, pas dans le paquet principal.
  useEffect(() => {
    let alive = true;
    void import("../../editor/proofingExtension").then((m) => {
      m.loadProofingPrefs();
      const s = m.proofingSettings();
      if (alive) {
        setLang(s.lang);
        setNative(s.native);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <SectionCard id="edit_spell" titleKey="settings.sec.edit_spell">
      <label className="field">
        <span className="field__label">{t("settings.spell_lang")}</span>
        <select
          className="settings__select"
          value={lang ?? "fr"}
          disabled={lang === null}
          onChange={(e) => {
            const v = e.target.value as "fr" | "en";
            setLang(v);
            void import("../../editor/proofingExtension").then((m) => m.setDictionaryLang(v));
          }}
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="ws-check">
        <input
          type="checkbox"
          checked={native}
          disabled={lang === null}
          onChange={(e) => {
            setNative(e.target.checked);
            void import("../../editor/proofingExtension").then((m) => m.setNativeSpelling(e.target.checked));
          }}
        />{" "}
        {t("settings.spell_native")}
      </label>
      <p className="muted">{t("settings.spell_hint")}</p>
    </SectionCard>
  );
}

export function FontsSection({ onOpenManager }: { onOpenManager: () => void }) {
  const { t, tn } = useI18n();
  const version = useFontsVersion();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void listUserFonts()
      .then((f) => alive && setCount(f.length))
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, [version]);
  return (
    <SectionCard id="fonts_manager" titleKey="settings.sec.fonts_manager" icon={<Type size={15} />}>
      <p className="muted">{t("settings.fonts_body")}</p>
      {count !== null && <p>{tn("settings.fonts_count", count)}</p>}
      <div className="settings__row">
        <Button variant="outline" size="sm" onClick={onOpenManager}>
          <Type size={14} /> {t("settings.fonts_manage")}
        </Button>
      </div>
    </SectionCard>
  );
}

export function AboutSection({ onOpenDocumentation }: { onOpenDocumentation: () => void }) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/__version__")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { installed?: string | null } | null) => alive && setVersion(j?.installed ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return (
    <SectionCard id="about_app" titleKey="settings.sec.about_app">
      <p>
        <strong>Elium</strong>
        {version ? ` v${version}` : ""}
      </p>
      <p className="muted">{t("footer.tagline")}</p>
      <div className="settings__row">
        <Button variant="outline" size="sm" onClick={onOpenDocumentation}>
          <BookOpen size={14} /> {t("settings.open_docs")}
        </Button>
      </div>
    </SectionCard>
  );
}
