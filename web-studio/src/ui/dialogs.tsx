/**
 * Dialogues applicatifs (remplacent window.prompt / window.confirm).
 *
 * Fournit un contexte exposant `prompt()` et `confirm()` qui renvoient une
 * Promise, rendus via la primitive `Modal` (stylée, focus-trap, Échap, charte).
 * Utilisation : `const v = await prompt({ title, label })` / `if (await confirm(...))`.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Modal, Button, Field } from "./components";

export interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  confirmLabel?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
}

type Request =
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; opts: AlertOptions; resolve: () => void };

interface DialogsApi {
  prompt: (opts: PromptOptions) => Promise<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const DialogsContext = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs doit être utilisé dans un <DialogsProvider>");
  return ctx;
}

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? "");
        setRequest({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest({ kind: "confirm", opts, resolve });
      }),
    [],
  );

  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) => {
        setRequest({ kind: "alert", opts, resolve });
      }),
    [],
  );

  // Donne le focus au champ de saisie (le Modal focalise sinon son bouton de
  // fermeture) ; rAF passe après l'effet de focus-trap du Modal.
  useEffect(() => {
    if (request?.kind !== "prompt") return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    });
    return () => cancelAnimationFrame(id);
  }, [request]);

  const settle = (result?: string | null | boolean) => {
    setRequest((cur) => {
      if (cur?.kind === "prompt") (cur.resolve as (v: string | null) => void)(result as string | null);
      else if (cur?.kind === "confirm") (cur.resolve as (v: boolean) => void)(result as boolean);
      else if (cur?.kind === "alert") (cur.resolve as () => void)();
      return null;
    });
  };

  return (
    <DialogsContext.Provider value={{ prompt, confirm, alert }}>
      {children}

      {request?.kind === "prompt" && (
        <Modal
          title={request.opts.title}
          onClose={() => settle(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => settle(null)}>Annuler</Button>
              <Button variant="primary" onClick={() => settle(value)}>
                {request.opts.confirmLabel ?? "Valider"}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              settle(value);
            }}
          >
            <Field label={request.opts.label ?? ""} hint={request.opts.hint}>
              {request.opts.multiline ? (
                <textarea
                  ref={inputRef}
                  className="input"
                  rows={4}
                  value={value}
                  placeholder={request.opts.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                />
              ) : (
                <input
                  ref={inputRef}
                  className="input"
                  value={value}
                  placeholder={request.opts.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </Field>
          </form>
        </Modal>
      )}

      {request?.kind === "confirm" && (
        <Modal
          title={request.opts.title}
          onClose={() => settle(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => settle(false)}>
                {request.opts.cancelLabel ?? "Annuler"}
              </Button>
              <Button variant={request.opts.danger ? "danger" : "primary"} onClick={() => settle(true)}>
                {request.opts.confirmLabel ?? "Confirmer"}
              </Button>
            </>
          }
        >
          {request.opts.message && (
            <p style={{ margin: 0, color: "var(--text-soft)", lineHeight: 1.55, whiteSpace: "pre-line" }}>
              {request.opts.message}
            </p>
          )}
        </Modal>
      )}

      {request?.kind === "alert" && (
        <Modal
          title={request.opts.title}
          onClose={() => settle()}
          footer={
            <Button variant="primary" onClick={() => settle()}>
              {request.opts.confirmLabel ?? "OK"}
            </Button>
          }
        >
          {request.opts.message && (
            <p style={{ margin: 0, color: "var(--text-soft)", lineHeight: 1.55, whiteSpace: "pre-line" }}>
              {request.opts.message}
            </p>
          )}
        </Modal>
      )}
    </DialogsContext.Provider>
  );
}
