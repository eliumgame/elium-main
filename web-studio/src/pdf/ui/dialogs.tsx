import { useEffect, useRef, useState } from "react";
import { Check, Download, Eraser, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Modal } from "../../ui/components";
import type {
  Bates,
  DocMetadata,
  HeaderFooter,
  InitialView,
  LinkAction,
  LinkStyle,
  MeasureScale,
  Watermark,
} from "../model/types";
import type { Permissions } from "../ops/security";
import { ALL_PERMISSIONS } from "../ops/security";
import type { DocInfo } from "../core/engine";
import { OCR_LANGUAGES, type OcrLanguage } from "../ops/ocr";
import { PAGE_SIZES } from "../ops/organize";
import {
  SIGNATURE_FONTS,
  cleanImportedSignature,
  strokesToPng,
  typedSignatureToPng,
  type SavedSignature,
} from "../ops/sign";
import type { Pt } from "../core/coords";
import { formatBytes } from "../ops/optimize";
import type { BuildOptions } from "../ops/save";
import { AFTER_REDACTION, type HiddenInfoOptions } from "../ops/redact";
import { REDACT_PATTERNS } from "../ops/redactpatterns";
import type { ComparisonReport } from "../ops/compare";

/** Every modal the PDF workspace can open, kept together so they share styling. */

// ---------------------------------------------------------------------------
// « Enregistrer sous » / « Enregistrer une copie »
// ---------------------------------------------------------------------------

/** Options « Enregistrer sous… » can change; any of them makes the result a separate copy. */
export type SaveAsOptions = Pick<
  BuildOptions,
  "interactiveAnnots" | "flattenForms" | "applyRedactions" | "sanitise" | "optimise" | "optimiseOptions"
>;

/** True when these options produce a transformed copy rather than the document itself. */
export function isCopyOptions(o: SaveAsOptions): boolean {
  return !o.interactiveAnnots || o.flattenForms || o.sanitise || o.optimise;
}

