import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { X, Lock } from "lucide-react";
import { Button } from "./ui/components";
import HomeView from "./views/HomeView";
// Heavy per-app views are code-split: their editors (tiptap, sheet & slides
// engines, pdf/cloud SDKs) stay out of the main bundle and load on demand.
const StudioView = lazy(() => import("./views/StudioView"));   // rich-text editor (tiptap)
const SheetView = lazy(() => import("./views/SheetView"));      // spreadsheet engine
const SlidesView = lazy(() => import("./views/SlidesView"));    // slides engine
const PdfView = lazy(() => import("./pdf/PdfView")); // pdf.js stays out of the main bundle
const DriveCloudView = lazy(() => import("./views/DriveCloudView")); // cloud SDK out of the main bundle
const OpenLinkView = lazy(() => import("./drive-cloud/ui/OpenLinkView")); // public share-link opener
const PresenterView = lazy(() => import("./slides/PresenterView")); // 2nd-screen speaker window
import type { Workbook } from "./sheet/model";
import type { Deck } from "./slides/model";
import type { PdfDoc } from "./pdf/model";
import SignatureCreator, { type SignatureDraft } from "./sign/SignatureCreator";
import PasswordModal, { type SecretResult } from "./components/PasswordModal";
import SettingsModal from "./components/SettingsModal";
import IdentityBackupModal from "./components/IdentityBackupModal";
import IdentityImportModal from "./components/IdentityImportModal";
import { getTheme, setTheme as persistTheme, type Theme } from "./ui/theme";
import { useDialogs } from "./ui/dialogs";
import { createEliumFile, setProfile, addSignature, removeSignature as removeSig } from "./format/document";
import { docKeyOf } from "./format/doc-key";
import {
  readEliumPackage, writeEliumPackage, looksLikeV4Package, EliumPasswordRequired, EliumRecipientKeyRequired,
  type IntegrityVerdict,
} from "./format/elium-package";
import {
  loadRecipientPublic, hasRecipientKey, generateAndStoreRecipientKey, unlockRecipientKey, forgetRecipientKey,
  type RecipientPublic,
} from "./crypto/recipient-key-store";
import { verifyJournal, type JournalVerdict } from "./format/journal";
import { profileOf } from "./format/profiles";
import { randomId, fromHex } from "./format/canonical";
import { strToU8, strFromU8 } from "fflate";
import { verifyProof, createProof } from "./sign/proof";
import { verifySeal, type SealVerdict } from "./sign/seal";
import { checkSealPin, pinSeal, repinSeal, type SealPinCheck } from "./sign/seal-pinning";
import { importToDoc } from "./format/importers";
import { docToDocx, docxToDoc } from "./format/docx";
import { putDriveDoc, reencryptDriveVault } from "./format/drive-store";
import { putDraft, getDraft, resolveDraft, type DraftContent } from "./format/drafts-store";
import { reencryptParapheurVault } from "./format/parapheur-store";
import { isVaultConfigured, setVaultPassword, verifyVaultPassword, removeVaultConfig } from "./format/vault-store";
import { hasVaultSecret, type VaultSecret } from "./crypto/local-vault";
import { generateIdentity as genId, type EliumIdentity } from "./sign/keys";
import {
  loadStoredIdentity, saveStoredIdentity, encryptPrivateKey, buildKeyFile, keyFileName,
  parseKeyFile, restoreFromKeyFile, identityFromPrivateHex, copyText,
} from "./sign/identity-store";
import { EliumCryptoEngine } from "./crypto/elium-crypto";
import { exportHtml, exportMarkdown, exportText, exportPdf, exportProofReport, downloadBlob } from "./export/exporters";
import type { Template } from "./editor/templates";
import type {
  EliumFile, EliumProfile, EliumSignature, ProseMirrorNode, SignatureVerdict, PageSettings,
} from "./format/types";
import type { ExportKind, Studio, StudioMode } from "./studio/types";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function computeVerdicts(f: EliumFile, trusted: string): Promise<Record<string, SignatureVerdict>> {
  const pairs = await Promise.all(
    f.signatures.map(async (s) => [s.id, await verifyProof(s, f.document, trusted || undefined)] as const),
  );
  return Object.fromEntries(pairs) as Record<string, SignatureVerdict>;
}

