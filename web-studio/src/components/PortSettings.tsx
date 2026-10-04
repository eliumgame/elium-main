/**
 * Port d'écoute du serveur local d'Elium (application de bureau). Affiche le
 * port courant, la plage automatique 3000-3100, les ports libres/occupés,
 * accepte un port précis (1024-65535, validé) ou « automatique », et propose le
 * redémarrage — le changement n'est effectif qu'au prochain démarrage.
 *
 * Hors lanceur (navigateur, PWA, mode dev) les routes n'existent pas : le
 * composant l'explique au lieu de proposer un réglage sans effet.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button, Alert } from "../ui/components";
import { useI18n } from "../i18n";
import {
  AUTO_RANGE,
  PORT_MAX,
  PORT_MIN,
  describePortState,
  fetchPorts,
  inAutoRange,
  isKnownBusy,
  reloadWhenServerBack,
  restartLauncher,
  setLauncherPort,
  validatePortInput,
  type PortInfo,
} from "../settings/launcher";

export default function PortSettings() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<PortInfo | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** undefined = rien d'enregistré dans cette session ; null = « automatique » enregistré. */
  const [saved, setSaved] = useState<number | null | undefined>(undefined);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    void fetchPorts().then((i) => {
      setInfo(i);
      setLoading(false);
    });
  }, []);
  useEffect(load, [load]);

  if (loading && !info) {
    return (
      <p className="muted" role="status">
        <Loader2 size={14} className="icon-spin" /> {t("port.loading")}
      </p>
    );
  }
  if (!info) {
    return (
      <Alert tone="info" title={t("port.unavailable_title")}>
        {t("port.unavailable_body")}
      </Alert>
    );
  }

  const state = describePortState(info);
  const verdict = input.trim() === "" ? null : validatePortInput(input);
  const busyKnown = verdict?.ok ? isKnownBusy(info, verdict.port) : false;
  const reasonText = (r: "empty" | "not_a_number" | "out_of_range") =>
    r === "out_of_range"
      ? t("port.err_range", { min: PORT_MIN, max: PORT_MAX })
      : r === "not_a_number"
        ? t("port.err_nan")
        : t("port.err_empty");

  const choose = async (port: number | null) => {
    setError(null);
    setBusy(true);
    const r = await setLauncherPort(port);
    setBusy(false);
    if (r.ok) {
      setSaved(r.port);
      setInput("");
      load();
    } else {
      setError(r.reason === "busy" ? t("port.err_busy") : t("port.err_save"));
    }
  };

  const restart = async () => {
    setRestarting(true);
    const ok = await restartLauncher();
    if (!ok) {
      setRestarting(false);
      setError(t("port.err_restart"));
      return;
    }
    reloadWhenServerBack();
  };

  return (
    <div className="port">
      <p className="muted">
        {state.kind === "auto" && t("port.state_auto", { port: state.current, from: AUTO_RANGE[0], to: AUTO_RANGE[1] })}
        {state.kind === "pinned" && t("port.state_pinned", { port: state.current })}
        {state.kind === "fallback" && t("port.state_fallback", { port: state.current, wanted: state.configured })}
      </p>
      <p className="muted">{t("port.loopback")}</p>

      <div
        className="port__grid"
        role="group"
        aria-label={t("port.range_label", { from: AUTO_RANGE[0], to: AUTO_RANGE[1] })}
      >
        {info.ports.map(({ port, free }) => {
          const chosen = info.configured === port;
          const current = info.current === port;
          return (
            <button
              key={port}
              type="button"
              className={`port__cell ${chosen ? "is-chosen" : ""} ${free || current ? "" : "is-busy"}`}
              disabled={busy || chosen || (!free && !current)}
              title={
                current
                  ? t("port.cell_current", { port })
                  : free
                    ? t("port.cell_use", { port })
                    : t("port.cell_busy", { port })
              }
              onClick={() => void choose(port)}
            >
              {port}
              {current && <span className="port__tag">{t("port.tag_current")}</span>}
              {!free && !current && <span className="port__tag">{t("port.tag_busy")}</span>}
            </button>
          );
        })}
      </div>

      <form
        className="port__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (verdict?.ok && !busyKnown) void choose(verdict.port);
        }}
      >
        <label className="field">
          <span className="field__label">{t("port.custom_label", { min: PORT_MIN, max: PORT_MAX })}</span>
          <input
            className="input"
            inputMode="numeric"
            value={input}
            placeholder={t("port.custom_placeholder")}
            aria-invalid={verdict ? !verdict.ok || busyKnown : undefined}
            aria-describedby="port-hint"
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !verdict?.ok || busyKnown}>
          {busy ? <Loader2 size={14} className="icon-spin" /> : null} {t("port.apply")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || info.configured == null}
          onClick={() => void choose(null)}
          title={t("port.auto_hint")}
        >
          <RefreshCw size={14} /> {t("port.back_to_auto")}
        </Button>
      </form>
      <p
        id="port-hint"
        className={`muted ${verdict && (!verdict.ok || busyKnown) ? "port__invalid" : ""}`}
        role="status"
      >
        {verdict && !verdict.ok && reasonText(verdict.reason)}
        {verdict?.ok && busyKnown && t("port.err_busy")}
        {verdict?.ok &&
          !busyKnown &&
          !inAutoRange(verdict.port) &&
          t("port.outside_auto", { from: AUTO_RANGE[0], to: AUTO_RANGE[1] })}
      </p>

      <Alert tone="warning">{t("port.data_warning")}</Alert>

      {error && (
        <Alert tone="danger" title={t("port.err_title")}>
          {error}
        </Alert>
      )}
      {saved !== undefined && (
        <Alert tone="success" title={saved === null ? t("port.saved_auto") : t("port.saved_port", { port: saved })}>
          {t("port.effective_next")}{" "}
          <Button size="sm" disabled={restarting} onClick={() => void restart()}>
            {restarting ? <Loader2 size={14} className="icon-spin" /> : null} {t("port.restart_now")}
          </Button>
        </Alert>
      )}
    </div>
  );
}