export function SaveDialog({
  fileName,
  options: initial,
  hasRedactions,
  hasForm,
  signed,
  inPlace,
  onConfirm,
  onClose,
}: {
  fileName: string;
  options: SaveAsOptions;
  hasRedactions: boolean;
  hasForm: boolean;
  /** The document carries a digital signature. */
  signed: boolean;
  /** Files can be written in place (File System Access); false = the result is downloaded. */
  inPlace: boolean;
  onConfirm: (name: string, options: SaveAsOptions) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(fileName.replace(/\.pdf$/i, ""));
  const [options, setOptions] = useState<SaveAsOptions>(initial);
  const onChange = (patch: Partial<SaveAsOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const copy = isCopyOptions(options);
  const full =
    options.optimise || options.sanitise || options.flattenForms || (hasRedactions && options.applyRedactions);
  return (
    <Modal
      title={copy ? "Enregistrer une copie" : "Enregistrer sous"}
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            onClick={() => onConfirm(`${name.trim() || "document"}.pdf`, options)}
          >
            <Download size={14} /> {inPlace ? "Choisir l'emplacement…" : "Télécharger"}
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Nom du fichier</span>
          <span className="pdfx-form__suffixed">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <em>.pdf</em>
          </span>
        </label>

        <fieldset className="pdfx-form__set">
          <legend>Annotations</legend>
          <label className="pdfx-radio">
            <input
              type="radio"
              checked={options.interactiveAnnots}
              onChange={() => onChange({ interactiveAnnots: true })}
            />
            <span>
              <b>Modifiables</b>
              <small>
                Vraies annotations PDF : Acrobat et Aperçu les affichent dans leur volet de commentaires, avec auteur,
                date et fils de discussion.
              </small>
            </span>
          </label>
          <label className="pdfx-radio">
            <input
              type="radio"
              checked={!options.interactiveAnnots}
              onChange={() => onChange({ interactiveAnnots: false })}
            />
            <span>
              <b>Aplaties</b>
              <small>Fusionnées dans la page. Rendu identique partout, mais plus modifiables.</small>
            </span>
          </label>
        </fieldset>

        {hasForm && (
          <label className="pdfx-check pdfx-check--block">
            <input
              type="checkbox"
              checked={options.flattenForms}
              onChange={(e) => onChange({ flattenForms: e.target.checked })}
            />
            <span>
              Aplatir les champs de formulaire<small>Les valeurs deviennent du contenu figé.</small>
            </span>
          </label>
        )}

        {hasRedactions && (
          <label className="pdfx-check pdfx-check--block pdfx-check--warn">
            <input
              type="checkbox"
              checked={options.applyRedactions}
              onChange={(e) => onChange({ applyRedactions: e.target.checked })}
            />
            <span>
              Appliquer le caviardage<small>Le contenu marqué est supprimé définitivement du fichier produit.</small>
            </span>
          </label>
        )}

        <label className="pdfx-check pdfx-check--block">
          <input
            type="checkbox"
            checked={options.sanitise}
            onChange={(e) => onChange({ sanitise: e.target.checked })}
          />
          <span>
            Assainir<small>Retirer métadonnées, JavaScript, pièces jointes et actions automatiques.</small>
          </span>
        </label>

        <label className="pdfx-check pdfx-check--block">
          <input
            type="checkbox"
            checked={options.optimise}
            onChange={(e) => onChange({ optimise: e.target.checked })}
          />
          <span>
            Optimiser la taille
            <small>Réécrit tout le fichier, rééchantillonne les images et recompresse les flux.</small>
          </span>
        </label>
        {options.optimise && (
          <fieldset className="pdfx-form__set">
            <legend>Optimisation</legend>
            <label className="pdfx-form__row">
              <span>Résolution maximale des images</span>
              <select
                value={options.optimiseOptions?.imageDpi ?? 150}
                onChange={(e) =>
                  onChange({ optimiseOptions: { ...options.optimiseOptions, imageDpi: Number(e.target.value) } })
                }
              >
                <option value={72}>72 ppp (écran)</option>
                <option value={96}>96 ppp</option>
                <option value={150}>150 ppp (lecture, e-mail)</option>
                <option value={200}>200 ppp</option>
                <option value={300}>300 ppp (impression)</option>
              </select>
            </label>
            <label className="pdfx-form__row">
              <span>Qualité JPEG</span>
              <select
                value={options.optimiseOptions?.jpegQuality ?? 0.72}
                onChange={(e) =>
                  onChange({ optimiseOptions: { ...options.optimiseOptions, jpegQuality: Number(e.target.value) } })
                }
              >
                <option value={0.5}>Basse</option>
                <option value={0.72}>Moyenne</option>
                <option value={0.85}>Haute</option>
                <option value={0.95}>Maximale</option>
              </select>
            </label>
            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={options.optimiseOptions?.downsampleFlate ?? true}
                onChange={(e) =>
                  onChange({ optimiseOptions: { ...options.optimiseOptions, downsampleFlate: e.target.checked } })
                }
              />
              Rééchantillonner aussi les images sans perte (PNG)
            </label>
            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={options.optimiseOptions?.dedupe ?? true}
                onChange={(e) =>
                  onChange({ optimiseOptions: { ...options.optimiseOptions, dedupe: e.target.checked } })
                }
              />
              Ne garder qu'une fois les images, polices et objets identiques
            </label>
            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={options.optimiseOptions?.dropThumbnails ?? true}
                onChange={(e) =>
                  onChange({
                    optimiseOptions: {
                      ...options.optimiseOptions,
                      dropThumbnails: e.target.checked,
                      dropPieceInfo: e.target.checked,
                    },
                  })
                }
              />
              Supprimer les vignettes et données privées d'applications
            </label>
          </fieldset>
        )}

        <p className="pdfx-form__note">
          {copy
            ? "Ces options produisent une copie transformée : le document ouvert reste associé à son fichier actuel."
            : "Le document ouvert sera ensuite associé au nouveau fichier : Ctrl+S y enregistrera."}{" "}
          {full
            ? "Le fichier sera entièrement réécrit (les révisions précédentes ne sont pas conservées)."
            : "Enregistrement incrémental : le contenu d'origine est conservé tel quel, seules vos modifications sont ajoutées."}
          {signed && full ? " La signature électronique du document ne survivra pas à la réécriture." : ""}
          {!inPlace
            ? " Votre navigateur ne permet pas d'écrire directement un fichier : le résultat sera téléchargé."
            : ""}
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

export const PERMISSION_LABELS: [keyof Permissions, string][] = [
  ["print", "Impression"],
  ["printHighRes", "Impression haute définition"],
  ["copy", "Copie du texte et des images"],
  ["modify", "Modification du document"],
  ["annotate", "Ajout de commentaires"],
  ["fillForms", "Remplissage des formulaires"],
  ["assemble", "Assemblage des pages"],
  ["extractForAccessibility", "Extraction pour l'accessibilité"],
];

type PrintLevel = "none" | "low" | "high";
type ChangesLevel = "none" | "assemble" | "forms" | "comments" | "all";

/** Acrobat's « Autorisations » choices as permission bits. */
export function acrobatPermissions(
  print: PrintLevel,
  changes: ChangesLevel,
  copy: boolean,
  access: boolean,
): Permissions {
  return {
    print: print !== "none",
    printHighRes: print === "high",
    modify: changes === "all",
    assemble: changes === "assemble" || changes === "all",
    fillForms: changes === "forms" || changes === "comments" || changes === "all",
    annotate: changes === "comments" || changes === "all",
    copy,
    extractForAccessibility: access || copy,
  };
}

/** A strong random password (the permissions one, when the user did not ask for restrictions). */
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

export function ProtectDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (v: {
    userPassword: string;
    ownerPassword: string;
    permissions: Permissions;
    encryptMetadata: boolean;
  }) => void;
  onClose: () => void;
}) {
  const [needOpen, setNeedOpen] = useState(true);
  const [user, setUser] = useState("");
  const [confirm, setConfirm] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [owner, setOwner] = useState("");
  const [ownerConfirm, setOwnerConfirm] = useState("");
  const [print, setPrint] = useState<PrintLevel>("high");
  const [changes, setChanges] = useState<ChangesLevel>("none");
  const [copy, setCopy] = useState(false);
  const [access, setAccess] = useState(true);
  const [encryptMetadata, setEncryptMetadata] = useState(true);
  const openPw = needOpen ? user : "";
  const strength = passwordStrength(user);
  const problems = [
    needOpen && !user ? "Saisissez le mot de passe d'ouverture." : "",
    needOpen && user && user !== confirm ? "Les deux saisies du mot de passe d'ouverture diffèrent." : "",
    restrict && !owner ? "Saisissez le mot de passe des autorisations." : "",
    restrict && owner && owner !== ownerConfirm ? "Les deux saisies du mot de passe des autorisations diffèrent." : "",
    // Acrobat refuses it: whoever can open the file would then hold every right.
    // Compared as AES-256 hashes them (NFKC): « é » composed or not is the same password.
    restrict && owner && owner.normalize("NFKC") === openPw.normalize("NFKC")
      ? "Le mot de passe des autorisations doit différer de celui d'ouverture."
      : "",
    !needOpen && !restrict ? "Choisissez au moins une protection." : "",
  ].filter(Boolean);

  return (
    <Modal
      title="Protéger par mot de passe"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            disabled={problems.length > 0}
            onClick={() =>
              onConfirm({
                userPassword: openPw,
                // No restriction asked: every right is granted, behind a password nobody knows.
                ownerPassword: restrict ? owner : randomPassword(),
                permissions: restrict ? acrobatPermissions(print, changes, copy, access) : { ...ALL_PERMISSIONS },
                encryptMetadata,
              })
            }
          >
            Protéger
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">
          Chiffrement <b>AES-256</b> (révision 6), celui d'Acrobat X et des versions suivantes.
        </p>
        <label className="pdfx-check">
          <input type="checkbox" checked={needOpen} onChange={(e) => setNeedOpen(e.target.checked)} />
          Exiger un mot de passe pour ouvrir le document
        </label>
        {needOpen && (
          <>
            <label className="pdfx-form__row">
              <span>Mot de passe d'ouverture</span>
              <input type="password" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
            </label>
            <label className="pdfx-form__row">
              <span>Confirmer</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {!!user && (
              <div className={`pdfx-strength pdfx-strength--${strength.level}`}>
                <span style={{ width: `${strength.score}%` }} />
                <em>{strength.label}</em>
              </div>
            )}
          </>
        )}

        <label className="pdfx-check">
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
          Restreindre la modification et l'impression du document
        </label>
        {restrict && (
          <fieldset className="pdfx-form__set">
            <legend>Autorisations</legend>
            <label className="pdfx-form__row">
              <span>Mot de passe des autorisations</span>
              <input type="password" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <label className="pdfx-form__row">
              <span>Confirmer</span>
              <input type="password" value={ownerConfirm} onChange={(e) => setOwnerConfirm(e.target.value)} />
            </label>
            <label className="pdfx-form__row">
              <span>Impression autorisée</span>
              <select value={print} onChange={(e) => setPrint(e.target.value as PrintLevel)}>
                <option value="none">Aucune</option>
                <option value="low">Basse résolution (150 ppp)</option>
                <option value="high">Haute résolution</option>
              </select>
            </label>
            <label className="pdfx-form__row">
              <span>Modifications autorisées</span>
              <select value={changes} onChange={(e) => setChanges(e.target.value as ChangesLevel)}>
                <option value="none">Aucune</option>
                <option value="assemble">Insertion, suppression et rotation des pages</option>
                <option value="forms">Remplissage des champs de formulaire et signature</option>
                <option value="comments">Commentaires, remplissage des champs et signature</option>
                <option value="all">Toutes, sauf l'extraction des pages</option>
              </select>
            </label>
            <label className="pdfx-check">
              <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
              Autoriser la copie de texte, d'images et d'autre contenu
            </label>
            <label className="pdfx-check">
              <input
                type="checkbox"
                checked={access || copy}
                disabled={copy}
                onChange={(e) => setAccess(e.target.checked)}
              />
              Autoriser l'accès au texte pour les lecteurs d'écran
            </label>
          </fieldset>
        )}

        <label className="pdfx-check">
          <input type="checkbox" checked={encryptMetadata} onChange={(e) => setEncryptMetadata(e.target.checked)} />
          Chiffrer aussi les métadonnées
        </label>
        {problems.length > 0 && <p className="pdfx-form__error">{problems[0]}</p>}
        <p className="pdfx-form__note">
          Aucun recouvrement n'est possible : si le mot de passe est perdu, le document est définitivement illisible.
        </p>
      </div>
    </Modal>
  );
}

function passwordStrength(pw: string): { score: number; level: string; label: string } {
  if (!pw) return { score: 0, level: "none", label: "" };
  let score = Math.min(50, pw.length * 4);
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 12;
  if (/[^\w\s]/.test(pw)) score += 18;
  if (pw.length >= 16) score += 10;
  score = Math.min(100, score);
  if (score < 40) return { score, level: "weak", label: "Faible" };
  if (score < 70) return { score, level: "fair", label: "Correct" };
  return { score, level: "strong", label: "Robuste" };
}

export function PasswordPrompt({
  wrong,
  fileName,
  onConfirm,
  onClose,
}: {
  wrong: boolean;
  fileName: string;
  onConfirm: (password: string) => void;
  onClose: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <Modal
      title="Document protégé"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm(pw)} disabled={!pw}>
            Ouvrir
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">« {fileName} » demande un mot de passe pour s'ouvrir.</p>
        <label className="pdfx-form__row">
          <span>Mot de passe</span>
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pw) onConfirm(pw);
            }}
          />
        </label>
        {wrong && <p className="pdfx-form__error">Mot de passe incorrect.</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/** « Supprimer les marques existantes » — shared by the watermark and header dialogs. */
function StripMarksCheck({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className="pdfx-check"
      title="Filigranes, arrière-plans, en-têtes et pieds de page ajoutés auparavant par Elium ou Acrobat"
    >
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      Supprimer d'abord les marques déjà présentes dans le fichier
    </label>
  );
}

export function WatermarkDialog({
  value,
  stripMarks,
  onChange,
  onClose,
}: {
  value: Watermark;
  stripMarks: boolean;
  onChange: (v: Watermark, stripMarks: boolean) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Watermark>(value);
  const [strip, setStrip] = useState(stripMarks);
  const color = draft.mode === "color";
  const set = (patch: Partial<Watermark>) => setDraft((v) => ({ ...v, ...patch }));
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      title="Filigrane"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="eb eb--outline eb--sm"
            onClick={() => {
              onChange({ ...draft, enabled: false }, strip);
              onClose();
            }}
          >
            Retirer
          </button>
          <button
            className="eb eb--primary eb--sm"
            onClick={() => {
              onChange({ ...draft, enabled: true }, strip);
              onClose();
            }}
          >
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-split">
        <div className="pdfx-form">
          <div className="pdfx-segment">
            <button className={draft.mode === "text" ? "is-on" : ""} onClick={() => set({ mode: "text" })}>
              Texte
            </button>
            <button className={draft.mode === "image" ? "is-on" : ""} onClick={() => set({ mode: "image" })}>
              Image
            </button>
            <button
              className={color ? "is-on" : ""}
              onClick={() => set({ mode: "color" })}
              title="Arrière-plan : toute la page teintée, sous le contenu"
            >
              Couleur de fond
            </button>
          </div>

          {color ? null : draft.mode === "text" ? (
            <label className="pdfx-form__row">
              <span>Texte</span>
              <input value={draft.text} onChange={(e) => set({ text: e.target.value })} autoFocus />
            </label>
          ) : (
            <div className="pdfx-form__row">
              <span>Image</span>
              <button className="pdfx-mini" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Choisir…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => set({ src: reader.result as string });
                  reader.readAsDataURL(f);
                }}
              />
            </div>
          )}

          <label className="pdfx-form__row">
            <span>Couleur</span>
            <input
              type="color"
              value={draft.color}
              onChange={(e) => set({ color: e.target.value })}
              disabled={draft.mode === "image"}
            />
          </label>
          <label className="pdfx-form__row">
            <span>Opacité</span>
            <span className="pdfx-insp-inline">
              <input
                type="range"
                min={0.02}
                max={1}
                step={0.02}
                value={draft.opacity}
                onChange={(e) => set({ opacity: Number(e.target.value) })}
              />
              <b>{Math.round(draft.opacity * 100)} %</b>
            </span>
          </label>
          {!color && (
            <>
              <label className="pdfx-form__row">
                <span>Rotation</span>
                <span className="pdfx-insp-inline">
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={1}
                    value={draft.angle}
                    onChange={(e) => set({ angle: Number(e.target.value) })}
                  />
                  <b>{draft.angle}°</b>
                </span>
              </label>
              <label className="pdfx-form__row">
                <span>Échelle</span>
                <span className="pdfx-insp-inline">
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.05}
                    value={draft.scale}
                    onChange={(e) => set({ scale: Number(e.target.value) })}
                  />
                  <b>{draft.scale.toFixed(2)}×</b>
                </span>
              </label>
              <label className="pdfx-form__row">
                <span>Position</span>
                <select
                  value={draft.position}
                  onChange={(e) => set({ position: e.target.value as Watermark["position"] })}
                >
                  <option value="center">Centre</option>
                  <option value="top">Haut</option>
                  <option value="bottom">Bas</option>
                  <option value="topLeft">Haut gauche</option>
                  <option value="topRight">Haut droite</option>
                  <option value="bottomLeft">Bas gauche</option>
                  <option value="bottomRight">Bas droite</option>
                </select>
              </label>
            </>
          )}
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input
              value={draft.pages}
              placeholder="toutes, ou 1-3, 7"
              onChange={(e) => set({ pages: e.target.value })}
            />
          </label>
          {!color && (
            <label className="pdfx-check">
              <input type="checkbox" checked={draft.behind} onChange={(e) => set({ behind: e.target.checked })} />
              Derrière le contenu de la page
            </label>
          )}
          <StripMarksCheck value={strip} onChange={setStrip} />
        </div>

        <div className="pdfx-preview">
          <div
            className="pdfx-preview__page"
            style={
              color
                ? { background: `color-mix(in srgb, ${draft.color} ${Math.round(draft.opacity * 100)}%, white)` }
                : undefined
            }
          >
            <div className="pdfx-preview__lines">
              {Array.from({ length: 14 }, (_, i) => (
                <span key={i} style={{ width: `${55 + ((i * 37) % 40)}%` }} />
              ))}
            </div>
            {!color && (
              <div
                className="pdfx-preview__wm"
                style={{
                  transform: `translate(-50%,-50%) rotate(${-draft.angle}deg) scale(${draft.scale})`,
                  opacity: draft.opacity,
                  color: draft.color,
                  ...previewAnchor(draft.position),
                }}
              >
                {draft.mode === "image" && draft.src ? (
                  <img src={draft.src} alt="" />
                ) : (
                  <b>{draft.text || "FILIGRANE"}</b>
                )}
              </div>
            )}
          </div>
          <span className="pdfx-preview__caption">Aperçu</span>
        </div>
      </div>
    </Modal>
  );
}