function Toast({ tone, message, onClose }: { tone: "danger" | "success"; message: string; onClose: () => void }) {
  return (
    <div className={`toast toast--${tone}`} role="status">
      <span>{message}</span>
      <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={14} /></button>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<StudioMode>("home");
  const dialogs = useDialogs();
  const [file, setFile] = useState<EliumFile | null>(null);
  const [password, setPassword] = useState("");
  const [selectedSig, setSelectedSig] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, SignatureVerdict>>({});
  const [integrity, setIntegrity] = useState<IntegrityVerdict | null>(null);
  const [journalVerdict, setJournalVerdict] = useState<JournalVerdict | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // The private key is NEVER kept in clear at rest. localStorage holds only the
  // public key, fingerprint, and an Argon2id/AES-GCM-encrypted private key blob.
  // The plaintext key lives in memory only after an explicit unlock.
  const [identity, setIdentity] = useState<EliumIdentity | null>(() => {
    const s = loadStoredIdentity();
    return s ? { publicKeyHex: s.publicKeyHex, fingerprint: s.fingerprint } : null;
  });
  const [trustedKey, setTrustedKey] = useState(() => localStorage.getItem("elium_trusted_key") || "");
  const [sealVerdict, setSealVerdict] = useState<SealVerdict | null>(null);
  const [sealPin, setSealPin] = useState<SealPinCheck | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Keyfile (2nd factor) chosen this session, reused across re-saves. Never persisted.
  const keyfileRef = useRef<Uint8Array | undefined>(undefined);
  // Multi-recipient: recipient public keys this document is encrypted FOR (save),
  // and this user's own recipient public key (to receive).
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientPublic, setRecipientPublic] = useState<RecipientPublic | null>(() => loadRecipientPublic());

  const setTheme = useCallback((t: Theme) => { persistTheme(t); setThemeState(t); }, []);

  const forgetIdentity = useCallback(() => {
    localStorage.removeItem("elium_identity");
    setIdentity(null);
    setToast("Identité oubliée");
  }, []);

  const clearLocalStorage = useCallback(() => {
    localStorage.removeItem("elium_identity");
    localStorage.removeItem("elium_trusted_key");
    localStorage.removeItem("elium_theme");
    localStorage.removeItem("elium_seal_pins");
    forgetRecipientKey();
    setRecipientPublic(null);
    // Also purge the IndexedDB stores (Drive library, app autosaves, version
    // history, parapheur, drafts, vault) — otherwise "données effacées" leaves them behind.
    for (const db of ["elium", "elium-drive", "elium-sheets", "elium-slides", "elium-parapheur", "elium-drafts", "elium-vault"]) {
      try { indexedDB.deleteDatabase(db); } catch { /* best effort */ }
    }
    keyfileRef.current = undefined;
    setIdentity(null);
    setTrustedKey("");
    setSettingsOpen(false);
    vaultPromptedRef.current = false;
    setVaultSecret(undefined);
    setVaultState("none");
    setToast("Données locales effacées");
  }, []);

  const [pw, setPw] = useState<{
    title: string;
    mode: "set" | "enter";
    allowKeyfile: boolean;
    confirmHint?: string;
    resolve: (v: SecretResult | null) => void;
  } | null>(null);
  // Full secret prompt (password + optional keyfile), used for document open/save.
  const askSecret = useCallback(
    (title: string, kind: "set" | "enter", allowKeyfile = false, confirmHint?: string) =>
      new Promise<SecretResult | null>((resolve) => setPw({ title, mode: kind, allowKeyfile, confirmHint, resolve })),
    [],
  );
  // Password-only prompt, used for the signing-key flows (no keyfile).
  const askPassword = useCallback(
    async (title: string, kind: "set" | "enter", confirmHint?: string) => {
      const r = await askSecret(title, kind, false, confirmHint);
      return r ? r.password : null;
    },
    [askSecret],
  );

  // --- Local vault (opt-in app-wide passphrase for Drive/Parapheur at rest) --
  // "none" = never configured (default, unchanged behaviour); "locked" = configured
  // but not yet unlocked this session; "unlocked" = vaultSecret below is usable.
  const [vaultState, setVaultState] = useState<"checking" | "none" | "locked" | "unlocked">("checking");
  const [vaultSecret, setVaultSecret] = useState<VaultSecret | undefined>(undefined);
  const vaultPromptedRef = useRef(false);

  useEffect(() => {
    isVaultConfigured().then((configured) => setVaultState(configured ? "locked" : "none"));
  }, []);

  const unlockVault = useCallback(async () => {
    const pwd = await askPassword("Déverrouiller le coffre local", "enter");
    if (pwd === null) return;
    if (!(await verifyVaultPassword(pwd))) { setError("Mot de passe du coffre local incorrect."); return; }
    setVaultSecret({ password: pwd });
    setVaultState("unlocked");
  }, [askPassword]);

  useEffect(() => {
    if (vaultState === "locked" && !vaultPromptedRef.current) {
      vaultPromptedRef.current = true;
      void unlockVault();
    }
  }, [vaultState, unlockVault]);

  // Drive and Parapheur are two independent IndexedDB databases — there is no
  // single transaction that spans both. Each store's own re-encryption is
  // atomic on its own (see reencryptDriveVault/reencryptParapheurVault — one
  // IndexedDB transaction per store), but if the SECOND store fails after the
  // first one already succeeded, we'd otherwise be left with Drive and
  // Parapheur under two different secrets. Compensate by rolling the first
  // store back to `from` before surfacing the error, so a failure here always
  // leaves the vault exactly as it was — never half-migrated.
  const enableVault = useCallback(async () => {
    if (busy) return;
    const pwd = await askPassword(
      "Créer le mot de passe du coffre local",
      "set",
      "4 caractères minimum. S'applique à toute la bibliothèque et au Parapheur (pas à un document précis). Sans lui, ils sont irrécupérables.",
    );
    if (!pwd) return;
    setBusy(true);
    try {
      await reencryptDriveVault(undefined, { password: pwd });
      try {
        await reencryptParapheurVault(undefined, { password: pwd });
      } catch (e) {
        await reencryptDriveVault({ password: pwd }, undefined).catch(() => {});
        throw e;
      }
      await setVaultPassword(pwd);
      setVaultSecret({ password: pwd });
      setVaultState("unlocked");
      setToast("Coffre local activé — bibliothèque et Parapheur chiffrés sur ce poste");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, askPassword]);

  const changeVaultPassword = useCallback(async () => {
    if (busy || !hasVaultSecret(vaultSecret)) return;
    const newPwd = await askPassword(
      "Nouveau mot de passe du coffre local",
      "set",
      "4 caractères minimum. S'applique à toute la bibliothèque et au Parapheur (pas à un document précis). Sans lui, ils sont irrécupérables.",
    );
    if (!newPwd) return;
    setBusy(true);
    try {
      await reencryptDriveVault(vaultSecret, { password: newPwd });
      try {
        await reencryptParapheurVault(vaultSecret, { password: newPwd });
      } catch (e) {
        await reencryptDriveVault({ password: newPwd }, vaultSecret).catch(() => {});
        throw e;
      }
      await setVaultPassword(newPwd);
      setVaultSecret({ password: newPwd });
      setToast("Mot de passe du coffre local modifié");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, vaultSecret, askPassword]);

  const disableVault = useCallback(async () => {
    if (busy || !hasVaultSecret(vaultSecret)) return;
    if (!(await dialogs.confirm({
      title: "Désactiver le coffre local ?",
      message: "La bibliothèque et le Parapheur redeviendront non chiffrés sur cet ordinateur. Les fichiers .elium déjà enregistrés sur le disque ne sont pas affectés.",
      confirmLabel: "Désactiver",
    }))) return;
    setBusy(true);
    try {
      await reencryptDriveVault(vaultSecret, undefined);
      try {
        await reencryptParapheurVault(vaultSecret, undefined);
      } catch (e) {
        await reencryptDriveVault(undefined, vaultSecret).catch(() => {});
        throw e;
      }
      await removeVaultConfig();
      setVaultSecret(undefined);
      setVaultState("none");
      setToast("Coffre local désactivé");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, vaultSecret, dialogs]);

  // "Forgot vault password": zero-knowledge means it can't be recovered — the
  // only way forward is to drop the locally-cached Drive/Parapheur data (the
  // user's actual .elium files on disk are untouched) and start fresh.
  const resetVault = useCallback(async () => {
    if (!(await dialogs.confirm({
      title: "Réinitialiser le coffre local ?",
      message: "Le mot de passe du coffre ne peut pas être récupéré. Cette action supprime la bibliothèque « Récents » et les circuits Parapheur stockés sur ce poste — vos fichiers .elium sur le disque ne sont pas affectés.",
      danger: true,
      confirmLabel: "Réinitialiser",
    }))) return;
    // Wait for each deletion to actually settle (success/error/blocked by a
    // lingering connection) instead of firing IDBOpenDBRequest and moving on —
    // otherwise the UI could claim "reset" while the databases still exist.
    await Promise.all(
      ["elium-drive", "elium-parapheur", "elium-vault"].map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    );
    vaultPromptedRef.current = false;
    setVaultSecret(undefined);
    setVaultState("none");
    setToast("Coffre local réinitialisé");
  }, [dialogs]);

  const recompute = useCallback(async (f: EliumFile, trusted: string) => {
    setVerdicts(await computeVerdicts(f, trusted));
    setJournalVerdict(await verifyJournal(f.journal));
    const sv = await verifySeal(f.manifest, f.signatures, f.journal, trusted || undefined);
    setSealVerdict(sv);
    // TOFU: pin the seal key on first authentic sight; flag a key change otherwise.
    if (sv === "valid" || sv === "unknown_key") {
      const check = checkSealPin(f.manifest);
      if (check.status === "new") {
        pinSeal(f.manifest);
        setSealPin({ ...check, status: "pinned" });
      } else {
        setSealPin(check);
      }
    } else {
      setSealPin(null);
    }
  }, []);

  // User accepts a changed seal key as the new trusted one for this document.
  const trustSealKey = useCallback(() => {
    if (!file) return;
    repinSeal(file.manifest);
    setSealPin(checkSealPin(file.manifest));
    setToast("Nouvelle clé de sceau épinglée pour ce document");
  }, [file]);

  // Returns the in-memory private key, decrypting the stored blob on demand.
  const ensurePrivateKey = useCallback(async (): Promise<string | null> => {
    if (identity?.privateKeyHex) return identity.privateKeyHex;
    const saved = localStorage.getItem("elium_identity");
    const enc = saved ? (JSON.parse(saved).enc as string | undefined) : undefined;
    if (!enc) {
      setError("Aucune clé privée déverrouillable. Générez une nouvelle identité.");
      return null;
    }
    const pass = await askPassword("Déverrouiller votre clé de signature", "enter");
    if (!pass) return null;
    try {
      const { payload } = await EliumCryptoEngine.decodeContainer(fromHex(enc), pass);
      const privateKeyHex = strFromU8(payload);
      setIdentity((cur) => (cur ? { ...cur, privateKeyHex } : cur));
      return privateKeyHex;
    } catch {
      setError("Mot de passe de la clé incorrect.");
      return null;
    }
  }, [identity, askPassword]);

  // Spreadsheet/presentation apps opened from a .elium (marker-node payload).
  const [appView, setAppView] = useState<{ kind: "sheet" | "slides" | "pdf"; data: unknown } | null>(null);
  const [appKey, setAppKey] = useState(0);

  const loadFile = useCallback(async (f: EliumFile, integ: IntegrityVerdict) => {
    setFile(f);
    setIntegrity(integ);
    setSelectedSig(null);
    await recompute(f, trustedKey);
    setEditorKey((k) => k + 1);
  }, [recompute, trustedKey]);

  // --- Home actions -------------------------------------------------------

  const onCreate = useCallback(async (tpl: Template) => {
    const { title, doc } = tpl.build();
    const f = await createEliumFile({ title, profile: "standard", doc });
    setPassword("");
    await loadFile(f, { contentIntact: true, unchecked: true });
    setMode("studio");
  }, [loadFile]);

  const openLegacy = useCallback(async (bytes: Uint8Array, name: string) => {
    const got = await askPassword(`Fichier hérité (v3) — mot de passe pour « ${name} »`, "enter");
    if (!got) return;
    const { payload } = await EliumCryptoEngine.decodeContainer(bytes, got);
    const textContent = new TextDecoder().decode(payload);
    const doc: ProseMirrorNode = {
      type: "doc",
      content: textContent.split("\n").map((line) => ({
        type: "paragraph",
        ...(line ? { content: [{ type: "text", text: line }] } : {}),
      })),
    };
    const f = await createEliumFile({ title: name.replace(/\.elium$/, ""), profile: "standard", doc });
    setPassword("");
    await loadFile(f, { contentIntact: true, unchecked: true });
    setMode("viewer");
  }, [askPassword, loadFile]);

  const onOpen = useCallback(async (uploaded: File) => {
    setBusy(true);
    try {
      // Import Word .docx as a new editable document (binary).
      const ext = uploaded.name.toLowerCase().split(".").pop() ?? "";
      if (ext === "docx") {
        const { title, doc } = docxToDoc(new Uint8Array(await uploaded.arrayBuffer()));
        const f = await createEliumFile({ title: title || uploaded.name.replace(/\.docx$/i, ""), profile: "standard", doc });
        setPassword("");
        await loadFile(f, { contentIntact: true, unchecked: true });
        setMode("studio");
        return;
      }
      // Import text/Markdown/HTML as a new editable document.
      if (["txt", "md", "markdown", "html", "htm"].includes(ext)) {
        const doc = importToDoc(uploaded.name, await uploaded.text());
        const f = await createEliumFile({ title: uploaded.name.replace(/\.[^.]+$/, ""), profile: "standard", doc });
        setPassword("");
        await loadFile(f, { contentIntact: true, unchecked: true });
        setMode("studio");
        return;
      }
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      if (!looksLikeV4Package(bytes)) {
        await openLegacy(bytes, uploaded.name);
        return;
      }
      let pwd: string | undefined;
      let result;
      try {
        result = await readEliumPackage(bytes, {});
      } catch (e) {
        if (e instanceof EliumRecipientKeyRequired) {
          // Document encrypted for recipients: unlock our recipient key.
          if (!hasRecipientKey()) {
            setError("Ce document est chiffré pour des destinataires. Générez d'abord votre clé de réception (Sécurité).");
            return;
          }
          const got = await askSecret(`Mot de passe de votre clé de réception pour « ${uploaded.name} »`, "enter", false);
          if (!got) return;
          const recipientKey = await unlockRecipientKey(got.password);
          result = await readEliumPackage(bytes, { recipientKey });
        } else if (e instanceof EliumPasswordRequired) {
          const got = await askSecret(`Mot de passe pour « ${uploaded.name} »`, "enter", true);
          if (!got) return;
          pwd = got.password;
          keyfileRef.current = got.keyfile;
          result = await readEliumPackage(bytes, { password: pwd, keyfile: got.keyfile });
        } else throw e;
      }
      // Route spreadsheet/presentation .elium files to their app (marker node).
      const first = result.file.document.doc?.content?.[0];
      if (first && (first.type === "eliumSheet" || first.type === "eliumSlides" || first.type === "eliumPdf")) {
        try {
          const kind = first.type === "eliumSheet" ? "sheet" : first.type === "eliumSlides" ? "slides" : "pdf";
          setAppView({ kind, data: JSON.parse(String(first.attrs?.data ?? "null")) });
          setAppKey((k) => k + 1);
          setMode(kind);
          return;
        } catch {
          /* corrupted app payload — fall through to a normal open */
        }
      }
      setPassword(pwd ?? "");
      await loadFile(result.file, result.integrity);
      setMode("viewer");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [askSecret, loadFile, openLegacy]);

  /** Save a spreadsheet/presentation as an encrypted+sealed .elium and mirror it to the Drive. */
  const exportAppElium = useCallback(
    async (kind: "sheet" | "slides" | "pdf", data: unknown, title: string) => {
      try {
        const label = kind === "sheet" ? "Classeur" : kind === "slides" ? "Présentation" : "Document PDF";
        const wantEnc = await dialogs.confirm({
          title: "Protéger le fichier ?",
          message: "Chiffrer ce fichier (AES-256, mot de passe et/ou fichier-clé) ?\n\nConfirmer = chiffré · Annuler = signé/scellé, non chiffré.",
          confirmLabel: "Chiffrer", cancelLabel: "Signer seulement",
        });
        const secret = wantEnc ? await askSecret("Protéger le fichier (mot de passe et/ou fichier-clé)", "set", true) : null;
        if (wantEnc && !secret) return; // cancelled the password dialog
        const nodeType = kind === "sheet" ? "eliumSheet" : kind === "slides" ? "eliumSlides" : "eliumPdf";
        const doc: ProseMirrorNode = { type: "doc", content: [{ type: nodeType, attrs: { data: JSON.stringify(data) } }] };
        const f = await createEliumFile({ title: title || label, profile: secret ? "encrypted" : "standard", doc });
        const sealKey = identity ? (await ensurePrivateKey()) ?? undefined : undefined;
        const bytes = await writeEliumPackage(f, { password: secret?.password, keyfile: secret?.keyfile, sealPrivateKeyHex: sealKey });
        downloadBlob(`${f.manifest.title}.elium`, "application/x-elium", bytes);
        try {
          await putDriveDoc(
            {
              id: docKeyOf(f.manifest),
              title: f.manifest.title,
              profile: f.manifest.profile,
              savedAt: new Date().toISOString(),
              size: bytes.length,
              bytes,
            },
            vaultSecret,
          );
        } catch {
          /* drive best-effort */
        }
        setToast(`${label} enregistré (.elium${secret ? ", chiffré" : ""}${sealKey ? ", scellé" : ""})`);
      } catch (e) {
        setError(msg(e));
      }
    },
    [identity, ensurePrivateKey, askSecret, dialogs, vaultSecret],
  );

  // Fichier .elium ouvert depuis l'Explorateur Windows : le launcher local le
  // sert sur /__open__ et démarre l'app avec ?open=1.
  const openedFromDisk = useRef(false);
  useEffect(() => {
    if (openedFromDisk.current) return;
    if (new URLSearchParams(window.location.search).get("open") !== "1") return;
    openedFromDisk.current = true;
    (async () => {
      try {
        const r = await fetch("/__open__");
        if (!r.ok) return;
        const name = decodeURIComponent(r.headers.get("X-Elium-Name") ?? "document.elium");
        const bytes = await r.arrayBuffer();
        window.history.replaceState(null, "", window.location.pathname);
        await onOpen(new File([bytes], name));
      } catch {
        /* launcher absent (mode dev) : ignorer */
      }
    })();
  }, [onOpen]);

  // --- Studio actions -----------------------------------------------------

  const setTitle = useCallback((t: string) => {
    setFile((prev) => (prev ? { ...prev, manifest: { ...prev.manifest, title: t } } : prev));
  }, []);

  const setAccessExpiry = useCallback((iso: string | null) => {
    setFile((prev) => {
      if (!prev) return prev;
      const manifest = { ...prev.manifest };
      if (iso) manifest.accessExpiresAt = iso;
      else delete manifest.accessExpiresAt;
      return { ...prev, manifest };
    });
  }, []);

  const setEncryptMetadata = useCallback((on: boolean) => {
    setFile((prev) =>
      prev
        ? { ...prev, manifest: { ...prev.manifest, protection: { ...prev.manifest.protection, metadataEncrypted: on } } }
        : prev,
    );
  }, []);

  // Generate this user's recipient key (so others can encrypt documents to them).
  const generateRecipientKey = useCallback(async () => {
    const got = await askSecret("Définir un mot de passe pour protéger votre clé de réception", "set", false);
    if (!got) return;
    const pub = await generateAndStoreRecipientKey(got.password);
    setRecipientPublic(pub);
    setToast("Clé de réception générée. Partagez votre clé publique pour recevoir des documents chiffrés.");
  }, [askSecret]);

  const forgetMyRecipientKey = useCallback(() => {
    forgetRecipientKey();
    setRecipientPublic(null);
    setToast("Clé de réception oubliée");
  }, []);

  const updatePage = useCallback((patch: Partial<PageSettings>) => {
    setFile((prev) => {
      if (!prev) return prev;
      // `margins` is a nested object — a shallow spread of `patch` would drop
      // any margin not explicitly included in a partial update (e.g. changing
      // just the top margin would erase right/bottom/left). Merge it separately.
      const page = {
        ...prev.document.page,
        ...patch,
        margins: { ...prev.document.page.margins, ...(patch.margins ?? {}) },
      };
      return { ...prev, document: { ...prev.document, page } };
    });
  }, []);

  const setTrusted = useCallback((k: string) => {
    setTrustedKey(k);
    localStorage.setItem("elium_trusted_key", k);
    setFile((prev) => {
      if (prev) computeVerdicts(prev, k).then(setVerdicts);
      return prev;
    });
  }, []);

  const [backupOpen, setBackupOpen] = useState<"generated" | "manual" | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const copyWithToast = useCallback(async (text: string, label: string) => {
    if (await copyText(text)) setToast(label);
    else setError("Impossible d'accéder au presse-papier.");
  }, []);

  const generateIdentity = useCallback(async () => {
    const id = await genId();
    const pass = await askPassword("Définir un mot de passe pour protéger votre clé privée", "set");
    if (!pass) return;
    // Encrypt the private key with Argon2id + AES-256-GCM before it ever touches disk.
    const enc = await encryptPrivateKey(id.privateKeyHex!, pass);
    saveStoredIdentity({ publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc });
    setIdentity(id);
    // Open the backup modal right away: without an export, the key only lives
    // in this browser's storage and a profile reset destroys it for good.
    setBackupOpen("generated");
  }, [askPassword]);

  const exportIdentityFile = useCallback(() => {
    const stored = loadStoredIdentity();
    if (!stored?.enc) {
      setError("Aucune sauvegarde exportable : régénérez ou importez d'abord une clé.");
      return;
    }
    const json = JSON.stringify(buildKeyFile(stored), null, 2);
    downloadBlob(keyFileName(stored.fingerprint), "application/json", strToU8(json));
    setToast("Sauvegarde .eliumkey téléchargée");
  }, []);

  const importIdentityFromFile = useCallback(async (text: string): Promise<boolean> => {
    try {
      const stored = parseKeyFile(text);
      const pass = await askPassword("Mot de passe de la clé sauvegardée", "enter");
      if (!pass) return false;
      const id = await restoreFromKeyFile(stored, pass);
      saveStoredIdentity(stored);
      setIdentity(id);
      setToast("Identité restaurée depuis la sauvegarde");
      return true;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  }, [askPassword]);

  const importIdentityFromHex = useCallback(async (hex: string): Promise<boolean> => {
    try {
      const id = await identityFromPrivateHex(hex);
      const pass = await askPassword("Définir un mot de passe pour protéger votre clé privée", "set");
      if (!pass) return false;
      const enc = await encryptPrivateKey(id.privateKeyHex, pass);
      saveStoredIdentity({ publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc });
      setIdentity(id);
      setToast("Clé privée importée et chiffrée");
      return true;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  }, [askPassword]);

  const changeProfile = useCallback(async (p: EliumProfile) => {
    setBusy(true);
    try {
      setFile((prev) => prev); // ensure latest
      const current = file;
      if (!current) return;
      const nf = await setProfile(current, p);
      setFile(nf);
      await recompute(nf, trustedKey);
    } finally {
      setBusy(false);
    }
  }, [file, recompute, trustedKey]);

  const createSignature = useCallback(async (draft: SignatureDraft) => {
    if (!file) return;
    setBusy(true);
    try {
      const id = randomId("sig");
      let proof = null;
      if (draft.wantsProof && identity) {
        const pk = await ensurePrivateKey();
        if (pk) proof = await createProof({ signatureId: id, model: file.document, signer: draft.signer, privateKeyHex: pk });
      }
      const sig: EliumSignature = {
        id,
        kind: draft.kind,
        visual: draft.visual,
        placement: { page: 1, xPct: 0.34, yPct: 0.78, wPct: 0.3, hPct: 0.12, rotation: 0, z: file.signatures.length, anchorType: "page" },
        signer: draft.signer,
        proof,
        level: proof ? "advanced" : "visual",
        createdAt: new Date().toISOString(),
      };
      const nf = await addSignature(file, sig);
      setFile(nf);
      setCreatorOpen(false);
      setSelectedSig(id);
      await recompute(nf, trustedKey);
    } finally {
      setBusy(false);
    }
  }, [file, identity, recompute, trustedKey, ensurePrivateKey]);

  const updateSignature = useCallback((sig: EliumSignature) => {
    setFile((prev) => (prev ? { ...prev, signatures: prev.signatures.map((s) => (s.id === sig.id ? sig : s)) } : prev));
  }, []);

  const removeSignature = useCallback((id: string) => {
    setFile((prev) => (prev ? removeSig(prev, id) : prev));
    setSelectedSig((cur) => (cur === id ? null : cur));
    setVerdicts((v) => { const { [id]: _drop, ...rest } = v; return rest; });
  }, []);

  const onDocChange = useCallback((docNode: ProseMirrorNode) => {
    setFile((prev) => (prev ? { ...prev, document: { ...prev.document, doc: docNode } } : prev));
  }, []);

  // --- Auto-save / recovery (Documents) -----------------------------------
  // While editing a document, snapshot it to the local drafts store (debounced),
  // so unsaved work survives a crash or an accidental close. Drafts persist
  // until the user deletes them from the Home screen. For a protected document
  // the snapshot is encrypted at rest with the same password/keyfile (see
  // format/drafts-store.ts) — if that secret isn't in memory, the cycle is
  // skipped entirely rather than ever writing the content in clear.
  //
  // `manifest.protection.encrypted` only reflects the LAST WRITTEN/OPENED
  // state of the file — `setProfile`/changeProfile update `manifest.profile`
  // alone and never touch `protection` (that field is only recomputed by
  // `buildManifest` when the package is actually saved/exported). Relying on
  // `protection.encrypted` here would silently autosave in clear the moment a
  // user picks a protected profile but hasn't saved yet, even though the "Protégé"
  // badge is already showing. `needsSecret` below honours the profile the
  // instant it's chosen, not just the last-persisted protection state.
  const lastDraftJson = useRef<string>("");
  useEffect(() => {
    if (mode !== "studio" || !file || file.manifest.protection.locked) return;
    const secret: VaultSecret = { password, keyfile: keyfileRef.current };
    const needsSecret = file.manifest.protection.encrypted || profileOf(file.manifest.profile).encrypted;
    if (needsSecret && !hasVaultSecret(secret)) return;
    // Protection/secret state is part of the change-detection key so a profile
    // change alone (no text edit) still triggers a rewrite — turning a
    // previously plaintext draft into an encrypted one as soon as a secret is
    // available, instead of leaving the stale plaintext record untouched.
    const docJson = JSON.stringify({ t: file.manifest.title, d: file.document.doc, p: needsSecret, s: hasVaultSecret(secret) });
    if (docJson === lastDraftJson.current) return;
    const snapshot = file; // capture
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          await putDraft({
            id: docKeyOf(snapshot.manifest),
            title: snapshot.manifest.title || "Document sans titre",
            profile: snapshot.manifest.profile,
            updatedAt: new Date().toISOString(),
            doc: snapshot.document.doc,
            page: snapshot.document.page,
            docx: needsSecret ? undefined : docToDocx(snapshot),
            secret: needsSecret ? secret : undefined,
          });
          lastDraftJson.current = docJson;
        } catch {
          /* autosave is best-effort; never interrupt editing */
        }
      })();
    }, 2500);
    return () => window.clearTimeout(handle);
  }, [file, mode, password]);

  // Restore a document from an auto-saved draft. Prompts for the password/keyfile
  // first when the draft is protected, and recreates the document with its
  // original protection profile so recovery never silently drops it.
  const recoverDraft = useCallback(async (id: string) => {
    try {
      const d = await getDraft(id);
      if (!d) return;
      let secret: VaultSecret | undefined;
      if (d.protected) {
        const got = await askSecret(`Mot de passe pour restaurer « ${d.title} »`, "enter", true);
        if (!got) return;
        secret = { password: got.password, keyfile: got.keyfile };
      }
      let content: DraftContent;
      try {
        content = await resolveDraft(d, secret);
      } catch {
        setError("Mot de passe incorrect — impossible de déchiffrer ce brouillon.");
        return;
      }
      const f = await createEliumFile({ title: d.title, profile: d.profile, doc: content.doc });
      f.manifest.docId = d.id; // reuse the stored draft's key so further autosaves update the same record
      f.document.page = content.page;
      lastDraftJson.current = JSON.stringify({ t: d.title, d: content.doc });
      setPassword(secret?.password ?? "");
      keyfileRef.current = secret?.keyfile;
      await loadFile(f, { contentIntact: true, unchecked: true });
      setMode("studio");
    } catch (e) {
      setError(msg(e));
    }
  }, [loadFile, askSecret]);

  // Download a draft's recovery .docx. Prompts for the password/keyfile first
  // when the draft is protected — the Word file is only ever built in memory.
  const downloadDraft = useCallback(async (id: string) => {
    try {
      const d = await getDraft(id);
      if (!d) return;
      let secret: VaultSecret | undefined;
      if (d.protected) {
        const got = await askSecret(`Mot de passe pour télécharger « ${d.title} »`, "enter", true);
        if (!got) return;
        secret = { password: got.password, keyfile: got.keyfile };
      }
      let content: DraftContent;
      try {
        content = await resolveDraft(d, secret);
      } catch {
        setError("Mot de passe incorrect — impossible de déchiffrer ce brouillon.");
        return;
      }
      // docToDocx only reads document.doc/document.page and manifest.title —
      // a full EliumFile isn't needed just to render the recovery copy.
      const shape = { manifest: { title: d.title }, document: { doc: content.doc, page: content.page } } as unknown as EliumFile;
      downloadBlob(
        `${d.title || "document"}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        docToDocx(shape),
      );
    } catch (e) {
      setError(msg(e));
    }
  }, [askSecret]);

  const save = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    try {
      const encrypted = profileOf(file.manifest.profile).encrypted;
      const useRecipients = encrypted && recipients.length > 0;
      let pwd = password;
      // Only prompt for a credential when we have NONE: a keyfile (e.g. from
      // opening an eliumkey-protected doc) or recipient encryption is already
      // enough, so editing + re-saving such a file must not nag for a password.
      if (encrypted && !useRecipients && !pwd && !keyfileRef.current) {
        const got = await askSecret("Protéger le document (mot de passe et/ou fichier-clé)", "set", true);
        if (!got) return;
        pwd = got.password;
        setPassword(got.password);
        keyfileRef.current = got.keyfile;
      }
      // Seal the file with the user's identity (tamper-evidence anchor) when available.
      let sealKey: string | undefined;
      if (identity) sealKey = (await ensurePrivateKey()) ?? undefined;
      const bytes = await writeEliumPackage(file, {
        password: useRecipients ? undefined : pwd || undefined,
        keyfile: useRecipients ? undefined : keyfileRef.current,
        recipients: useRecipients ? recipients : undefined,
        sealPrivateKeyHex: sealKey,
        encryptMetadata: !!file.manifest.protection.metadataEncrypted,
      });
      downloadBlob(`${file.manifest.title || "document"}.elium`, "application/x-elium", bytes);
      // Mirror into the local Drive library (best-effort, this browser only).
      try {
        await putDriveDoc(
          {
            id: docKeyOf(file.manifest),
            title: file.manifest.title || "Document",
            profile: file.manifest.profile,
            savedAt: new Date().toISOString(),
            size: bytes.length,
            bytes,
          },
          vaultSecret,
        );
      } catch {
        /* la bibliothèque locale est best-effort */
      }
      await recompute(file, trustedKey);
      if (sealKey) setSealVerdict("valid");
      const how = useRecipients ? ` pour ${recipients.length} destinataire(s)` : keyfileRef.current ? " et fichier-clé" : "";
      setToast(sealKey ? `Document enregistré et scellé${how} (.elium)` : `Document enregistré${how} (.elium)`);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [askSecret, file, password, recompute, trustedKey, identity, ensurePrivateKey, recipients, vaultSecret]);

  const exportAs = useCallback(async (kind: ExportKind) => {
    if (!file) return;
    try {
      const v = await computeVerdicts(file, trustedKey);
      setVerdicts(v);
      if (kind === "html") exportHtml(file, v);
      else if (kind === "md") exportMarkdown(file);
      else if (kind === "text") exportText(file);
      else if (kind === "pdf") exportPdf(file, v);
      else if (kind === "report") await exportProofReport(file, v);
      else if (kind === "docx") {
        downloadBlob(
          `${file.manifest.title || "document"}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          docToDocx(file),
        );
      }
    } catch (e) {
      setError(msg(e));
    }
  }, [file, trustedKey]);

  const goHome = useCallback(() => setMode("home"), []);
  const toViewer = useCallback(async () => {
    if (file) await recompute(file, trustedKey);
    setMode("viewer");
  }, [file, recompute, trustedKey]);
  const toEditor = useCallback(() => setMode("studio"), []);

  // --- Build studio contract ---------------------------------------------

  // The owner (who holds the credential) can edit ANY of their .elium files,
  // including locked / secure_max profiles — re-saving simply regenerates the
  // seal. The "locked" flag is informational here, not a read-only wall.
  const editable = mode === "studio" && !!file;

  const studio: Studio | null = file
    ? {
        file, editable, identity, trustedKey, verdicts, integrity, journalVerdict, sealVerdict, sealPin, selectedSig, busy,
        versionSecret: { password, keyfile: keyfileRef.current },
        vaultSecret,
        recipients, recipientPublic,
        setTitle, setTrustedKey: setTrusted, generateIdentity, changeProfile, setAccessExpiry, setEncryptMetadata, updatePage,
        setRecipients, generateRecipientKey, forgetRecipientKey: forgetMyRecipientKey,
        openSignatureCreator: () => setCreatorOpen(true),
        createSignature, updateSignature, removeSignature, selectSignature: setSelectedSig,
        onDocChange, save, exportAs, goHome, toViewer, toEditor, trustSealKey,
        openSettings: () => setSettingsOpen(true),
      }
    : null;

  // The presenter window (?presenter=1) is a standalone speaker screen driven
  // entirely by BroadcastChannel from the main window — no vault, server or deck.
  const isPresenter = (() => {
    try { return new URLSearchParams(window.location.search).get("presenter") === "1"; } catch { return false; }
  })();
  if (isPresenter) {
    return (
      <Suspense fallback={<div className="pv pv--empty">Chargement de la vue présentateur…</div>}>
        <PresenterView />
      </Suspense>
    );
  }

  // A public share link (?link=…) takes over the whole app — no account needed;
  // the decryption secret lives in the URL fragment (never sent to the server).
  const linkToken = (() => {
    try { return new URLSearchParams(window.location.search).get("link"); } catch { return null; }
  })();
  if (linkToken) {
    return (
      <div className="app">
        <Suspense fallback={<div className="pdf-loading">Ouverture du lien chiffré…</div>}>
          <OpenLinkView
            token={linkToken}
            onHome={() => {
              try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ }
              window.location.reload();
            }}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="app">
      {vaultState === "checking" ? (
        <div className="vault-gate" aria-hidden="true" />
      ) : vaultState === "locked" ? (
        <div className="vault-gate">
          <div className="vault-gate__card">
            <Lock size={28} />
            <h1>Coffre local verrouillé</h1>
            <p>Ce poste a un coffre local configuré pour protéger la bibliothèque et le Parapheur. Déverrouillez-le pour continuer.</p>
            <Button onClick={() => void unlockVault()}>Déverrouiller</Button>
            <button type="button" className="vault-gate__forgot" onClick={() => void resetVault()}>
              Mot de passe oublié ?
            </button>
          </div>
        </div>
      ) : mode === "sheet" ? (
        <Suspense fallback={<div className="pdf-loading">Chargement du Tableur…</div>}>
          <SheetView
            key={`sheet-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "sheet" ? (appView.data as Workbook) : undefined}
            onExportElium={(data, title) => exportAppElium("sheet", data, title)}
          />
        </Suspense>
      ) : mode === "slides" ? (
        <Suspense fallback={<div className="pdf-loading">Chargement des Présentations…</div>}>
          <SlidesView
            key={`slides-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "slides" ? (appView.data as Deck) : undefined}
            onExportElium={(data, title) => exportAppElium("slides", data, title)}
          />
        </Suspense>
      ) : mode === "pdf" ? (
        <Suspense fallback={<div className="pdf-loading">Chargement du lecteur PDF…</div>}>
          <PdfView
            key={`pdf-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "pdf" ? (appView.data as PdfDoc) : undefined}
            onExportElium={(data, title) => exportAppElium("pdf", data, title)}
          />
        </Suspense>
      ) : mode === "drive-cloud" ? (
        <Suspense fallback={<div className="pdf-loading">Chargement du Drive entreprise…</div>}>
          <DriveCloudView onHome={() => setMode("home")} />
        </Suspense>
      ) : mode === "home" || !studio ? (
        <HomeView
          onCreate={onCreate}
          onOpen={onOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSheet={() => { setAppView(null); setAppKey((k) => k + 1); setMode("sheet"); }}
          onNewSlides={() => { setAppView(null); setAppKey((k) => k + 1); setMode("slides"); }}
          onNewPdf={() => { setAppView(null); setAppKey((k) => k + 1); setMode("pdf"); }}
          onOpenDriveCloud={() => setMode("drive-cloud")}
          onRecoverDraft={recoverDraft}
          onDownloadDraft={downloadDraft}
          vaultSecret={vaultSecret}
        />
      ) : (
        <Suspense fallback={<div className="pdf-loading">Chargement de l'éditeur…</div>}>
          <StudioView key={`${editorKey}-${editable}`} studio={studio} />
        </Suspense>
      )}

      {settingsOpen && (
        <SettingsModal
          theme={theme}
          onSetTheme={setTheme}
          identity={identity}
          trustedKey={trustedKey}
          onSetTrustedKey={setTrusted}
          onRegenerateIdentity={generateIdentity}
          onForgetIdentity={forgetIdentity}
          onBackupIdentity={() => setBackupOpen("manual")}
          onImportIdentity={() => setImportOpen(true)}
          onCopy={copyWithToast}
          onClearStorage={clearLocalStorage}
          onClose={() => setSettingsOpen(false)}
          vaultEnabled={vaultState === "unlocked"}
          busy={busy}
          onEnableVault={enableVault}
          onChangeVaultPassword={changeVaultPassword}
          onDisableVault={disableVault}
        />
      )}

      {backupOpen && identity && (
        <IdentityBackupModal
          identity={identity}
          justGenerated={backupOpen === "generated"}
          onExportFile={exportIdentityFile}
          onCopy={copyWithToast}
          onRevealPrivateKey={ensurePrivateKey}
          onClose={() => setBackupOpen(null)}
        />
      )}

      {importOpen && (
        <IdentityImportModal
          hasExistingIdentity={!!identity}
          onImportFile={importIdentityFromFile}
          onImportHex={importIdentityFromHex}
          onClose={() => setImportOpen(false)}
        />
      )}

      {creatorOpen && studio && (
        <SignatureCreator
          hasIdentity={!!identity}
          identityFingerprint={identity?.fingerprint}
          onClose={() => setCreatorOpen(false)}
          onCreate={createSignature}
        />
      )}

      {pw && (
        <PasswordModal
          title={pw.title}
          mode={pw.mode}
          allowKeyfile={pw.allowKeyfile}
          confirmHint={pw.confirmHint}
          onSubmit={(v) => { pw.resolve(v); setPw(null); }}
          onCancel={() => { pw.resolve(null); setPw(null); }}
        />
      )}

      {error && <Toast tone="danger" message={error} onClose={() => setError(null)} />}
      {toast && <Toast tone="success" message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
