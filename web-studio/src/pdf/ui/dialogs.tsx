import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Eraser, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Modal } from "../../ui/components";
import type { Bates, DocMetadata, HeaderFooter, MeasureScale, Watermark } from "../model/types";
import type { Permissions } from "../ops/security";
import { ALL_PERMISSIONS } from "../ops/security";
import type { DocInfo } from "../core/engine";
import { OCR_LANGUAGES, type OcrLanguage } from "../ops/ocr";
import { PAGE_SIZES } from "../ops/organize";
import { SIGNATURE_FONTS, cleanImportedSignature, strokesToPng, typedSignatureToPng, type SavedSignature } from "../ops/sign";
import type { Pt } from "../core/coords";
import { formatBytes } from "../ops/optimize";
import type { BuildOptions } from "../ops/save";
import type { ComparisonReport } from "../ops/compare";

/** Every modal the PDF workspace can open, kept together so they share styling. */

// ---------------------------------------------------------------------------
// Export / save options
// ---------------------------------------------------------------------------

export function SaveDialog({
  fileName, options, hasRedactions, hasForm, onChange, onConfirm, onClose,
}: {
  fileName: string;
  options: BuildOptions;
  hasRedactions: boolean;
  hasForm: boolean;
  onChange: (patch: Partial<BuildOptions>) => void;
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(fileName.replace(/\.pdf$/i, ""));
  return (
    <Modal
      title="Exporter le PDF"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm(`${name.trim() || "document"}.pdf`)}>
            <Download size={14} /> Exporter
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
              type="radio" checked={options.interactiveAnnots}
              onChange={() => onChange({ interactiveAnnots: true })}
            />
            <span>
              <b>Modifiables</b>
              <small>Vraies annotations PDF : Acrobat et Aperçu les affichent dans leur volet de commentaires, avec auteur, date et fils de discussion.</small>
            </span>
          </label>
          <label className="pdfx-radio">
            <input
              type="radio" checked={!options.interactiveAnnots}
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
            <input type="checkbox" checked={options.flattenForms} onChange={(e) => onChange({ flattenForms: e.target.checked })} />
            <span>Aplatir les champs de formulaire<small>Les valeurs deviennent du contenu figé.</small></span>
          </label>
        )}

        {hasRedactions && (
          <label className="pdfx-check pdfx-check--block pdfx-check--warn">
            <input type="checkbox" checked={options.applyRedactions} onChange={(e) => onChange({ applyRedactions: e.target.checked })} />
            <span>Appliquer le caviardage<small>Le contenu marqué est supprimé définitivement du fichier exporté.</small></span>
          </label>
        )}

        <label className="pdfx-check pdfx-check--block">
          <input type="checkbox" checked={options.sanitise} onChange={(e) => onChange({ sanitise: e.target.checked })} />
          <span>Assainir<small>Retirer métadonnées, JavaScript, pièces jointes et actions automatiques.</small></span>
        </label>

        <label className="pdfx-check pdfx-check--block">
          <input type="checkbox" checked={options.optimise} onChange={(e) => onChange({ optimise: e.target.checked })} />
          <span>Optimiser la taille<small>Rééchantillonne les images et recompresse les flux.</small></span>
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

const PERMISSION_LABELS: [keyof Permissions, string][] = [
  ["print", "Impression"],
  ["printHighRes", "Impression haute définition"],
  ["copy", "Copie du texte et des images"],
  ["modify", "Modification du document"],
  ["annotate", "Ajout de commentaires"],
  ["fillForms", "Remplissage des formulaires"],
  ["assemble", "Assemblage des pages"],
  ["extractForAccessibility", "Extraction pour l'accessibilité"],
];