function previewAnchor(position: Watermark["position"]): React.CSSProperties {
  const map: Record<Watermark["position"], [string, string]> = {
    center: ["50%", "50%"],
    top: ["50%", "18%"],
    bottom: ["50%", "82%"],
    topLeft: ["24%", "18%"],
    topRight: ["76%", "18%"],
    bottomLeft: ["24%", "82%"],
    bottomRight: ["76%", "82%"],
  };
  const [left, top] = map[position];
  return { left, top };
}

// ---------------------------------------------------------------------------
// Header / footer / Bates
// ---------------------------------------------------------------------------

const TOKENS = ["{page}", "{pages}", "{date}", "{time}", "{title}", "{author}", "{filename}", "{bates}"];

export function HeaderFooterDialog({
  header,
  footer,
  bates,
  stripMarks,
  onChange,
  onClose,
}: {
  header: HeaderFooter;
  footer: HeaderFooter;
  bates: Bates;
  stripMarks: boolean;
  onChange: (v: { header: HeaderFooter; footer: HeaderFooter; bates: Bates; stripMarks: boolean }) => void;
  onClose: () => void;
}) {
  const [strip, setStrip] = useState(stripMarks);
  const [h, setH] = useState(header);
  const [f, setF] = useState(footer);
  const [b, setB] = useState(bates);
  const [tab, setTab] = useState<"header" | "footer" | "bates">("header");
  const band = tab === "header" ? h : f;
  const setBand = (patch: Partial<HeaderFooter>) =>
    tab === "header" ? setH((v) => ({ ...v, ...patch })) : setF((v) => ({ ...v, ...patch }));

  return (
    <Modal
      title="En-tête, pied de page et numérotation"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            onClick={() => {
              onChange({ header: h, footer: f, bates: b, stripMarks: strip });
              onClose();
            }}
          >
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-segment pdfx-segment--wide">
        <button className={tab === "header" ? "is-on" : ""} onClick={() => setTab("header")}>
          En-tête
        </button>
        <button className={tab === "footer" ? "is-on" : ""} onClick={() => setTab("footer")}>
          Pied de page
        </button>
        <button className={tab === "bates" ? "is-on" : ""} onClick={() => setTab("bates")}>
          Numérotation Bates
        </button>
      </div>

      {tab === "bates" ? (
        <div className="pdfx-form">
          <label className="pdfx-check">
            <input type="checkbox" checked={b.enabled} onChange={(e) => setB({ ...b, enabled: e.target.checked })} />
            Activer la numérotation Bates
          </label>
          <label className="pdfx-form__row">
            <span>Préfixe</span>
            <input value={b.prefix} onChange={(e) => setB({ ...b, prefix: e.target.value })} />
          </label>
          <label className="pdfx-form__row">
            <span>Suffixe</span>
            <input value={b.suffix} onChange={(e) => setB({ ...b, suffix: e.target.value })} />
          </label>
          <label className="pdfx-form__row">
            <span>Premier numéro</span>
            <input
              type="number"
              min={0}
              value={b.start}
              onChange={(e) => setB({ ...b, start: Number(e.target.value) })}
            />
          </label>
          <label className="pdfx-form__row">
            <span>Chiffres</span>
            <input
              type="number"
              min={1}
              max={12}
              value={b.digits}
              onChange={(e) => setB({ ...b, digits: Number(e.target.value) })}
            />
          </label>
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input
              value={b.pages ?? ""}
              placeholder="toutes, ou 2-, ou 1-3, 7"
              onChange={(e) => setB({ ...b, pages: e.target.value })}
            />
          </label>
          <p className="pdfx-form__note">
            Exemple :{" "}
            <b>
              {b.prefix}
              {String(b.start).padStart(b.digits, "0")}
              {b.suffix}
            </b>
            . Utilisez <code>{"{bates}"}</code> dans l'en-tête ou le pied pour le placer précisément.
          </p>
        </div>
      ) : (
        <div className="pdfx-form">
          <label className="pdfx-check">
            <input type="checkbox" checked={band.enabled} onChange={(e) => setBand({ enabled: e.target.checked })} />
            Activer {tab === "header" ? "l'en-tête" : "le pied de page"}
          </label>
          <div className="pdfx-triple">
            <label>
              <span>Gauche</span>
              <input value={band.left} onChange={(e) => setBand({ left: e.target.value })} />
            </label>
            <label>
              <span>Centre</span>
              <input value={band.center} onChange={(e) => setBand({ center: e.target.value })} />
            </label>
            <label>
              <span>Droite</span>
              <input value={band.right} onChange={(e) => setBand({ right: e.target.value })} />
            </label>
          </div>
          <div className="pdfx-tokens">
            {TOKENS.map((t) => (
              <button
                key={t}
                className="pdfx-token"
                onClick={() => setBand({ center: `${band.center}${t}` })}
                title="Insérer au centre"
              >
                {t}
              </button>
            ))}
          </div>
          <div className="pdfx-triple">
            <label>
              <span>Taille</span>
              <input
                type="number"
                min={5}
                max={24}
                value={band.fontSize}
                onChange={(e) => setBand({ fontSize: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>Couleur</span>
              <input type="color" value={band.color} onChange={(e) => setBand({ color: e.target.value })} />
            </label>
            <label>
              <span>Marge (pt)</span>
              <input
                type="number"
                min={8}
                max={120}
                value={band.marginPt}
                onChange={(e) => setBand({ marginPt: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input
              value={band.pages}
              placeholder="toutes, ou 2-, ou 1-3, 7"
              onChange={(e) => setBand({ pages: e.target.value })}
            />
          </label>
          <label className="pdfx-form__row" title="Le numéro que {page} affiche sur la première page du document">
            <span>Premier n° de page</span>
            <input
              type="number"
              value={band.startPage ?? 1}
              onChange={(e) => setBand({ startPage: Number(e.target.value) || 1 })}
            />
          </label>
        </div>
      )}
      <StripMarksCheck value={strip} onChange={setStrip} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Document properties
// ---------------------------------------------------------------------------

export function PropertiesDialog({
  info,
  xfa = "none",
  metadata,
  initialView,
  pageCount,
  sizeBytes,
  onChange,
  onClose,
}: {
  info: DocInfo;
  /** Kind of XFA form, when there is one. */
  xfa?: "none" | "hybrid" | "dynamic";
  metadata: DocMetadata;
  /** The Initial View (openPage: a page of the document as it is). */
  initialView?: InitialView;
  pageCount?: number;
  sizeBytes: number;
  /** `view`: the Initial View, when changed. */
  onChange: (v: DocMetadata, view?: InitialView) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DocMetadata>(metadata);
  const set = (patch: Partial<DocMetadata>) => setDraft((v) => ({ ...v, ...patch }));
  const [tab, setTab] = useState<"description" | "view">("description");
  const startView: InitialView = initialView ?? { pageMode: "UseNone", pageLayout: "SinglePage", openPage: 1 };
  const [iv, setIv] = useState<InitialView>(startView);
  const setView = (patch: Partial<InitialView>) => setIv((v) => ({ ...v, ...patch }));
  const viewChanged = JSON.stringify(iv) !== JSON.stringify(startView);
  const openChanged =
    !!startView.openChanged || iv.openPage !== startView.openPage || iv.openZoom !== startView.openZoom;
  return (
    <Modal
      title="Propriétés du document"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            onClick={() => {
              onChange(draft, viewChanged ? { ...iv, openChanged } : undefined);
              onClose();
            }}
          >
            Enregistrer
          </button>
        </>
      }
    >
      <div className="pdfx-segment pdfx-segment--wide">
        <button className={tab === "description" ? "is-on" : ""} onClick={() => setTab("description")}>
          Description
        </button>
        <button className={tab === "view" ? "is-on" : ""} onClick={() => setTab("view")}>
          Vue initiale
        </button>
      </div>
      {tab === "view" ? (
        <div className="pdfx-form">
          <label className="pdfx-form__row">
            <span>Panneau</span>
            <select
              value={iv.pageMode}
              onChange={(e) => setView({ pageMode: e.target.value as InitialView["pageMode"] })}
            >
              <option value="UseNone">Page seule</option>
              <option value="UseOutlines">Panneau Signets et page</option>
              <option value="UseThumbs">Panneau Vignettes et page</option>
              <option value="UseAttachments">Panneau Pièces jointes et page</option>
              <option value="UseOC">Panneau Calques et page</option>
              <option value="FullScreen">Plein écran</option>
            </select>
          </label>
          <label className="pdfx-form__row">
            <span>Disposition</span>
            <select
              value={iv.pageLayout}
              onChange={(e) => setView({ pageLayout: e.target.value as InitialView["pageLayout"] })}
            >
              <option value="SinglePage">Une seule page</option>
              <option value="OneColumn">Continue</option>
              <option value="TwoPageLeft">Deux pages</option>
              <option value="TwoColumnLeft">Deux pages continues</option>
              <option value="TwoPageRight">Deux pages (couverture)</option>
              <option value="TwoColumnRight">Deux pages continues (couverture)</option>
            </select>
          </label>
          <label className="pdfx-form__row">
            <span>Agrandissement</span>
            <select
              value={typeof iv.openZoom === "number" ? String(iv.openZoom) : (iv.openZoom ?? "default")}
              onChange={(e) => {
                const v = e.target.value;
                setView({
                  openZoom: v === "default" ? undefined : v === "Fit" || v === "FitH" || v === "FitV" ? v : Number(v),
                });
              }}
            >
              <option value="default">Par défaut</option>
              <option value="Fit">Page entière</option>
              <option value="FitH">Pleine largeur</option>
              <option value="FitV">Pleine hauteur</option>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => (
                <option key={z} value={String(z)}>
                  {Math.round(z * 100)} %
                </option>
              ))}
            </select>
          </label>
          <label className="pdfx-form__row">
            <span>Ouvrir à la page</span>
            <input
              type="number"
              min={1}
              max={pageCount ?? info.pageCount}
              value={iv.openPage}
              onChange={(e) =>
                setView({ openPage: Math.max(1, Math.min(pageCount ?? info.pageCount, Number(e.target.value) || 1)) })
              }
            />
          </label>
          <h4 className="pdfx-form__title">Fenêtre</h4>
          {(
            [
              ["fitWindow", "Ajuster la fenêtre à la page"],
              ["centerWindow", "Centrer la fenêtre à l'écran"],
              ["displayDocTitle", "Afficher le titre du document (et non le nom du fichier)"],
              ["hideToolbar", "Masquer la barre d'outils"],
              ["hideMenubar", "Masquer la barre de menus"],
              ["hideWindowUI", "Masquer les commandes de la fenêtre"],
            ] as [keyof InitialView, string][]
          ).map(([key, label]) => (
            <label key={key} className="pdfx-check">
              <input type="checkbox" checked={!!iv[key]} onChange={(e) => setView({ [key]: e.target.checked })} />
              {label}
            </label>
          ))}
          <p className="pdfx-form__note">
            Ces réglages sont enregistrés dans le fichier : Acrobat et les autres lecteurs les appliquent à l'ouverture.
          </p>
        </div>
      ) : (
        <div className="pdfx-form">
          <label className="pdfx-form__row">
            <span>Titre</span>
            <input value={draft.title ?? ""} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="pdfx-form__row">
            <span>Auteur</span>
            <input value={draft.author ?? ""} onChange={(e) => set({ author: e.target.value })} />
          </label>
          <label className="pdfx-form__row">
            <span>Objet</span>
            <input value={draft.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} />
          </label>
          <label className="pdfx-form__row">
            <span>Mots-clés</span>
            <input
              value={draft.keywords ?? ""}
              onChange={(e) => set({ keywords: e.target.value })}
              placeholder="séparés par des virgules"
            />
          </label>
          <label className="pdfx-form__row">
            <span>Langue</span>
            <input
              value={draft.language ?? ""}
              onChange={(e) => set({ language: e.target.value })}
              placeholder="fr-FR"
            />
          </label>

          <dl className="pdfx-facts">
            <div>
              <dt>Pages</dt>
              <dd>{info.pageCount}</dd>
            </div>
            <div>
              <dt>Taille</dt>
              <dd>{formatBytes(sizeBytes)}</dd>
            </div>
            <div>
              <dt>Version PDF</dt>
              <dd>{info.pdfVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Producteur</dt>
              <dd>{info.producer ?? "—"}</dd>
            </div>
            <div>
              <dt>Créé avec</dt>
              <dd>{info.creator ?? "—"}</dd>
            </div>
            <div>
              <dt>Formulaire</dt>
              <dd>
                {info.isXfa
                  ? xfa === "hybrid"
                    ? "XFA hybride (rempli par ses champs AcroForm)"
                    : "XFA dynamique (lecture seule)"
                  : info.hasAcroForm
                    ? "AcroForm"
                    : "Aucun"}
              </dd>
            </div>
            <div>
              <dt>Signature</dt>
              <dd>{info.signed ? "Présente" : "Aucune"}</dd>
            </div>
            <div>
              <dt>Chiffrement</dt>
              <dd>{info.encrypted ? "Protégé par mot de passe" : "Aucun"}</dd>
            </div>
          </dl>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Export images
// ---------------------------------------------------------------------------

export function ExportImagesDialog({
  pageCount,
  onConfirm,
  onClose,
}: {
  pageCount: number;
  onConfirm: (v: {
    format: "png" | "jpeg" | "webp" | "tiff";
    dpi: number;
    quality: number;
    range: string;
    zip: boolean;
  }) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"png" | "jpeg" | "webp" | "tiff">("png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.9);
  const [range, setRange] = useState("");
  const [zip, setZip] = useState(true);
  return (
    <Modal
      title="Exporter en images"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ format, dpi, quality, range, zip })}>
            Exporter
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="png">PNG (sans perte)</option>
            <option value="jpeg">JPEG (plus léger)</option>
            <option value="webp">WebP</option>
            <option value="tiff">TIFF</option>
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Résolution</span>
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[72, 96, 150, 200, 300, 600].map((d) => (
              <option key={d} value={d}>
                {d} ppp
              </option>
            ))}
          </select>
        </label>
        {format !== "png" && (
          <label className="pdfx-form__row">
            <span>Qualité</span>
            <span className="pdfx-insp-inline">
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              />
              <b>{Math.round(quality * 100)} %</b>
            </span>
          </label>
        )}
        <label className="pdfx-form__row">
          <span>Pages</span>
          <input value={range} placeholder={`toutes (1-${pageCount})`} onChange={(e) => setRange(e.target.value)} />
        </label>
        <label className="pdfx-check">
          <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} />
          Regrouper dans une archive .zip
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

export function OcrDialog({
  pageCount,
  localModels,
  running,
  progress,
  onConfirm,
  onCancel,
  onClose,
}: {
  pageCount: number;
  localModels: boolean;
  running: boolean;
  progress: { page: number; total: number; stage: string; ratio: number } | null;
  onConfirm: (v: { languages: OcrLanguage[]; dpi: number; range: string; skipPagesWithText: boolean }) => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [languages, setLanguages] = useState<OcrLanguage[]>(["fra"]);
  const [dpi, setDpi] = useState(300);
  const [range, setRange] = useState("");
  const [skip, setSkip] = useState(true);

  return (
    <Modal
      title="Reconnaissance de texte (OCR)"
      onClose={running ? onCancel : onClose}
      footer={
        running ? (
          <button className="eb eb--outline eb--sm" onClick={onCancel}>
            Interrompre
          </button>
        ) : (
          <>
            <button className="eb eb--outline eb--sm" onClick={onClose}>
              Annuler
            </button>
            <button
              className="eb eb--primary eb--sm"
              disabled={!languages.length}
              onClick={() => onConfirm({ languages, dpi, range, skipPagesWithText: skip })}
            >
              Lancer
            </button>
          </>
        )
      }
    >
      {running ? (
        <div className="pdfx-progress-box">
          <Loader2 size={28} className="pdfx-spin" />
          <p>
            Page {progress?.page ?? 0} / {progress?.total ?? 0} — {progress?.stage ?? "préparation"}
          </p>
          <div className="pdfx-bar">
            <span style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="pdfx-form">
          <p className="pdfx-form__lead">
            Ajoute un calque de texte invisible aligné sur l'image : la page reste identique, mais devient
            sélectionnable et cherchable.
          </p>
          <fieldset className="pdfx-form__set">
            <legend>Langues</legend>
            <div className="pdfx-chips">
              {OCR_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  className={`pdfx-chip ${languages.includes(l.code) ? "is-on" : ""}`}
                  onClick={() =>
                    setLanguages((v) => (v.includes(l.code) ? v.filter((c) => c !== l.code) : [...v, l.code]))
                  }
                >
                  {languages.includes(l.code) && <Check size={12} />}
                  {l.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="pdfx-form__row">
            <span>Résolution d'analyse</span>
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              <option value={200}>200 ppp — rapide</option>
              <option value={300}>300 ppp — recommandé</option>
              <option value={400}>400 ppp — petits caractères</option>
            </select>
          </label>
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input value={range} placeholder={`toutes (1-${pageCount})`} onChange={(e) => setRange(e.target.value)} />
          </label>
          <label className="pdfx-check">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            Ignorer les pages qui contiennent déjà du texte
          </label>
          {!localModels && (
            <p className="pdfx-form__note">
              Les modèles de langue ne sont pas embarqués dans cette installation : ils seront téléchargés une seule
              fois.
              <b> Votre document ne quitte jamais l'appareil</b> — seuls les fichiers de modèle sont récupérés.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export function SignatureDialog({
  kind = "signature",
  saved,
  onUse,
  onSave,
  onDelete,
  onClose,
}: {
  /** Acrobat's « Ajouter une signature » or « Ajouter des initiales ». */
  kind?: SavedSignature["kind"];
  saved: SavedSignature[];
  onUse: (sig: { src: string; ratio: number }) => void;
  onSave: (sig: SavedSignature) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"draw" | "type" | "import">("draw");
  const [colour, setColour] = useState("#0f172a");
  const [typed, setTyped] = useState("");
  const [fontIndex, setFontIndex] = useState(0);
  const [imported, setImported] = useState<{ src: string; ratio: number } | null>(null);
  const [store, setStore] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes.current) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (const pt of stroke.slice(1)) ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
  }, [colour, dirty]);

  const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({
      x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
      y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
    });
    const stroke: Pt[] = [at(e)];
    strokes.current.push(stroke);
    const move = (ev: PointerEvent) => {
      stroke.push(at(ev));
      setDirty((v) => !v);
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      setDirty((v) => !v);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  };

  const build = (): { src: string; ratio: number } | null => {
    if (tab === "draw") return strokesToPng(strokes.current, colour, 2.4);
    if (tab === "type") return typedSignatureToPng(typed, SIGNATURE_FONTS[fontIndex].css, colour);
    return imported;
  };

  const confirm = () => {
    const made = build();
    if (!made || !made.src) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    if (store) {
      onSave({
        id: `sig_${Date.now().toString(36)}`,
        kind,
        src: made.src,
        ratio: made.ratio,
        createdAt: new Date().toISOString(),
      });
    }
    onUse(made);
  };

  return (
    <Modal
      title={kind === "initials" ? "Initiales" : "Signature"}
      onClose={onClose}
      wide
      footer={
        <>
          {empty && (
            <p className="pdfx-form__error" role="alert">
              Signature vide : dessinez, tapez ou importez une signature avant de la placer.
            </p>
          )}
          <label className="pdfx-check">
            <input type="checkbox" checked={store} onChange={(e) => setStore(e.target.checked)} /> Mémoriser
          </label>
          <span className="pdfx-spacer" />
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={confirm}>
            Placer sur la page
          </button>
        </>
      }
    >
      {saved.length > 0 && (
        <div className="pdfx-saved-sigs">
          <span>Signatures enregistrées</span>
          <div>
            {saved.map((s) => (
              <div key={s.id} className="pdfx-saved-sig">
                <button onClick={() => onUse({ src: s.src, ratio: s.ratio })} title="Utiliser">
                  <img
                    src={s.src}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                </button>
                <button className="pdfx-saved-sig__del" onClick={() => onDelete(s.id)} title="Supprimer">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pdfx-segment pdfx-segment--wide">
        <button
          className={tab === "draw" ? "is-on" : ""}
          onClick={() => {
            setTab("draw");
            setEmpty(false);
          }}
        >
          Dessiner
        </button>
        <button
          className={tab === "type" ? "is-on" : ""}
          onClick={() => {
            setTab("type");
            setEmpty(false);
          }}
        >
          Saisir
        </button>
        <button
          className={tab === "import" ? "is-on" : ""}
          onClick={() => {
            setTab("import");
            setEmpty(false);
          }}
        >
          Importer
        </button>
      </div>

      <div className="pdfx-sigarea">
        {tab === "draw" && (
          <>
            <canvas ref={canvasRef} className="pdfx-sigpad" width={760} height={220} onPointerDown={startStroke} />
            <div className="pdfx-sigpad__tools">
              <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} title="Couleur d'encre" />
              <button
                className="pdfx-mini"
                onClick={() => {
                  strokes.current = [];
                  setDirty((v) => !v);
                }}
              >
                <Eraser size={13} /> Effacer
              </button>
            </div>
          </>
        )}
        {tab === "type" && (
          <>
            <input
              className="pdfx-siginput"
              autoFocus
              placeholder="Votre nom"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ fontFamily: SIGNATURE_FONTS[fontIndex].css, color: colour }}
            />
            <div className="pdfx-sigfonts">
              {SIGNATURE_FONTS.map((f, i) => (
                <button
                  key={f.name}
                  className={i === fontIndex ? "is-on" : ""}
                  style={{ fontFamily: f.css }}
                  onClick={() => setFontIndex(i)}
                >
                  {typed || f.label}
                </button>
              ))}
            </div>
            <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} title="Couleur d'encre" />
          </>
        )}
        {tab === "import" && (
          <div className="pdfx-sigimport">
            {imported ? (
              <img
                src={imported.src}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <p>
                Photographiez ou scannez votre signature sur une feuille blanche.
                <br />
                Le fond sera automatiquement rendu transparent.
              </p>
            )}
            <button className="pdfx-mini" onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> Choisir une image…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                const reader = new FileReader();
                reader.onload = async () => {
                  const cleaned = await cleanImportedSignature(reader.result as string, { colour });
                  setImported(cleaned);
                };
                reader.readAsDataURL(f);
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Split / crop / labels / measure / compare / optimise
// ---------------------------------------------------------------------------

export function SplitDialog({
  pageCount,
  hasBookmarks,
  onConfirm,
  onClose,
}: {
  pageCount: number;
  hasBookmarks: boolean;
  onConfirm: (v: {
    mode: "everyN" | "ranges" | "maxSize" | "bookmarks";
    n: number;
    spec: string;
    maxMb: number;
  }) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"everyN" | "ranges" | "maxSize" | "bookmarks">("everyN");
  const [n, setN] = useState(1);
  const [spec, setSpec] = useState("1-2; 3-");
  const [maxMb, setMaxMb] = useState(5);
  return (
    <Modal
      title="Diviser le document"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ mode, n, spec, maxMb })}>
            Diviser
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-radio">
          <input type="radio" checked={mode === "everyN"} onChange={() => setMode("everyN")} />
          <span>
            <b>Toutes les N pages</b>
          </span>
        </label>
        {mode === "everyN" && (
          <label className="pdfx-form__row">
            <span>Pages par fichier</span>
            <input type="number" min={1} max={pageCount} value={n} onChange={(e) => setN(Number(e.target.value))} />
          </label>
        )}
        <label className="pdfx-radio">
          <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
          <span>
            <b>Plages personnalisées</b>
            <small>Séparez les fichiers par un point-virgule.</small>
          </span>
        </label>
        {mode === "ranges" && (
          <label className="pdfx-form__row">
            <span>Plages</span>
            <input value={spec} onChange={(e) => setSpec(e.target.value)} />
          </label>
        )}
        <label className="pdfx-radio">
          <input type="radio" checked={mode === "maxSize"} onChange={() => setMode("maxSize")} />
          <span>
            <b>Taille maximale</b>
          </span>
        </label>
        {mode === "maxSize" && (
          <label className="pdfx-form__row">
            <span>Mo par fichier</span>
            <input type="number" min={1} value={maxMb} onChange={(e) => setMaxMb(Number(e.target.value))} />
          </label>
        )}
        <label className="pdfx-radio">
          <input
            type="radio"
            checked={mode === "bookmarks"}
            onChange={() => setMode("bookmarks")}
            disabled={!hasBookmarks}
          />
          <span>
            <b>Aux signets de premier niveau</b>
            {!hasBookmarks && <small>Ce document n'a pas de signets.</small>}
          </span>
        </label>
      </div>
    </Modal>
  );
}

export function CropDialog({
  current,
  onConfirm,
  onClose,
  onDetect,
}: {
  /** The current page's margins, as seen (its rotation applied). */
  current: { top: number; right: number; bottom: number; left: number };
  onConfirm: (v: {
    crop: { top: number; right: number; bottom: number; left: number };
    scope: "selection" | "all";
    /** Each page loses its own white margins (the values are then ignored). */
    auto: boolean;
  }) => void;
  onClose: () => void;
  /** The current page's white margins, as seen (null: nothing to find). */
  onDetect?: () => Promise<{ top: number; right: number; bottom: number; left: number } | null>;
}) {
  const [crop, setCrop] = useState(current);
  const [scope, setScope] = useState<"selection" | "all">("all");
  const [auto, setAuto] = useState(false);
  const [detecting, setDetecting] = useState(false);
  return (
    <Modal
      title="Recadrer les pages"
      onClose={onClose}
      footer={
        <>
          <button
            className="eb eb--outline eb--sm"
            onClick={() => onConfirm({ crop: { top: 0, right: 0, bottom: 0, left: 0 }, scope, auto: false })}
          >
            Réinitialiser
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ crop, scope, auto })}>
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">Marges à retirer, telles qu'on les voit, en points (1 pt = 0,353 mm).</p>
        {onDetect && (
          <button
            type="button"
            className="eb eb--outline eb--sm"
            disabled={detecting}
            onClick={async () => {
              setDetecting(true);
              try {
                const m = await onDetect();
                if (m) setCrop(m);
              } finally {
                setDetecting(false);
              }
            }}
          >
            {detecting ? "Détection…" : "Détecter les marges blanches"}
          </button>
        )}
        <div className="pdfx-cropgrid">
          <label>
            <span>Haut</span>
            <input
              type="number"
              min={0}
              value={crop.top}
              onChange={(e) => setCrop({ ...crop, top: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Bas</span>
            <input
              type="number"
              min={0}
              value={crop.bottom}
              onChange={(e) => setCrop({ ...crop, bottom: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Gauche</span>
            <input
              type="number"
              min={0}
              value={crop.left}
              onChange={(e) => setCrop({ ...crop, left: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Droite</span>
            <input
              type="number"
              min={0}
              value={crop.right}
              onChange={(e) => setCrop({ ...crop, right: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="pdfx-form__row">
          <span>Portée</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">Toutes les pages</option>
            <option value="selection">Pages sélectionnées</option>
          </select>
        </label>
        {onDetect && (
          <label className="pdfx-form__row pdfx-form__row--check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Retirer les marges blanches de chaque page (chacune les siennes)</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

export function PageLabelsDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (v: {
    style: "decimal" | "roman" | "ROMAN" | "alpha" | "ALPHA" | "none";
    prefix: string;
    start: number;
    scope: "selection" | "all";
  }) => void;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<"decimal" | "roman" | "ROMAN" | "alpha" | "ALPHA" | "none">("decimal");
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState(1);
  const [scope, setScope] = useState<"selection" | "all">("all");
  return (
    <Modal
      title="Étiquettes de page"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ style, prefix, start, scope })}>
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Style</span>
          <select value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
            <option value="decimal">1, 2, 3…</option>
            <option value="roman">i, ii, iii…</option>
            <option value="ROMAN">I, II, III…</option>
            <option value="alpha">a, b, c…</option>
            <option value="ALPHA">A, B, C…</option>
            <option value="none">Préfixe seul</option>
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Préfixe</span>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ex. Annexe-" />
        </label>
        <label className="pdfx-form__row">
          <span>Commencer à</span>
          <input type="number" min={1} value={start} onChange={(e) => setStart(Number(e.target.value))} />
        </label>
        <label className="pdfx-form__row">
          <span>Portée</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">Toutes les pages</option>
            <option value="selection">Pages sélectionnées</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

export function MeasureScaleDialog({
  value,
  onConfirm,
  onClose,
}: {
  value: MeasureScale;
  onConfirm: (v: MeasureScale) => void;
  onClose: () => void;
}) {
  const [pageLength, setPageLength] = useState(1);
  const [realLength, setRealLength] = useState(Number((value.unitsPerPoint * 72).toFixed(4)));
  const [unit, setUnit] = useState(value.unit);
  const [precision, setPrecision] = useState(value.precision);
  const perPoint = pageLength > 0 ? realLength / (pageLength * 72) : value.unitsPerPoint;
  return (
    <Modal
      title="Échelle de mesure"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            onClick={() => onConfirm({ unitsPerPoint: perPoint, unit, precision })}
          >
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">Indiquez la correspondance entre le document et la réalité.</p>
        <div className="pdfx-scalerow">
          <input
            type="number"
            min={0.01}
            step="0.01"
            value={pageLength}
            onChange={(e) => setPageLength(Number(e.target.value))}
          />
          <span>pouce sur la page</span>
          <b>=</b>
          <input
            type="number"
            min={0.0001}
            step="0.0001"
            value={realLength}
            onChange={(e) => setRealLength(Number(e.target.value))}
          />
          <input className="pdfx-unitinput" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <label className="pdfx-form__row">
          <span>Décimales</span>
          <input
            type="number"
            min={0}
            max={6}
            value={precision}
            onChange={(e) => setPrecision(Number(e.target.value))}
          />
        </label>
        <p className="pdfx-form__note">
          Soit{" "}
          <b>
            1 pt = {perPoint.toFixed(6)} {unit}
          </b>
          .
        </p>
      </div>
    </Modal>
  );
}

export function CompareDialog({
  report,
  busy,
  onPick,
  onGoTo,
  onClose,
}: {
  report: ComparisonReport | null;
  busy: boolean;
  onPick: () => void;
  onGoTo: (page: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Comparer deux documents" onClose={onClose} wide>
      {!report ? (
        <div className="pdfx-form">
          <p className="pdfx-form__lead">Choisissez la version à comparer avec le document ouvert.</p>
          <button className="eb eb--primary eb--sm" onClick={onPick} disabled={busy}>
            {busy ? (
              <>
                <Loader2 size={14} className="pdfx-spin" /> Analyse…
              </>
            ) : (
              <>
                <FileText size={14} /> Choisir un PDF…
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="pdfx-compare">
          <div className="pdfx-compare__stats">
            <div>
              <b>{Math.round(report.similarity * 100)} %</b>
              <span>de similitude</span>
            </div>
            <div>
              <b>{report.wordsAdded}</b>
              <span>mots ajoutés</span>
            </div>
            <div>
              <b>{report.wordsRemoved}</b>
              <span>mots supprimés</span>
            </div>
            <div>
              <b>{report.pagesModified}</b>
              <span>pages modifiées</span>
            </div>
            <div>
              <b>{report.pagesAdded}</b>
              <span>pages ajoutées</span>
            </div>
            <div>
              <b>{report.pagesRemoved}</b>
              <span>pages retirées</span>
            </div>
          </div>
          <div className="pdfx-compare__list">
            {report.pages
              .filter((pg) => pg.status !== "unchanged")
              .map((pg, i) => (
                <div key={i} className={`pdfx-compare__page is-${pg.status}`}>
                  <header>
                    <button onClick={() => pg.leftPage && onGoTo(pg.leftPage)}>
                      {pg.status === "added"
                        ? `Page ${pg.rightPage} ajoutée`
                        : pg.status === "removed"
                          ? `Page ${pg.leftPage} supprimée`
                          : `Page ${pg.leftPage} → ${pg.rightPage}`}
                    </button>
                    <span>{Math.round(pg.similarity * 100)} %</span>
                  </header>
                  <p className="pdfx-diff">
                    {pg.changes.slice(0, 60).map((c, k) => {
                      if (c.kind === "equal") return <span key={k}>{c.left.slice(-12).join(" ")} </span>;
                      return (
                        <span key={k}>
                          {!!c.left.length && <del>{c.left.join(" ")}</del>}{" "}
                          {!!c.right.length && <ins>{c.right.join(" ")}</ins>}{" "}
                        </span>
                      );
                    })}
                  </p>
                </div>
              ))}
            {report.pagesWithoutText > 0 && (
              <p className="pdfx-form__note">
                {report.pagesWithoutText} page(s) sans texte (images ou dessins) : leur contenu n'a pas pu être comparé.
                Lancez d'abord la reconnaissance de texte (OCR) sur les deux documents.
              </p>
            )}
            {!report.pages.some((pg) => pg.status !== "unchanged") && report.pagesWithoutText === 0 && (
              <p className="pdfx-empty">Les deux documents sont identiques.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function InsertPagesDialog({
  pageCount,
  onConfirm,
  onClose,
  files,
  initialAt = 1,
}: {
  pageCount: number;
  onConfirm: (v: {
    where: "before" | "after" | "end";
    at: number;
    count: number;
    size: string;
    landscape: boolean;
  }) => void;
  onClose: () => void;
  /** Inserting these files (only the position is asked), not blank pages. */
  files?: string[];
  initialAt?: number;
}) {
  const [where, setWhere] = useState<"before" | "after" | "end">(files ? "end" : "after");
  const [at, setAt] = useState(Math.max(1, Math.min(pageCount, initialAt)));
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("A4");
  const [landscape, setLandscape] = useState(false);
  return (
    <Modal
      title={
        files
          ? `Insérer ${files.length > 1 ? `${files.length} fichiers` : `« ${files[0]} »`}`
          : "Insérer des pages blanches"
      }
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ where, at, count, size, landscape })}>
            Insérer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Position</span>
          <select value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
            <option value="before">Avant la page</option>
            <option value="after">Après la page</option>
            <option value="end">À la fin</option>
          </select>
        </label>
        {where !== "end" && (
          <label className="pdfx-form__row">
            <span>Page</span>
            <input type="number" min={1} max={pageCount} value={at} onChange={(e) => setAt(Number(e.target.value))} />
          </label>
        )}
        {!files && (
          <>
            <label className="pdfx-form__row">
              <span>Nombre</span>
              <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </label>
            <label className="pdfx-form__row">
              <span>Format</span>
              <select value={size} onChange={(e) => setSize(e.target.value)}>
                {Object.keys(PAGE_SIZES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="same">Comme la page courante</option>
              </select>
            </label>
            {size !== "same" && (
              <label className="pdfx-form__row">
                <span>Orientation</span>
                <select value={landscape ? "l" : "p"} onChange={(e) => setLandscape(e.target.value === "l")}>
                  <option value="p">Portrait</option>
                  <option value="l">Paysage</option>
                </select>
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export function RedactSearchDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (v: {
    query: string;
    wholeWord: boolean;
    caseSensitive: boolean;
    regex: boolean;
    preset?: string;
  }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [preset, setPreset] = useState<string | undefined>(undefined);
  return (
    <Modal
      title="Marquer par recherche"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            disabled={!query}
            onClick={() => onConfirm({ query, wholeWord, caseSensitive, regex, preset })}
          >
            Marquer tout
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Texte à caviarder</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPreset(undefined);
            }}
          />
        </label>
        <div className="pdfx-chips">
          {REDACT_PATTERNS.map((p) => (
            <button
              key={p.id}
              className={`pdfx-chip ${preset === p.id ? "is-on" : ""}`}
              onClick={() => {
                setQuery(p.pattern);
                setRegex(true);
                setCaseSensitive(!!p.caseSensitive);
                setPreset(p.id);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="pdfx-check">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />{" "}
          Respecter la casse
        </label>
        <label className="pdfx-check">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Mot entier
        </label>
        <label className="pdfx-check">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Expression régulière
        </label>
      </div>
    </Modal>
  );
}

/** Which pages a page command applies to (Acrobat's page-range choices). */
export type PageScope = "selection" | "all" | "even" | "odd" | "range";

function ScopeRows({
  scope,
  setScope,
  range,
  setRange,
  hasSelection,
}: {
  scope: PageScope;
  setScope: (s: PageScope) => void;
  range: string;
  setRange: (s: string) => void;
  hasSelection: boolean;
}) {
  return (
    <>
      <label className="pdfx-form__row">
        <span>Pages</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as PageScope)}>
          {hasSelection && <option value="selection">Sélection</option>}
          <option value="all">Toutes</option>
          <option value="even">Paires</option>
          <option value="odd">Impaires</option>
          <option value="range">Plage…</option>
        </select>
      </label>
      {scope === "range" && (
        <label className="pdfx-form__row">
          <span>Plage</span>
          <input value={range} placeholder="1-3, 7, 10-" onChange={(e) => setRange(e.target.value)} />
        </label>
      )}
    </>
  );
}

export function RotatePagesDialog({
  hasSelection,
  onConfirm,
  onClose,
}: {
  hasSelection: boolean;
  onConfirm: (v: { delta: 90 | -90 | 180; scope: PageScope; range: string }) => void;
  onClose: () => void;
}) {
  const [delta, setDelta] = useState<90 | -90 | 180>(90);
  const [scope, setScope] = useState<PageScope>(hasSelection ? "selection" : "all");
  const [range, setRange] = useState("");
  return (
    <Modal
      title="Faire pivoter des pages"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ delta, scope, range })}>
            Faire pivoter
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Sens</span>
          <select value={delta} onChange={(e) => setDelta(Number(e.target.value) as 90 | -90 | 180)}>
            <option value={90}>90° à droite</option>
            <option value={-90}>90° à gauche</option>
            <option value={180}>180°</option>
          </select>
        </label>
        <ScopeRows scope={scope} setScope={setScope} range={range} setRange={setRange} hasSelection={hasSelection} />
      </div>
    </Modal>
  );
}

export function MovePagesDialog({
  count,
  pageCount,
  onConfirm,
  onClose,
}: {
  count: number;
  pageCount: number;
  onConfirm: (v: { where: "before" | "after" | "start" | "end"; at: number }) => void;
  onClose: () => void;
}) {
  const [where, setWhere] = useState<"before" | "after" | "start" | "end">("after");
  const [at, setAt] = useState(1);
  return (
    <Modal
      title={`Déplacer ${count} page(s)`}
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ where, at })}>
            Déplacer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Vers</span>
          <select value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
            <option value="before">Avant la page</option>
            <option value="after">Après la page</option>
            <option value="start">Au début</option>
            <option value="end">À la fin</option>
          </select>
        </label>
        {(where === "before" || where === "after") && (
          <label className="pdfx-form__row">
            <span>Page</span>
            <input type="number" min={1} max={pageCount} value={at} onChange={(e) => setAt(Number(e.target.value))} />
          </label>
        )}
      </div>
    </Modal>
  );
}

export function ResizePagesDialog({
  hasSelection,
  onConfirm,
  onClose,
}: {
  hasSelection: boolean;
  onConfirm: (v: { size: string; landscape: boolean; fit: boolean; scope: PageScope; range: string }) => void;
  onClose: () => void;
}) {
  const [size, setSize] = useState("A4");
  const [landscape, setLandscape] = useState(false);
  const [fit, setFit] = useState(true);
  const [scope, setScope] = useState<PageScope>(hasSelection ? "selection" : "all");
  const [range, setRange] = useState("");
  return (
    <Modal
      title="Redimensionner des pages"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ size, landscape, fit, scope, range })}>
            Redimensionner
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Format</span>
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Orientation</span>
          <select value={landscape ? "l" : "p"} onChange={(e) => setLandscape(e.target.value === "l")}>
            <option value="p">Portrait</option>
            <option value="l">Paysage</option>
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Contenu</span>
          <select value={fit ? "fit" : "keep"} onChange={(e) => setFit(e.target.value === "fit")}>
            <option value="fit">Mettre à l'échelle du format</option>
            <option value="keep">Garder sa taille (marges ajoutées ou coupées)</option>
          </select>
        </label>
        <ScopeRows scope={scope} setScope={setScope} range={range} setRange={setRange} hasSelection={hasSelection} />
      </div>
    </Modal>
  );
}

export function ReplacePagesDialog({
  fileName,
  pageCount,
  sourceCount,
  initialAt,
  onConfirm,
  onClose,
}: {
  fileName: string;
  pageCount: number;
  sourceCount: number;
  initialAt: number;
  onConfirm: (v: { from: number; to: number; srcFrom: number }) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(Math.max(1, Math.min(pageCount, initialAt)));
  const [to, setTo] = useState(Math.max(1, Math.min(pageCount, initialAt)));
  const [srcFrom, setSrcFrom] = useState(1);
  const n = Math.max(0, to - from + 1);
  const ok = n > 0 && srcFrom >= 1 && srcFrom + n - 1 <= sourceCount;
  return (
    <Modal
      title="Remplacer des pages"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" disabled={!ok} onClick={() => onConfirm({ from, to, srcFrom })}>
            Remplacer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row">
          <span>Pages du document</span>
          <span className="pdfx-insp-inline">
            <input
              type="number"
              min={1}
              max={pageCount}
              value={from}
              onChange={(e) => setFrom(Number(e.target.value))}
            />
            à
            <input
              type="number"
              min={from}
              max={pageCount}
              value={to}
              onChange={(e) => setTo(Number(e.target.value))}
            />
          </span>
        </label>
        <label className="pdfx-form__row">
          <span>Par les pages de « {fileName} »</span>
          <span className="pdfx-insp-inline">
            <input
              type="number"
              min={1}
              max={sourceCount}
              value={srcFrom}
              onChange={(e) => setSrcFrom(Number(e.target.value))}
            />
            à {srcFrom + n - 1} (sur {sourceCount})
          </span>
        </label>
        {!ok && <p className="pdfx-form__hint">Le fichier n'a pas assez de pages pour cette plage.</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Link properties (Acrobat's « Créer un lien » / « Propriétés du lien »)
// ---------------------------------------------------------------------------

export interface LinkDraft {
  action?: LinkAction;
  linkStyle: LinkStyle;
  color: string;
}

export const DEFAULT_LINK_STYLE: LinkStyle = { visible: false, line: "solid", width: 1, highlight: "I" };

const NAMED_ACTIONS: [string, string][] = [
  ["NextPage", "Page suivante"],
  ["PrevPage", "Page précédente"],
  ["FirstPage", "Première page"],
  ["LastPage", "Dernière page"],
  ["GoBack", "Vue précédente"],
  ["GoForward", "Vue suivante"],
];

export function LinkDialog({
  value,
  pageCount,
  pageLabel,
  currentView,
  creating,
  onConfirm,
  onClose,
}: {
  value: LinkDraft;
  pageCount: number;
  /** A page's label as shown (1-based position). */
  pageLabel: (page: number) => string;
  /** The view on screen now, as a destination. */
  currentView: () => Extract<LinkAction, { type: "page" }>;
  creating: boolean;
  onConfirm: (v: LinkDraft) => void;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<LinkStyle>(value.linkStyle);
  const [color, setColor] = useState(value.color);
  const [kind, setKind] = useState<LinkAction["type"]>(value.action?.type ?? "page");
  const [page, setPage] = useState<Extract<LinkAction, { type: "page" }>>(
    value.action?.type === "page" ? value.action : { type: "page", page: 1, fit: "Fit" },
  );
  const [url, setUrl] = useState(value.action?.type === "url" ? value.action.url : "https://");
  const [named, setNamed] = useState(value.action?.type === "named" ? value.action.name : "NextPage");
  const action: LinkAction | undefined =
    kind === "url"
      ? /^\s*$/.test(url) || url.trim() === "https://"
        ? undefined
        : { type: "url", url: url.trim() }
      : kind === "named"
        ? { type: "named", name: named }
        : page;
  return (
    <Modal
      title={creating ? "Créer un lien" : "Propriétés du lien"}
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            {creating ? "Plus tard" : "Annuler"}
          </button>
          <button
            className="eb eb--primary eb--sm"
            disabled={!action}
            onClick={() => onConfirm({ action, linkStyle: style, color })}
          >
            {creating ? "Créer" : "Appliquer"}
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <h4 className="pdfx-form__title">Apparence</h4>
        <label className="pdfx-form__row">
          <span>Type</span>
          <select
            value={style.visible ? "visible" : "invisible"}
            onChange={(e) => setStyle({ ...style, visible: e.target.value === "visible" })}
          >
            <option value="invisible">Rectangle invisible</option>
            <option value="visible">Rectangle visible</option>
          </select>
        </label>
        {style.visible && (
          <div className="pdfx-triple">
            <label>
              <span>Style</span>
              <select
                value={style.line}
                onChange={(e) => setStyle({ ...style, line: e.target.value as LinkStyle["line"] })}
              >
                <option value="solid">Plein</option>
                <option value="dashed">Tirets</option>
                <option value="underline">Souligné</option>
              </select>
            </label>
            <label>
              <span>Épaisseur</span>
              <select value={style.width} onChange={(e) => setStyle({ ...style, width: Number(e.target.value) })}>
                <option value={1}>Fine</option>
                <option value={2}>Moyenne</option>
                <option value={3}>Épaisse</option>
              </select>
            </label>
            <label>
              <span>Couleur</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
        )}
        <label className="pdfx-form__row">
          <span>Au clic</span>
          <select
            value={style.highlight}
            onChange={(e) => setStyle({ ...style, highlight: e.target.value as LinkStyle["highlight"] })}
          >
            <option value="I">Inverser</option>
            <option value="O">Contour</option>
            <option value="P">Incrustation</option>
            <option value="N">Aucun effet</option>
          </select>
        </label>

        <h4 className="pdfx-form__title">Action</h4>
        <label className="pdfx-form__row">
          <span>Le lien</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as LinkAction["type"])}>
            <option value="page">Va à une page de ce document</option>
            <option value="url">Ouvre une page web</option>
            <option value="named">Exécute une commande</option>
          </select>
        </label>
        {kind === "page" && (
          <>
            <label className="pdfx-form__row">
              <span>Page</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={page.page}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(pageCount, Number(e.target.value) || 1));
                  setPage({ type: "page", page: n, fit: "Fit" });
                }}
              />
            </label>
            <p className="pdfx-form__note">
              {page.fit === "XYZ" || page.zoom
                ? `Page ${pageLabel(page.page)}, à la position et au zoom enregistrés.`
                : `Page ${pageLabel(page.page)}, entière.`}{" "}
              <button className="pdfx-mini" onClick={() => setPage(currentView())}>
                Utiliser la vue affichée
              </button>
            </p>
          </>
        )}
        {kind === "url" && (
          <label className="pdfx-form__row">
            <span>Adresse</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          </label>
        )}
        {kind === "named" && (
          <label className="pdfx-form__row">
            <span>Commande</span>
            <select value={named} onChange={(e) => setNamed(e.target.value)}>
              {NAMED_ACTIONS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply redaction (and remove hidden information)
// ---------------------------------------------------------------------------

const HIDDEN_INFO_LABELS: [keyof HiddenInfoOptions, string, string][] = [
  ["metadata", "Métadonnées", "Propriétés du document, XMP, données privées d'applications, vignettes"],
  ["bookmarks", "Signets", "Leurs titres reprennent souvent le texte des pages"],
  ["structure", "Textes de remplacement", "Texte alternatif et texte de substitution de la structure"],
  ["actions", "Liens, actions et JavaScript", "Scripts, actions automatiques, liens"],
  ["attachments", "Fichiers joints", "Pièces jointes du document et des commentaires, multimédia"],
  ["hiddenLayers", "Calques masqués", "Le contenu des calques masqués est supprimé, les autres fusionnés"],
  ["comments", "Commentaires", "Toutes les annotations qui ne sont ni des champs ni des liens"],
  [
    "hiddenText",
    "Texte invisible",
    "Dont la couche de texte d'une numérisation (OCR) : le texte ne sera plus sélectionnable",
  ],
];

/** The kinds of hidden information, as checkboxes. */
export function HiddenInfoChoices({
  value,
  onChange,
}: {
  value: HiddenInfoOptions;
  onChange: (v: HiddenInfoOptions) => void;
}) {
  return (
    <div className="pdfx-form">
      {HIDDEN_INFO_LABELS.map(([key, label, hint]) => (
        <label key={key} className="pdfx-check" title={hint}>
          <input
            type="checkbox"
            checked={value[key]}
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
          />
          <span>
            {label}
            <small className="pdfx-row__sub">{hint}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

export function RedactApplyDialog({
  marks,
  onConfirm,
  onClose,
}: {
  marks: number;
  /** `hidden`: the hidden information to remove as well (null: none). */
  onConfirm: (hidden: HiddenInfoOptions | null) => void;
  onClose: () => void;
}) {
  const [also, setAlso] = useState(true);
  const [hidden, setHidden] = useState<HiddenInfoOptions>(AFTER_REDACTION);
  return (
    <Modal
      title="Appliquer le caviardage"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm(also ? hidden : null)}>
            Caviarder et enregistrer
          </button>
        </>
      }
    >
      <p className="pdfx-form__note">
        {marks} zone(s) seront définitivement supprimées du fichier : texte (y compris dans les objets imbriqués),
        pixels des images, dessins, commentaires et champs situés dessous. Le fichier est entièrement réécrit, sans
        révision antérieure qui garderait ce contenu.
      </p>
      <label className="pdfx-check">
        <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
        Supprimer aussi les informations masquées (recommandé)
      </label>
      {also && <HiddenInfoChoices value={hidden} onChange={setHidden} />}
    </Modal>
  );
}

/** « Enregistrer au format PDF/A »: what the document lacks now, the part to convert to. */
export function PdfADialog({
  problems,
  signed,
  onConfirm,
  onClose,
}: {
  /** The usual PDF/A failures the document shows now (null: still checking). */
  problems: string[] | null;
  signed: boolean;
  onConfirm: (part: 2 | 3) => void;
  onClose: () => void;
}) {
  const [part, setPart] = useState<2 | 3>(2);
  return (
    <Modal
      title="Enregistrer au format PDF/A"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm(part)}>
            Convertir et enregistrer
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">
          Le PDF/A est la norme d'archivage à long terme (ISO 19005) : polices incorporées, couleurs définies,
          métadonnées normalisées, ni JavaScript ni contenu externe.
        </p>
        <label className="pdfx-radio">
          <input type="radio" checked={part === 2} onChange={() => setPart(2)} /> PDF/A-2b (recommandé)
        </label>
        <label className="pdfx-radio">
          <input type="radio" checked={part === 3} onChange={() => setPart(3)} /> PDF/A-3b (garde les fichiers joints)
        </label>
        <fieldset className="pdfx-form__set">
          <legend>État actuel du document</legend>
          {problems === null ? (
            <p className="pdfx-form__note">Vérification…</p>
          ) : problems.length ? (
            <ul className="pdfx-list">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="pdfx-form__note">Aucun défaut courant détecté.</p>
          )}
        </fieldset>
        {signed && (
          <p className="pdfx-form__error">
            Le document est signé : la conversion le modifie, ses signatures électroniques seront retirées de la copie.
          </p>
        )}
        <p className="pdfx-form__note">
          Une copie est enregistrée ; le document ouvert n'est pas modifié. Les polices non incorporées sont remplacées
          par des polices Liberation équivalentes.
        </p>
      </div>
    </Modal>
  );
}

/** Accessibility report (Acrobat's « Vérification complète »), with the fixes that need no tagging. */
export function AccessibilityDialog({
  rules,
  title,
  language,
  onFix,
  onClose,
}: {
  rules: import("../ops/accessibility").AccessibilityRule[] | null;
  title: string;
  language: string;
  /** Set the title (shown in the window) and the language. */
  onFix: (v: { title: string; language: string }) => void;
  onClose: () => void;
}) {
  const [t, setT] = useState(title);
  const [lang, setLang] = useState(language || "fr-FR");
  const icon = { pass: "✓", fail: "✗", manual: "?" } as const;
  const groups = rules ? [...new Set(rules.map((r) => r.category))] : [];
  const failed = rules?.filter((r) => r.status === "fail").length ?? 0;
  const manual = rules?.filter((r) => r.status === "manual").length ?? 0;
  const needsFix = rules?.some((r) => (r.rule === "Titre" || r.rule === "Langue principale") && r.status === "fail");
  return (
    <Modal
      title="Vérification de l'accessibilité"
      onClose={onClose}
      wide
      footer={
        <button className="eb eb--primary eb--sm" onClick={onClose}>
          Fermer
        </button>
      }
    >
      <div className="pdfx-form">
        {!rules ? (
          <p className="pdfx-form__note">Vérification…</p>
        ) : (
          <>
            <p className="pdfx-form__lead">
              {failed ? `${failed} problème(s) détecté(s)` : "Aucun problème détecté"} · {manual} point(s) à vérifier
              manuellement.
            </p>
            {needsFix && (
              <fieldset className="pdfx-form__set">
                <legend>Corriger</legend>
                <label className="pdfx-form__row">
                  <span>Titre du document</span>
                  <input value={t} onChange={(e) => setT(e.target.value)} />
                </label>
                <label className="pdfx-form__row">
                  <span>Langue</span>
                  <select value={lang} onChange={(e) => setLang(e.target.value)}>
                    {["fr-FR", "en-GB", "en-US", "de-DE", "es-ES", "it-IT", "nl-NL", "pt-PT"].map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="eb eb--outline eb--sm"
                  disabled={!t.trim()}
                  onClick={() => onFix({ title: t.trim(), language: lang })}
                >
                  Appliquer le titre et la langue
                </button>
              </fieldset>
            )}
            {groups.map((g) => (
              <fieldset key={g} className="pdfx-form__set">
                <legend>{g}</legend>
                <ul className="pdfx-a11y">
                  {rules
                    .filter((r) => r.category === g)
                    .map((r) => (
                      <li key={r.rule} className={`is-${r.status}`}>
                        <span aria-hidden="true">{icon[r.status]}</span>
                        <span>
                          {r.rule}
                          {r.status === "manual" && <em> — à vérifier manuellement</em>}
                          {r.detail && <small>{r.detail}</small>}
                        </span>
                      </li>
                    ))}
                </ul>
              </fieldset>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
