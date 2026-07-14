/** Elium design-system primitives: Button, Badge, Modal, Alert, Tabs, fields. */
import { useEffect, useRef } from "react";
import { X, Info, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";

type Accent = "neutral" | "info" | "success" | "warning" | "danger";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`eb eb--${variant} eb--${size} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Badge({ accent = "neutral", children }: { accent?: Accent; children: React.ReactNode }) {
  return <span className={`badge badge--${accent}`}>{children}</span>;
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: Accent;
  title?: string;
  children?: React.ReactNode;
}) {
  const icon = {
    info: <Info size={16} />,
    success: <CheckCircle2 size={16} />,
    warning: <AlertTriangle size={16} />,
    danger: <ShieldAlert size={16} />,
    neutral: <Info size={16} />,
  }[tone];
  return (
    <div className={`alert alert--${tone}`}>
      <span className="alert__icon">{icon}</span>
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        {children && <div className="alert__text">{children}</div>}
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Accessibilité : piège le focus dans la modale, ferme à Échap, et rend le
  // focus à l'élément déclencheur en sortant (charte §12.4 / §13).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () =>
      card
        ? Array.from(card.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          )).filter((el) => el.offsetParent !== null)
        : [];
    (focusables()[0] ?? card)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={cardRef} className={`modal-card ${wide ? "modal-card--wide" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`tab ${active === t.id ? "is-active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {hint && <div className="empty-state__hint">{hint}</div>}
    </div>
  );
}