export function ProtectDialog({
  onConfirm, onClose,
}: {
  onConfirm: (v: { userPassword: string; ownerPassword: string; permissions: Permissions; encryptMetadata: boolean }) => void;
  onClose: () => void;
}) {
  const [user, setUser] = useState("");
  const [confirm, setConfirm] = useState("");
  const [owner, setOwner] = useState("");
  const [permissions, setPermissions] = useState<Permissions>({ ...ALL_PERMISSIONS });
  const [encryptMetadata, setEncryptMetadata] = useState(true);
  const mismatch = !!user && user !== confirm;
  const strength = passwordStrength(user);

  return (
    <Modal
      title="Protéger par mot de passe"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button
            className="eb eb--primary eb--sm"
            disabled={(!user && !owner) || mismatch}
            onClick={() => onConfirm({ userPassword: user, ownerPassword: owner || user, permissions, encryptMetadata })}
          >
            Protéger
          </button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">
          Chiffrement <b>AES-256</b> (révision 6), le standard écrit par Acrobat X et suivants.
        </p>
        <label className="pdfx-form__row">
          <span>Mot de passe d'ouverture</span>
          <input type="password" value={user} onChange={(e) => setUser(e.target.value)} autoFocus placeholder="Laisser vide pour ne pas restreindre l'ouverture" />
        </label>
        {!!user && (
          <>
            <label className="pdfx-form__row">
              <span>Confirmer</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <div className={`pdfx-strength pdfx-strength--${strength.level}`}>
              <span style={{ width: `${strength.score}%` }} />
              <em>{strength.label}</em>
            </div>
          </>
        )}
        {mismatch && <p className="pdfx-form__error">Les deux saisies diffèrent.</p>}

        <label className="pdfx-form__row">
          <span>Mot de passe propriétaire</span>
          <input type="password" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Identique au précédent si vide" />
        </label>

        <fieldset className="pdfx-form__set">
          <legend>Autorisations accordées sans le mot de passe propriétaire</legend>
          {PERMISSION_LABELS.map(([key, label]) => (
            <label key={key} className="pdfx-check">
              <input
                type="checkbox"
                checked={permissions[key]}
                onChange={(e) => setPermissions((v) => ({ ...v, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <label className="pdfx-check">
          <input type="checkbox" checked={encryptMetadata} onChange={(e) => setEncryptMetadata(e.target.checked)} />
          Chiffrer aussi les métadonnées
        </label>

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
  wrong, fileName, onConfirm, onClose,
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
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm(pw)} disabled={!pw}>Ouvrir</button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">« {fileName} » demande un mot de passe pour s'ouvrir.</p>
        <label className="pdfx-form__row">
          <span>Mot de passe</span>
          <input
            type="password" autoFocus value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pw) onConfirm(pw); }}
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

export function WatermarkDialog({
  value, onChange, onClose,
}: {
  value: Watermark;
  onChange: (v: Watermark) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Watermark>(value);
  const set = (patch: Partial<Watermark>) => setDraft((v) => ({ ...v, ...patch }));
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      title="Filigrane"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={() => { onChange({ ...draft, enabled: false }); onClose(); }}>Retirer</button>
          <button className="eb eb--primary eb--sm" onClick={() => { onChange({ ...draft, enabled: true }); onClose(); }}>Appliquer</button>
        </>
      }
    >
      <div className="pdfx-split">
        <div className="pdfx-form">
          <div className="pdfx-segment">
            <button className={draft.mode === "text" ? "is-on" : ""} onClick={() => set({ mode: "text" })}>Texte</button>
            <button className={draft.mode === "image" ? "is-on" : ""} onClick={() => set({ mode: "image" })}>Image</button>
          </div>

          {draft.mode === "text" ? (
            <label className="pdfx-form__row">
              <span>Texte</span>
              <input value={draft.text} onChange={(e) => set({ text: e.target.value })} autoFocus />
            </label>
          ) : (
            <div className="pdfx-form__row">
              <span>Image</span>
              <button className="pdfx-mini" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choisir…</button>
              <input
                ref={fileRef} type="file" accept="image/*" hidden
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
            <input type="color" value={draft.color} onChange={(e) => set({ color: e.target.value })} disabled={draft.mode === "image"} />
          </label>
          <label className="pdfx-form__row">
            <span>Opacité</span>
            <span className="pdfx-insp-inline">
              <input type="range" min={0.02} max={1} step={0.02} value={draft.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} />
              <b>{Math.round(draft.opacity * 100)} %</b>
            </span>
          </label>
          <label className="pdfx-form__row">
            <span>Rotation</span>
            <span className="pdfx-insp-inline">
              <input type="range" min={-90} max={90} step={1} value={draft.angle} onChange={(e) => set({ angle: Number(e.target.value) })} />
              <b>{draft.angle}°</b>
            </span>
          </label>
          <label className="pdfx-form__row">
            <span>Échelle</span>
            <span className="pdfx-insp-inline">
              <input type="range" min={0.2} max={3} step={0.05} value={draft.scale} onChange={(e) => set({ scale: Number(e.target.value) })} />
              <b>{draft.scale.toFixed(2)}×</b>
            </span>
          </label>
          <label className="pdfx-form__row">
            <span>Position</span>
            <select value={draft.position} onChange={(e) => set({ position: e.target.value as Watermark["position"] })}>
              <option value="center">Centre</option>
              <option value="top">Haut</option>
              <option value="bottom">Bas</option>
              <option value="topLeft">Haut gauche</option>
              <option value="topRight">Haut droite</option>
              <option value="bottomLeft">Bas gauche</option>
              <option value="bottomRight">Bas droite</option>
            </select>
          </label>
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input value={draft.pages} placeholder="toutes, ou 1-3, 7" onChange={(e) => set({ pages: e.target.value })} />
          </label>
          <label className="pdfx-check">
            <input type="checkbox" checked={draft.behind} onChange={(e) => set({ behind: e.target.checked })} />
            Derrière le contenu de la page
          </label>
        </div>

        <div className="pdfx-preview">
          <div className="pdfx-preview__page">
            <div className="pdfx-preview__lines">{Array.from({ length: 14 }, (_, i) => <span key={i} style={{ width: `${55 + ((i * 37) % 40)}%` }} />)}</div>
            <div
              className="pdfx-preview__wm"
              style={{
                transform: `translate(-50%,-50%) rotate(${-draft.angle}deg) scale(${draft.scale})`,
                opacity: draft.opacity,
                color: draft.color,
                ...previewAnchor(draft.position),
              }}
            >
              {draft.mode === "image" && draft.src
                ? <img src={draft.src} alt="" />
                : <b>{draft.text || "FILIGRANE"}</b>}
            </div>
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
  header, footer, bates, onChange, onClose,
}: {
  header: HeaderFooter;
  footer: HeaderFooter;
  bates: Bates;
  onChange: (v: { header: HeaderFooter; footer: HeaderFooter; bates: Bates }) => void;
  onClose: () => void;
}) {
  const [h, setH] = useState(header);
  const [f, setF] = useState(footer);
  const [b, setB] = useState(bates);
  const [tab, setTab] = useState<"header" | "footer" | "bates">("header");
  const band = tab === "header" ? h : f;
  const setBand = (patch: Partial<HeaderFooter>) => (tab === "header" ? setH((v) => ({ ...v, ...patch })) : setF((v) => ({ ...v, ...patch })));

  return (
    <Modal
      title="En-tête, pied de page et numérotation"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => { onChange({ header: h, footer: f, bates: b }); onClose(); }}>Appliquer</button>
        </>
      }
    >
      <div className="pdfx-segment pdfx-segment--wide">
        <button className={tab === "header" ? "is-on" : ""} onClick={() => setTab("header")}>En-tête</button>
        <button className={tab === "footer" ? "is-on" : ""} onClick={() => setTab("footer")}>Pied de page</button>
        <button className={tab === "bates" ? "is-on" : ""} onClick={() => setTab("bates")}>Numérotation Bates</button>
      </div>

      {tab === "bates" ? (
        <div className="pdfx-form">
          <label className="pdfx-check">
            <input type="checkbox" checked={b.enabled} onChange={(e) => setB({ ...b, enabled: e.target.checked })} />
            Activer la numérotation Bates
          </label>
          <label className="pdfx-form__row"><span>Préfixe</span><input value={b.prefix} onChange={(e) => setB({ ...b, prefix: e.target.value })} /></label>
          <label className="pdfx-form__row"><span>Suffixe</span><input value={b.suffix} onChange={(e) => setB({ ...b, suffix: e.target.value })} /></label>
          <label className="pdfx-form__row"><span>Premier numéro</span><input type="number" min={0} value={b.start} onChange={(e) => setB({ ...b, start: Number(e.target.value) })} /></label>
          <label className="pdfx-form__row"><span>Chiffres</span><input type="number" min={1} max={12} value={b.digits} onChange={(e) => setB({ ...b, digits: Number(e.target.value) })} /></label>
          <p className="pdfx-form__note">Exemple : <b>{b.prefix}{String(b.start).padStart(b.digits, "0")}{b.suffix}</b>. Utilisez <code>{"{bates}"}</code> dans l'en-tête ou le pied pour le placer précisément.</p>
        </div>
      ) : (
        <div className="pdfx-form">
          <label className="pdfx-check">
            <input type="checkbox" checked={band.enabled} onChange={(e) => setBand({ enabled: e.target.checked })} />
            Activer {tab === "header" ? "l'en-tête" : "le pied de page"}
          </label>
          <div className="pdfx-triple">
            <label><span>Gauche</span><input value={band.left} onChange={(e) => setBand({ left: e.target.value })} /></label>
            <label><span>Centre</span><input value={band.center} onChange={(e) => setBand({ center: e.target.value })} /></label>
            <label><span>Droite</span><input value={band.right} onChange={(e) => setBand({ right: e.target.value })} /></label>
          </div>
          <div className="pdfx-tokens">
            {TOKENS.map((t) => (
              <button key={t} className="pdfx-token" onClick={() => setBand({ center: `${band.center}${t}` })} title="Insérer au centre">{t}</button>
            ))}
          </div>
          <div className="pdfx-triple">
            <label><span>Taille</span><input type="number" min={5} max={24} value={band.fontSize} onChange={(e) => setBand({ fontSize: Number(e.target.value) })} /></label>
            <label><span>Couleur</span><input type="color" value={band.color} onChange={(e) => setBand({ color: e.target.value })} /></label>
            <label><span>Marge (pt)</span><input type="number" min={8} max={120} value={band.marginPt} onChange={(e) => setBand({ marginPt: Number(e.target.value) })} /></label>
          </div>
          <label className="pdfx-form__row">
            <span>Pages</span>
            <input value={band.pages} placeholder="toutes, ou 2-, ou 1-3, 7" onChange={(e) => setBand({ pages: e.target.value })} />
          </label>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Document properties
// ---------------------------------------------------------------------------

export function PropertiesDialog({
  info, metadata, sizeBytes, onChange, onClose,
}: {
  info: DocInfo;
  metadata: DocMetadata;
  sizeBytes: number;
  onChange: (v: DocMetadata) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DocMetadata>(metadata);
  const set = (patch: Partial<DocMetadata>) => setDraft((v) => ({ ...v, ...patch }));
  return (
    <Modal
      title="Propriétés du document"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => { onChange(draft); onClose(); }}>Enregistrer</button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row"><span>Titre</span><input value={draft.title ?? ""} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="pdfx-form__row"><span>Auteur</span><input value={draft.author ?? ""} onChange={(e) => set({ author: e.target.value })} /></label>
        <label className="pdfx-form__row"><span>Objet</span><input value={draft.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} /></label>
        <label className="pdfx-form__row"><span>Mots-clés</span><input value={draft.keywords ?? ""} onChange={(e) => set({ keywords: e.target.value })} placeholder="séparés par des virgules" /></label>
        <label className="pdfx-form__row"><span>Langue</span><input value={draft.language ?? ""} onChange={(e) => set({ language: e.target.value })} placeholder="fr-FR" /></label>

        <dl className="pdfx-facts">
          <div><dt>Pages</dt><dd>{info.pageCount}</dd></div>
          <div><dt>Taille</dt><dd>{formatBytes(sizeBytes)}</dd></div>
          <div><dt>Version PDF</dt><dd>{info.pdfVersion ?? "—"}</dd></div>
          <div><dt>Producteur</dt><dd>{info.producer ?? "—"}</dd></div>
          <div><dt>Créé avec</dt><dd>{info.creator ?? "—"}</dd></div>
          <div><dt>Formulaire</dt><dd>{info.isXfa ? "XFA (lecture seule)" : info.hasAcroForm ? "AcroForm" : "Aucun"}</dd></div>
          <div><dt>Signature</dt><dd>{info.signed ? "Présente" : "Aucune"}</dd></div>
          <div><dt>Chiffrement</dt><dd>{info.encrypted ? "Protégé par mot de passe" : "Aucun"}</dd></div>
        </dl>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Export images
// ---------------------------------------------------------------------------

export function ExportImagesDialog({
  pageCount, onConfirm, onClose,
}: {
  pageCount: number;
  onConfirm: (v: { format: "png" | "jpeg" | "webp"; dpi: number; quality: number; range: string; zip: boolean }) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"png" | "jpeg" | "webp">("png");
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
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ format, dpi, quality, range, zip })}>Exporter</button>
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
          </select>
        </label>
        <label className="pdfx-form__row">
          <span>Résolution</span>
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[72, 96, 150, 200, 300, 600].map((d) => <option key={d} value={d}>{d} ppp</option>)}
          </select>
        </label>
        {format !== "png" && (
          <label className="pdfx-form__row">
            <span>Qualité</span>
            <span className="pdfx-insp-inline">
              <input type="range" min={0.3} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
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
  pageCount, localModels, running, progress, onConfirm, onCancel, onClose,
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
        running
          ? <button className="eb eb--outline eb--sm" onClick={onCancel}>Interrompre</button>
          : (
            <>
              <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
              <button className="eb eb--primary eb--sm" disabled={!languages.length} onClick={() => onConfirm({ languages, dpi, range, skipPagesWithText: skip })}>
                Lancer
              </button>
            </>
          )
      }
    >
      {running ? (
        <div className="pdfx-progress-box">
          <Loader2 size={28} className="pdfx-spin" />
          <p>Page {progress?.page ?? 0} / {progress?.total ?? 0} — {progress?.stage ?? "préparation"}</p>
          <div className="pdfx-bar"><span style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} /></div>
        </div>
      ) : (
        <div className="pdfx-form">
          <p className="pdfx-form__lead">
            Ajoute un calque de texte invisible aligné sur l'image : la page reste identique, mais devient sélectionnable et cherchable.
          </p>
          <fieldset className="pdfx-form__set">
            <legend>Langues</legend>
            <div className="pdfx-chips">
              {OCR_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  className={`pdfx-chip ${languages.includes(l.code) ? "is-on" : ""}`}
                  onClick={() => setLanguages((v) => (v.includes(l.code) ? v.filter((c) => c !== l.code) : [...v, l.code]))}
                >
                  {languages.includes(l.code) && <Check size={12} />}{l.label}
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
              Les modèles de langue ne sont pas embarqués dans cette installation : ils seront téléchargés une seule fois.
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
  saved, onUse, onSave, onDelete, onClose,
}: {
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
    const move = (ev: PointerEvent) => { stroke.push(at(ev)); setDirty((v) => !v); };
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
    if (!made) return;
    if (store) {
      onSave({ id: `sig_${Date.now().toString(36)}`, kind: "signature", src: made.src, ratio: made.ratio, createdAt: new Date().toISOString() });
    }
    onUse(made);
  };

  return (
    <Modal
      title="Signature"
      onClose={onClose}
      wide
      footer={
        <>
          <label className="pdfx-check"><input type="checkbox" checked={store} onChange={(e) => setStore(e.target.checked)} /> Mémoriser</label>
          <span className="pdfx-spacer" />
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={confirm}>Placer sur la page</button>
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
                  <img src={s.src} alt="" />
                </button>
                <button className="pdfx-saved-sig__del" onClick={() => onDelete(s.id)} title="Supprimer"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pdfx-segment pdfx-segment--wide">
        <button className={tab === "draw" ? "is-on" : ""} onClick={() => setTab("draw")}>Dessiner</button>
        <button className={tab === "type" ? "is-on" : ""} onClick={() => setTab("type")}>Saisir</button>
        <button className={tab === "import" ? "is-on" : ""} onClick={() => setTab("import")}>Importer</button>
      </div>

      <div className="pdfx-sigarea">
        {tab === "draw" && (
          <>
            <canvas
              ref={canvasRef}
              className="pdfx-sigpad"
              width={760}
              height={220}
              onPointerDown={startStroke}
            />
            <div className="pdfx-sigpad__tools">
              <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} title="Couleur d'encre" />
              <button className="pdfx-mini" onClick={() => { strokes.current = []; setDirty((v) => !v); }}><Eraser size={13} /> Effacer</button>
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
            {imported ? <img src={imported.src} alt="" /> : <p>Photographiez ou scannez votre signature sur une feuille blanche.<br />Le fond sera automatiquement rendu transparent.</p>}
            <button className="pdfx-mini" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choisir une image…</button>
            <input
              ref={fileRef} type="file" accept="image/*" hidden
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
  pageCount, hasBookmarks, onConfirm, onClose,
}: {
  pageCount: number;
  hasBookmarks: boolean;
  onConfirm: (v: { mode: "everyN" | "ranges" | "maxSize" | "bookmarks"; n: number; spec: string; maxMb: number }) => void;
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
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ mode, n, spec, maxMb })}>Diviser</button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-radio"><input type="radio" checked={mode === "everyN"} onChange={() => setMode("everyN")} /><span><b>Toutes les N pages</b></span></label>
        {mode === "everyN" && <label className="pdfx-form__row"><span>Pages par fichier</span><input type="number" min={1} max={pageCount} value={n} onChange={(e) => setN(Number(e.target.value))} /></label>}
        <label className="pdfx-radio"><input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} /><span><b>Plages personnalisées</b><small>Séparez les fichiers par un point-virgule.</small></span></label>
        {mode === "ranges" && <label className="pdfx-form__row"><span>Plages</span><input value={spec} onChange={(e) => setSpec(e.target.value)} /></label>}
        <label className="pdfx-radio"><input type="radio" checked={mode === "maxSize"} onChange={() => setMode("maxSize")} /><span><b>Taille maximale</b></span></label>
        {mode === "maxSize" && <label className="pdfx-form__row"><span>Mo par fichier</span><input type="number" min={1} value={maxMb} onChange={(e) => setMaxMb(Number(e.target.value))} /></label>}
        <label className="pdfx-radio">
          <input type="radio" checked={mode === "bookmarks"} onChange={() => setMode("bookmarks")} disabled={!hasBookmarks} />
          <span><b>Aux signets de premier niveau</b>{!hasBookmarks && <small>Ce document n'a pas de signets.</small>}</span>
        </label>
      </div>
    </Modal>
  );
}

export function CropDialog({
  current, onConfirm, onClose,
}: {
  current: { top: number; right: number; bottom: number; left: number };
  onConfirm: (v: { crop: { top: number; right: number; bottom: number; left: number }; scope: "selection" | "all" }) => void;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState(current);
  const [scope, setScope] = useState<"selection" | "all">("all");
  return (
    <Modal
      title="Recadrer les pages"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={() => onConfirm({ crop: { top: 0, right: 0, bottom: 0, left: 0 }, scope })}>Réinitialiser</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ crop, scope })}>Appliquer</button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">Marges à retirer, en points (1 pt = 0,353 mm).</p>
        <div className="pdfx-cropgrid">
          <label><span>Haut</span><input type="number" min={0} value={crop.top} onChange={(e) => setCrop({ ...crop, top: Number(e.target.value) })} /></label>
          <label><span>Bas</span><input type="number" min={0} value={crop.bottom} onChange={(e) => setCrop({ ...crop, bottom: Number(e.target.value) })} /></label>
          <label><span>Gauche</span><input type="number" min={0} value={crop.left} onChange={(e) => setCrop({ ...crop, left: Number(e.target.value) })} /></label>
          <label><span>Droite</span><input type="number" min={0} value={crop.right} onChange={(e) => setCrop({ ...crop, right: Number(e.target.value) })} /></label>
        </div>
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

export function PageLabelsDialog({
  onConfirm, onClose,
}: {
  onConfirm: (v: { style: "decimal" | "roman" | "ROMAN" | "alpha" | "ALPHA" | "none"; prefix: string; start: number; scope: "selection" | "all" }) => void;
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
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ style, prefix, start, scope })}>Appliquer</button>
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
        <label className="pdfx-form__row"><span>Préfixe</span><input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ex. Annexe-" /></label>
        <label className="pdfx-form__row"><span>Commencer à</span><input type="number" min={1} value={start} onChange={(e) => setStart(Number(e.target.value))} /></label>
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
  value, onConfirm, onClose,
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
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ unitsPerPoint: perPoint, unit, precision })}>Appliquer</button>
        </>
      }
    >
      <div className="pdfx-form">
        <p className="pdfx-form__lead">Indiquez la correspondance entre le document et la réalité.</p>
        <div className="pdfx-scalerow">
          <input type="number" min={0.01} step="0.01" value={pageLength} onChange={(e) => setPageLength(Number(e.target.value))} />
          <span>pouce sur la page</span>
          <b>=</b>
          <input type="number" min={0.0001} step="0.0001" value={realLength} onChange={(e) => setRealLength(Number(e.target.value))} />
          <input className="pdfx-unitinput" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <label className="pdfx-form__row"><span>Décimales</span><input type="number" min={0} max={6} value={precision} onChange={(e) => setPrecision(Number(e.target.value))} /></label>
        <p className="pdfx-form__note">Soit <b>1 pt = {perPoint.toFixed(6)} {unit}</b>.</p>
      </div>
    </Modal>
  );
}

export function CompareDialog({
  report, busy, onPick, onGoTo, onClose,
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
            {busy ? <><Loader2 size={14} className="pdfx-spin" /> Analyse…</> : <><FileText size={14} /> Choisir un PDF…</>}
          </button>
        </div>
      ) : (
        <div className="pdfx-compare">
          <div className="pdfx-compare__stats">
            <div><b>{Math.round(report.similarity * 100)} %</b><span>de similitude</span></div>
            <div><b>{report.wordsAdded}</b><span>mots ajoutés</span></div>
            <div><b>{report.wordsRemoved}</b><span>mots supprimés</span></div>
            <div><b>{report.pagesModified}</b><span>pages modifiées</span></div>
            <div><b>{report.pagesAdded}</b><span>pages ajoutées</span></div>
            <div><b>{report.pagesRemoved}</b><span>pages retirées</span></div>
          </div>
          <div className="pdfx-compare__list">
            {report.pages.filter((pg) => pg.status !== "unchanged").map((pg, i) => (
              <div key={i} className={`pdfx-compare__page is-${pg.status}`}>
                <header>
                  <button onClick={() => pg.leftPage && onGoTo(pg.leftPage)}>
                    {pg.status === "added" ? `Page ${pg.rightPage} ajoutée`
                      : pg.status === "removed" ? `Page ${pg.leftPage} supprimée`
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
            {!report.pages.some((pg) => pg.status !== "unchanged") && <p className="pdfx-empty">Les deux documents sont identiques.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function InsertPagesDialog({
  pageCount, onConfirm, onClose,
}: {
  pageCount: number;
  onConfirm: (v: { where: "before" | "after" | "end"; at: number; count: number; size: string }) => void;
  onClose: () => void;
}) {
  const [where, setWhere] = useState<"before" | "after" | "end">("after");
  const [at, setAt] = useState(1);
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("A4");
  return (
    <Modal
      title="Insérer des pages blanches"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" onClick={() => onConfirm({ where, at, count, size })}>Insérer</button>
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
          <label className="pdfx-form__row"><span>Page</span><input type="number" min={1} max={pageCount} value={at} onChange={(e) => setAt(Number(e.target.value))} /></label>
        )}
        <label className="pdfx-form__row"><span>Nombre</span><input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <label className="pdfx-form__row">
          <span>Format</span>
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((k) => <option key={k} value={k}>{k}</option>)}
            <option value="same">Comme la page courante</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

export function RedactSearchDialog({
  onConfirm, onClose,
}: {
  onConfirm: (v: { query: string; wholeWord: boolean; caseSensitive: boolean; regex: boolean }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const presets = useMemo(() => ([
    { label: "Adresses e-mail", pattern: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+" },
    { label: "Numéros de téléphone", pattern: "(?:\\+33|0)\\s?[1-9](?:[\\s.-]?\\d{2}){4}" },
    { label: "IBAN", pattern: "[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}" },
    { label: "Numéro de sécurité sociale", pattern: "[12]\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}" },
  ]), []);
  return (
    <Modal
      title="Marquer par recherche"
      onClose={onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={onClose}>Annuler</button>
          <button className="eb eb--primary eb--sm" disabled={!query} onClick={() => onConfirm({ query, wholeWord, caseSensitive, regex })}>Marquer tout</button>
        </>
      }
    >
      <div className="pdfx-form">
        <label className="pdfx-form__row"><span>Texte à caviarder</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="pdfx-chips">
          {presets.map((p) => (
            <button key={p.label} className="pdfx-chip" onClick={() => { setQuery(p.pattern); setRegex(true); }}>{p.label}</button>
          ))}
        </div>
        <label className="pdfx-check"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Respecter la casse</label>
        <label className="pdfx-check"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Mot entier</label>
        <label className="pdfx-check"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Expression régulière</label>
      </div>
    </Modal>
  );
}
