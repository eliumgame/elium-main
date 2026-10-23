/**
 * Appareils et sessions : liste des connexions actives du compte (navigateur,
 * adresse, dernière activité) avec révocation d'une session ou de toutes les
 * autres. Réutilise GET/DELETE /users/me/sessions du serveur.
 */
import { useCallback, useEffect, useState } from "react";
import { MonitorSmartphone, LogOut, Trash2 } from "lucide-react";
import { useDrive } from "../session";
import type { DeviceSession } from "../api";

/** « Chrome sur Windows » à partir d'un user-agent (indicatif). */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navigateur";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} sur ${os}` : browser;
}

export default function DevicesSection() {
  const d = useDrive();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSessions((await d.api.listSessions()).sessions);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chargement impossible.");
    }
  }, [d.api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action impossible.");
    } finally {
      setBusy(false);
    }
  };

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <div className="dc-security__passkeys" data-testid="devices-section">
      <div className="dc-security__pk-head">
        <h3 className="dc-security__pk-title">
          <MonitorSmartphone size={16} /> Appareils et sessions
        </h3>
        <button
          className="elx-mini"
          disabled={busy || others === 0}
          onClick={() => void run(() => d.api.revokeOtherSessions())}
        >
          <LogOut size={14} /> Déconnecter les autres appareils
        </button>
      </div>
      <p className="muted">
        Les appareils connectés à votre compte. Révoquez ceux que vous ne reconnaissez pas : leur session s'arrête au
        prochain rafraîchissement (au plus quelques minutes).
      </p>
      {err && <p className="dc-error">{err}</p>}
      {sessions && sessions.length === 0 && <p className="muted dc-security__pk-empty">Aucune session active.</p>}
      <ul className="dc-security__pk-list">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="dc-security__pk-item">
            <MonitorSmartphone size={15} />
            <span className="dc-security__pk-name">
              {describeDevice(s.userAgent)}
              {s.current && <span className="badge badge--success"> cet appareil</span>}
            </span>
            <span className="muted dc-security__pk-date">
              {s.ip || "adresse inconnue"} · actif {new Date(s.lastSeenAt ?? s.createdAt).toLocaleString("fr")}
            </span>
            {!s.current && (
              <button
                className="elx-icon elx-icon--danger"
                title="Révoquer cette session"
                disabled={busy}
                onClick={() => void run(() => d.api.revokeSession(s.id))}
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
