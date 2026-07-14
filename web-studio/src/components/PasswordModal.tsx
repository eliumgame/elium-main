import { useRef, useState } from "react";
import { KeyRound, Paperclip, X } from "lucide-react";
import { Modal, Button, Field } from "../ui/components";

export interface SecretResult {
  password: string;
  keyfile?: Uint8Array;
  keyfileName?: string;
}

export default function PasswordModal({
  title,
  mode,
  allowKeyfile = false,
  confirmHint = "4 caractères minimum. Sans lui, le document chiffré est irrécupérable.",
  onSubmit,
  onCancel,
}: {
  title: string;
  mode: "set" | "enter";
  /** Show an optional keyfile (second factor) picker. */
  allowKeyfile?: boolean;
  /** Hint under the confirmation field in "set" mode — override for non-document secrets (e.g. the local vault). */
  confirmHint?: string;
  onSubmit: (result: SecretResult) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [keyfile, setKeyfile] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasKf = !!keyfile;
  const pwValidSet = pw.length >= 4 && pw === pw2;
  // A keyfile alone is enough: with one, the password becomes optional (eliumkey unlock).
  const ok = mode === "enter" ? pw.length > 0 || hasKf : hasKf ? pw.length === 0 || pwValidSet : pwValidSet;
  const submit = () => ok && onSubmit({ password: pw, keyfile: keyfile?.bytes, keyfileName: keyfile?.name });

  const pickKeyfile = async (f: File | undefined) => {
    if (!f) return;
    setKeyfile({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Annuler</Button>
          <Button disabled={!ok} onClick={submit}>Valider</Button>
        </>
      }
    >
      <Field label={hasKf ? "Mot de passe (optionnel — fichier-clé fourni)" : "Mot de passe"}>
        <input
          className="input"
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) submit(); }}
        />
      </Field>
      {mode === "set" && (!hasKf || pw.length > 0) && (
        <Field label="Confirmer le mot de passe" hint={confirmHint}>
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
      )}

      {allowKeyfile && (
        <Field
          label="Fichier-clé (eliumkey)"
          hint={
            mode === "set"
              ? "Fichier-clé seul = ouverture SANS mot de passe. Vous pouvez aussi le combiner avec un mot de passe. Conservez-le : sans lui, le document est irrécupérable."
              : "S'il y a un fichier-clé, fournissez-le — le mot de passe devient alors inutile."
          }
        >
          {keyfile ? (
            <div className="keyfile-chip">
              <KeyRound size={14} />
              <span className="keyfile-chip__name">{keyfile.name}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Retirer le fichier-clé"
                onClick={() => { setKeyfile(null); if (fileRef.current) fileRef.current.value = ""; }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip size={14} /> Choisir un fichier-clé…
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => pickKeyfile(e.target.files?.[0])}
          />
        </Field>
      )}
    </Modal>
  );
}
