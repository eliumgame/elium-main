import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Lock, Loader2 } from "lucide-react";
import { Button } from "./ui/components";
import HomeView from "./views/HomeView";
// Heavy per-app views are code-split: their editors (tiptap, sheet & slides
// engines, pdf/cloud SDKs) stay out of the main bundle and load on demand.
const StudioView = lazy(() => import("./views/StudioView")); // rich-text editor (tiptap)
const SheetView = lazy(() => import("./views/SheetView")); // spreadsheet engine
const SlidesView = lazy(() => import("./views/SlidesView")); // slides engine
const PdfView = lazy(() => import("./pdf/PdfView")); // pdf.js stays out of the main bundle
const DriveCloudView = lazy(() => import("./views/DriveCloudView")); // cloud SDK out of the main bundle
const OpenLinkView = lazy(() => import("./drive-cloud/ui/OpenLinkView")); // public share-link opener
const SignLinkView = lazy(() => import("./drive-cloud/ui/SignLinkView")); // public sign-request opener (Approche A)
const DocumentationView = lazy(() => import("./docs/DocumentationView")); // doc unique in-app (hors bundle principal)
const DetectorView = lazy(() => import("./detector/ui/DetectorView")); // analyse IA/plagiat, hors bundle principal
const PresenterView = lazy(() => import("./slides/PresenterView")); // 2nd-screen speaker window
import type { Workbook } from "./sheet/model";
import type { Deck } from "./slides/model";
import type { PdfFile } from "./pdf/model/persist";
import SignatureCreator, { type SignatureDraft } from "./sign/SignatureCreator";
import PasswordModal, { type SecretResult } from "./components/PasswordModal";
import SettingsModal from "./components/SettingsModal";
import IdentityBackupModal from "./components/IdentityBackupModal";
import IdentityImportModal from "./components/IdentityImportModal";
import { getTheme, setTheme as persistTheme, type Theme } from "./ui/theme";
import { useDialogs } from "./ui/dialogs";
import { t, tn, useI18n } from "./i18n";
import { getPrefs, usePrefs } from "./settings/prefs";
import { isCapturingShortcut, shortcutFor, useBindings } from "./settings/shortcuts";
import { commandRegistry, useRegisterCommands, type AppCommand } from "./commands/registry";
import type { WorkspaceSettingsBridge } from "./components/settings/WorkspaceSection";
import { setLocale, getLocale } from "./i18n";
import CommandPalette from "./components/CommandPalette";
import type { CategoryId, SectionId } from "./components/settings/sections";
import type { ShellView } from "./workspace/ui/Sidebar";
import { useWorkspace } from "./workspace/useWorkspace";
import { useSearch } from "./workspace/useSearch";
import { currentSession } from "./workspace/session";
import { reencryptAll } from "./workspace/vault-sync";
import { vaultParticipants } from "./workspace/content";
import { createReplaceDeps } from "./workspace/replace-io";
import { importPdf, isPdfFile, libraryDestination } from "./workspace/pdf-library";
import { pdfStore } from "./workspace/pdf-store";
import { docText } from "./workspace/search/text";
import { previewOf } from "./workspace/recovery";
import {
  consumeLaunchQueue,
  ensurePermission,
  fsAccessSupported,
  pickFileToOpen,
  pickSaveHandle,
  permissionOf,
  planSave,
  recallHandle,
  rememberHandle,
  writeToHandle,
  type FsFileHandle,
  type PickedFile,
} from "./workspace/fs-access";
import { getDriveDoc } from "./format/drive-store";
import {
  createEliumFile,
  setProfile,
  addSignature,
  removeSignature as removeSig,
  recordSave,
  tracksJournal,
  type PendingJournalEvent,
} from "./format/document";
import { docKeyOf } from "./format/doc-key";
import {
  readEliumPackage,
  writeEliumPackage,
  verifyLoadedSeal,
  looksLikeV4Package,
  EliumPasswordRequired,
  EliumRecipientKeyRequired,
  type IntegrityVerdict,
} from "./format/elium-package";
import { useKeyring, KeyringContext, type KeyringController } from "./crypto/use-keyring";
import { verifyJournal, type JournalVerdict } from "./format/journal";
import { profileOf } from "./format/profiles";
import { randomId, nowIso } from "./format/canonical";
import { verifyProof, createProof } from "./sign/proof";
import { type SealVerdict } from "./sign/seal";
import { checkSealPin, pinSeal, repinSeal, type SealPinCheck } from "./sign/seal-pinning";
import {
  loadTrustBook,
  findContact,
  trustContact as storeTrustContact,
  untrustContact as storeUntrustContact,
  migrateLegacyTrustedKey,
  type TrustedContact,
  type TrustOptions,
} from "./sign/trust-book";
import { importToDoc } from "./format/importers";
import { fontResources, syncEmbeddedFonts } from "./format/embedded-fonts";
import { embeddableFonts, registerEmbeddedFonts } from "./ui/fonts";
import { docToDocx, docxToDoc } from "./format/docx";
import { reportError } from "./ui/crash-log";
import { fetchLauncherFile, watchLauncherInbox } from "./desktop/launcher-bridge";
import { putDriveDoc } from "./format/drive-store";
import { putDraft, getDraft, resolveDraft, deleteDraft, type DraftContent } from "./format/drafts-store";
import { isVaultConfigured, setVaultPassword, verifyVaultPassword, removeVaultConfig } from "./format/vault-store";
import { hasVaultSecret, type VaultSecret } from "./crypto/local-vault";
import { type EliumIdentity } from "./sign/keys";
import { identityFromPrivateHex, copyText } from "./sign/identity-store";
import { EliumCryptoEngine } from "./crypto/elium-crypto";
import { exportHtml, exportMarkdown, exportText, exportPdf, exportProofReport, downloadBlob } from "./export/exporters";
import type { Template } from "./editor/templates";
import type {
  EliumFile,
  EliumParapheur,
  EliumProfile,
  EliumSignature,
  ProseMirrorNode,
  SignatureVerdict,
  PageSettings,
  EliumDocStyle,
  EliumWatermark,
} from "./format/types";
import type { ExportKind, Studio, StudioMode } from "./studio/types";
import type { ItemSession } from "./workspace/useItemSync";
import type { WorkItem } from "./workspace/types";
import type { SaveDestination } from "./pdf/core/destination";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Recompute each signature's verdict AND its attribution.
 *
 * The verdict is a pure cryptographic fact (authentic + document unchanged) —
 * it never depends on who you trust. Trust is a SEPARATE dimension: if the
 * proof's key is in the carnet, we surface the contact's name ("signé par X").
 * Absence of attribution is shown as a caution in the UI, not baked into the
 * verdict, so a valid-but-unknown key reads honestly rather than as a scare.
 */
async function computeVerdicts(
  f: EliumFile,
  book: TrustedContact[],
): Promise<{ verdicts: Record<string, SignatureVerdict>; attributions: Record<string, string> }> {
  const verdicts: Record<string, SignatureVerdict> = {};
  const attributions: Record<string, string> = {};
  await Promise.all(
    f.signatures.map(async (s) => {
      verdicts[s.id] = await verifyProof(s, f.document);
      const contact = s.proof ? findContact(book, s.proof.publicKeyHex) : undefined;
      if (contact) attributions[s.id] = contact.name;
    }),
  );
  return { verdicts, attributions };
}

function Toast({ tone, message, onClose }: { tone: "danger" | "success"; message: string; onClose: () => void }) {
  return (
    <div className={`toast toast--${tone}`} role="status">
      <span>{message}</span>
      <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
        <X size={14} />
      </button>
    </div>
  );
}

export default function App() {
  // An org invite link (?invite=…) must land directly on the Drive onboarding:
  // the DriveCloud session reads that token and auto-accepts it after auth.
  // Without this, invitees hit the local-suite home page and the invite is only
  // picked up if they happen to open the Drive manually (confirmed on the live
  // deployment) — a dead end for the primary "click the invite" journey.
  const [mode, setMode] = useState<StudioMode>(() => {
    try {
      if (new URLSearchParams(window.location.search).get("invite")) return "drive-cloud";
    } catch {
      /* ignore — fall through to home */
    }
    return "home";
  });
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
  useI18n(); // la langue active redessine toute l'application
  const prefs = usePrefs();
  const bindings = useBindings();
  const sessionInfo = useMemo(() => currentSession(), []);
  // Espace de travail : vue active, recherche, élément ouvert dans un éditeur natif, PDF de la bibliothèque.
  const [view, setView] = useState<ShellView>(() =>
    getPrefs().startupView === "library" ? "library" : getPrefs().startupView === "recent" ? "recent" : "home",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [activeItem, setActiveItem] = useState<(ItemSession & { kind: "sheet" | "slides" }) | null>(null);
  const [pdfSource, setPdfSource] = useState<{ bytes: Uint8Array; name: string; destination: SaveDestination } | null>(
    null,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<{ category?: CategoryId; section?: SectionId } | undefined>(
    undefined,
  );
  /** Fichier du disque lié au document ouvert (« Enregistrer » le réécrit en place). */
  const docHandleRef = useRef<FsFileHandle | undefined>(undefined);

  // Les clés (identité Ed25519, clé de réception P-256) vivent dans le trousseau
  // unifié (crypto/keyring.ts, IndexedDB `elium-keys`) : jamais en clair au repos ;
  // la clé privée n'existe en mémoire qu'après déverrouillage et disparaît au
  // verrouillage (manuel ou par inactivité). `identity` / `recipientPublic` plus
  // bas en sont des vues dérivées — cf. useKeyring() après askPassword.
  // Carnet de clés de confiance (name→clé) — remplace l'ancienne clé unique.
  const [trustBook, setTrustBook] = useState<TrustedContact[]>(() => loadTrustBook());
  const [attributions, setAttributions] = useState<Record<string, string>>({}); // sigId → nom du contact
  const [sealAttribution, setSealAttribution] = useState<string | null>(null); // nom du scelleur, si connu
  const [sealVerdict, setSealVerdict] = useState<SealVerdict | null>(null);
  const [sealPin, setSealPin] = useState<SealPinCheck | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Keyfile (2nd factor) chosen this session, reused across re-saves. Never persisted.
  const keyfileRef = useRef<Uint8Array | undefined>(undefined);
  // Multi-recipient: recipient public keys this document is encrypted FOR (save),
  // and this user's own recipient public key (to receive).
  const [recipients, setRecipients] = useState<string[]>([]);

  const setTheme = useCallback((t: Theme) => {
    persistTheme(t);
    setThemeState(t);
  }, []);

  // Migre une fois l'ancienne « clé de confiance » unique vers le carnet nommé.
  useEffect(() => {
    void migrateLegacyTrustedKey().then(() => setTrustBook(loadTrustBook()));
  }, []);

  // Le contrôleur du trousseau est créé plus bas (il a besoin d'askPassword) ;
  // ce ref permet aux callbacks définis avant lui de l'utiliser sans dépendance instable.
  const keyringRef = useRef<KeyringController | null>(null);

  const forgetIdentity = useCallback(async () => {
    // Suppression avec sauvegarde obligatoire proposée (cf. use-keyring.tsx removeKey).
    const kr = keyringRef.current;
    const id = kr?.entries.find((e) => e.type === "identity-ed25519" && e.status === "active");
    if (kr && id) await kr.removeKey(id.id);
  }, []);

  const clearLocalStorage = useCallback(() => {
    void keyringRef.current?.forgetAll();
    localStorage.removeItem("elium_trusted_key"); // legacy (migré vers le carnet)
    localStorage.removeItem("elium_trust_book");
    localStorage.removeItem("elium_trust_revocations");
    localStorage.removeItem("elium_keyring_idle_min");
    localStorage.removeItem("elium_theme");
    localStorage.removeItem("elium_seal_pins");
    for (const k of [
      "elium_prefs",
      "elium_shortcuts",
      "elium_locale",
      "elium_session",
      "elium_view_mode",
      "elium_recent_commands",
    ])
      localStorage.removeItem(k);
    // Also purge the IndexedDB stores (Drive library, app autosaves, version
    // history, parapheur, drafts, vault) — otherwise "données effacées" leaves them behind.
    for (const db of [
      "elium",
      "elium-drive",
      "elium-sheets",
      "elium-slides",
      "elium-parapheur",
      "elium-drafts",
      "elium-vault",
      "elium-keys",
      "elium-fonts",
      "elium-pdfs",
      "elium-pdf-recovery",
      "elium-workspace",
      "elium-backups",
    ]) {
      try {
        indexedDB.deleteDatabase(db);
      } catch {
        /* best effort */
      }
    }
    keyfileRef.current = undefined;
    setTrustBook([]);
    setSettingsOpen(false);
    vaultPromptedRef.current = false;
    setVaultSecret(undefined);
    setVaultState("none");
    setToast(t("app.data_cleared"));
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

  // Trousseau unifié (identité + clé de réception) : verrouillage manuel/auto qui
  // purge aussi le fichier-clé gardé en mémoire pour les ré-enregistrements.
  const keyring = useKeyring({
    askPassword,
    notify: setToast,
    onLock: () => {
      keyfileRef.current = undefined;
    },
  });
  keyringRef.current = keyring;
  const identity: EliumIdentity | null = keyring.identity;
  const recipientPublic = keyring.recipientPublic;

  // --- Local vault (opt-in app-wide passphrase for Drive/Parapheur at rest) --
  // "none" = never configured (default, unchanged behaviour); "locked" = configured
  // but not yet unlocked this session; "unlocked" = vaultSecret below is usable.
  const [vaultState, setVaultState] = useState<"checking" | "none" | "locked" | "unlocked">("checking");
  const [vaultSecret, setVaultSecret] = useState<VaultSecret | undefined>(undefined);
  const vaultPromptedRef = useRef(false);

  useEffect(() => {
    isVaultConfigured().then((configured) => setVaultState(configured ? "locked" : "none"));
  }, []);

  // Espace de travail local (catalogue, recherche) : démarre quand le coffre est résolu (aucun / déverrouillé).
  const vaultSecretRef = useRef(vaultSecret);
  vaultSecretRef.current = vaultSecret;
  const ws = useWorkspace({
    vaultSecret,
    enabled: vaultState === "none" || vaultState === "unlocked",
    onError: (m) => setError(m),
  });
  const search = useSearch({ items: ws.items, folders: ws.folders, vaultSecret, enabled: ws.ready });
  const replaceDeps = useMemo(
    () =>
      createReplaceDeps(
        () => vaultSecretRef.current,
        (id, size, savedAt) => ws.catalog.patchItems([id], { size, modifiedAt: savedAt }),
      ),
    [ws.catalog],
  );

  const unlockVault = useCallback(async () => {
    const pwd = await askPassword(t("vault.unlock_title"), "enter");
    if (pwd === null) return;
    if (!(await verifyVaultPassword(pwd))) {
      setError(t("vault.wrong_password"));
      return;
    }
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
    const pwd = await askPassword(t("vault.create_title"), "set", t("vault.password_hint"));
    if (!pwd) return;
    setBusy(true);
    try {
      await reencryptAll(vaultParticipants(ws.catalog), undefined, { password: pwd });
      await setVaultPassword(pwd);
      setVaultSecret({ password: pwd });
      setVaultState("unlocked");
      setToast(t("vault.enabled"));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, askPassword, ws.catalog]);

  const changeVaultPassword = useCallback(async () => {
    if (busy || !hasVaultSecret(vaultSecret)) return;
    const newPwd = await askPassword(t("vault.new_title"), "set", t("vault.password_hint"));
    if (!newPwd) return;
    setBusy(true);
    try {
      await reencryptAll(vaultParticipants(ws.catalog), vaultSecret, { password: newPwd });
      await setVaultPassword(newPwd);
      setVaultSecret({ password: newPwd });
      setToast(t("vault.changed"));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, vaultSecret, askPassword, ws.catalog]);

  const disableVault = useCallback(async () => {
    if (busy || !hasVaultSecret(vaultSecret)) return;
    if (
      !(await dialogs.confirm({
        title: t("vault.disable_title"),
        message: t("vault.disable_body"),
        confirmLabel: t("vault.disable_confirm"),
      }))
    )
      return;
    setBusy(true);
    try {
      await reencryptAll(vaultParticipants(ws.catalog), vaultSecret, undefined);
      await removeVaultConfig();
      setVaultSecret(undefined);
      setVaultState("none");
      setToast(t("vault.disabled"));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, vaultSecret, dialogs, ws.catalog]);

  // "Forgot vault password": zero-knowledge means it can't be recovered — the
  // only way forward is to drop the locally-cached Drive/Parapheur data (the
  // user's actual .elium files on disk are untouched) and start fresh.
  const resetVault = useCallback(async () => {
    if (
      !(await dialogs.confirm({
        title: t("vault.reset_title"),
        message: t("vault.reset_body"),
        danger: true,
        confirmLabel: t("vault.reset_confirm"),
      }))
    )
      return;
    // Wait for each deletion to actually settle (success/error/blocked by a
    // lingering connection) instead of firing IDBOpenDBRequest and moving on —
    // otherwise the UI could claim "reset" while the databases still exist.
    await Promise.all(
      [
        "elium-drive",
        "elium-parapheur",
        "elium-vault",
        "elium-sheets",
        "elium-slides",
        "elium-pdfs",
        "elium-workspace",
      ].map(
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
    setToast(t("vault.reset_done"));
  }, [dialogs]);

  // Tracking journal — read-time events (opened / export / signature.validated)
  // are queued here and flushed into the (sealed) journal at the next save, so
  // merely viewing a sealed document never mutates and breaks its seal.
  const pendingJournalRef = useRef<PendingJournalEvent[]>([]);
  const validatedSigRef = useRef<Set<string>>(new Set()); // sig ids already logged this session
  const queueJournal = useCallback((ev: PendingJournalEvent) => {
    pendingJournalRef.current.push(ev);
  }, []);

  const recompute = useCallback(async (f: EliumFile) => {
    // Read the trust book fresh each pass: mutations go through localStorage,
    // so this reflects the latest carnet without stale-closure hazards.
    const book = loadTrustBook();
    const { verdicts: verds, attributions: attrib } = await computeVerdicts(f, book);
    setVerdicts(verds);
    setAttributions(attrib);
    // Log the first authentic validation of each signature this session (flushed at save).
    for (const s of f.signatures) {
      if (verds[s.id] === "valid" && !validatedSigRef.current.has(s.id)) {
        validatedSigRef.current.add(s.id);
        pendingJournalRef.current.push({ type: "signature.validated", at: nowIso(), data: { id: s.id } });
      }
    }
    setJournalVerdict(await verifyJournal(f.journal));
    // Verdict = pure crypto (authentic + untampered); attribution is separate.
    const sealContact = f.manifest.seal ? findContact(book, f.manifest.seal.publicKeyHex) : undefined;
    // Verify over the SAME (redacted-when-encrypted) entries the writer sealed —
    // f.signatures/f.journal hold the real decrypted values, which would falsely
    // read "broken" for a metadata-encrypted document. See verifyLoadedSeal.
    const sv = await verifyLoadedSeal(f);
    setSealVerdict(sv);
    setSealAttribution(sealContact?.name ?? null);
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

  // Carnet : approuver une clé (de sceau ou de preuve) sous un nom, ou la retirer.
  const trustContact = useCallback(
    async (name: string, publicKeyHex: string, opts?: TrustOptions) => {
      try {
        setTrustBook(await storeTrustContact(name, publicKeyHex, opts));
        if (file) await recompute(file);
        setToast(`Clé approuvée comme « ${name.trim() || "Sans nom"} »`);
      } catch (e) {
        setError(msg(e));
      }
    },
    [file, recompute],
  );

  const untrustContact = useCallback(
    (publicKeyHex: string) => {
      setTrustBook(storeUntrustContact(publicKeyHex));
      if (file) void recompute(file);
    },
    [file, recompute],
  );

  // Returns the in-memory private key, unlocking the keyring on demand (ONE
  // password unlocks identity + recipient keys; auto-lock after idle).
  const ensurePrivateKey = useCallback(async (): Promise<string | null> => {
    // La session du trousseau fait foi (jamais un `identity` périmé capturé avant un verrouillage).
    return (await keyringRef.current?.ensureIdentityPrivate()) ?? null;
  }, []);

  // Spreadsheet/presentation apps opened from a .elium (marker-node payload).
  const [appView, setAppView] = useState<{ kind: "sheet" | "slides" | "pdf"; data: unknown } | null>(null);
  const [appKey, setAppKey] = useState(0);

  const loadFile = useCallback(
    async (f: EliumFile, integ: IntegrityVerdict, opened = false) => {
      // Fresh session for this file: reset the pending journal queue.
      pendingJournalRef.current = [];
      validatedSigRef.current = new Set();
      if (opened && tracksJournal(f)) queueJournal({ type: "document.opened", at: nowIso() });
      // Re-register the typefaces the document carries BEFORE it renders, so text
      // never flashes in a fallback font (or stays in one, on a machine that does
      // not have the original installed).
      registerEmbeddedFonts(
        fontResources(f.resourceIndex)
          .map((meta) => {
            const bytes = f.resources.get(meta.id);
            return bytes ? { family: meta.family, filename: `${meta.family}.${meta.ext}`, bytes } : null;
          })
          .filter((x): x is { family: string; filename: string; bytes: Uint8Array } => x !== null),
      );
      setFile(f);
      setIntegrity(integ);
      setSelectedSig(null);
      await recompute(f);
      setEditorKey((k) => k + 1);
    },
    [recompute, queueJournal],
  );

  // --- Home actions -------------------------------------------------------

  const onCreate = useCallback(
    async (tpl: Template, profile: EliumProfile = "standard") => {
      const { title, doc } = tpl.build();
      const f = await createEliumFile({ title, profile, doc });
      // Préférences d'édition : police / taille par défaut des NOUVEAUX documents (style « Normal »).
      const { defaultFont, defaultFontSize } = getPrefs();
      if (defaultFont || defaultFontSize) {
        const normal = {
          id: "Normal",
          name: "Normal",
          kind: "paragraph" as const,
          block: { type: "paragraph" as const },
          builtIn: true,
          quick: true,
          char: {
            ...(defaultFont ? { fontFamily: defaultFont } : {}),
            ...(defaultFontSize ? { fontSize: defaultFontSize } : {}),
          },
        };
        f.document.styles = [...(f.document.styles ?? []).filter((s) => s.id !== "Normal"), normal];
      }
      docHandleRef.current = undefined;
      setPassword("");
      await loadFile(f, { contentIntact: true, unchecked: true });
      setMode("studio");
    },
    [loadFile],
  );

  const openLegacy = useCallback(
    async (bytes: Uint8Array, name: string) => {
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
    },
    [askPassword, loadFile],
  );

  const onOpen = useCallback(
    async (uploaded: File, extra?: { title?: string; handle?: FsFileHandle }) => {
      setBusy(true);
      docHandleRef.current = undefined;
      try {
        // Import Word .docx as a new editable document (binary).
        const ext = uploaded.name.toLowerCase().split(".").pop() ?? "";
        if (ext === "docx") {
          const { title, doc } = docxToDoc(new Uint8Array(await uploaded.arrayBuffer()));
          const f = await createEliumFile({
            title: title || uploaded.name.replace(/\.docx$/i, ""),
            profile: "standard",
            doc,
          });
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
            if (!keyringRef.current?.recipientPublic) {
              setError(
                "Ce document est chiffré pour des destinataires. Générez d'abord votre clé de réception (Sécurité).",
              );
              return;
            }
            // Une seule invite déverrouille le trousseau ; la clé active puis les clés
            // RETIRÉES (rotation) sont essayées (kid de l'enveloppe).
            const recipientKeys = await keyringRef.current.recipientKeypairs();
            if (!recipientKeys) return;
            result = await readEliumPackage(bytes, { recipientKeys });
          } else if (e instanceof EliumPasswordRequired) {
            const got = await askSecret(`Mot de passe pour « ${uploaded.name} »`, "enter", true);
            if (!got) return;
            pwd = got.password;
            keyfileRef.current = got.keyfile;
            result = await readEliumPackage(bytes, { password: pwd, keyfile: got.keyfile });
          } else throw e;
        }
        if (extra?.title) result.file.manifest.title = extra.title; // un renommage de la bibliothèque prime sur le titre interne
        // « Enregistrer » réécrira ce fichier du disque (ou celui lié à ce document lors d'un enregistrement précédent).
        if (extra?.handle && ext === "elium") {
          docHandleRef.current = extra.handle;
          void rememberHandle(docKeyOf(result.file.manifest), extra.handle);
        }
        // Route spreadsheet/presentation .elium files to their app (marker node).
        const first = result.file.document.doc?.content?.[0];
        if (first && (first.type === "eliumSheet" || first.type === "eliumSlides" || first.type === "eliumPdf")) {
          try {
            const kind = first.type === "eliumSheet" ? "sheet" : first.type === "eliumSlides" ? "slides" : "pdf";
            setAppView({ kind, data: JSON.parse(String(first.attrs?.data ?? "null")) });
            setActiveItem(null);
            setPdfSource(null);
            setAppKey((k) => k + 1);
            setMode(kind);
            return;
          } catch {
            /* corrupted app payload — fall through to a normal open */
          }
        }
        setPassword(pwd ?? "");
        await loadFile(result.file, result.integrity, true); // opened from disk → log document.opened at save
        setMode("viewer");
      } catch (e) {
        setError(msg(e));
      } finally {
        setBusy(false);
      }
    },
    [askSecret, loadFile, openLegacy],
  );

  /**
   * Save a spreadsheet/presentation/PDF session as an encrypted+sealed .elium
   * and mirror it to the Drive. Resolves true once the file is written, false
   * when cancelled or failed (the PDF workspace only then marks its session saved).
   */
  const exportAppElium = useCallback(
    async (kind: "sheet" | "slides" | "pdf", data: unknown, title: string, mirror = true): Promise<boolean> => {
      try {
        const label = kind === "sheet" ? t("kind.sheet") : kind === "slides" ? t("kind.slides") : t("kind.pdf");
        const wantEnc = await dialogs.confirm({
          title: "Protéger le fichier ?",
          message:
            "Chiffrer ce fichier (AES-256, mot de passe et/ou fichier-clé) ?\n\nConfirmer = chiffré · Annuler = signé/scellé, non chiffré.",
          confirmLabel: "Chiffrer",
          cancelLabel: "Signer seulement",
        });
        const secret = wantEnc
          ? await askSecret("Protéger le fichier (mot de passe et/ou fichier-clé)", "set", true)
          : null;
        if (wantEnc && !secret) return false; // cancelled the password dialog
        const nodeType = kind === "sheet" ? "eliumSheet" : kind === "slides" ? "eliumSlides" : "eliumPdf";
        const doc: ProseMirrorNode = {
          type: "doc",
          content: [{ type: nodeType, attrs: { data: JSON.stringify(data) } }],
        };
        const f = await createEliumFile({ title: title || label, profile: secret ? "encrypted" : "standard", doc });
        const sealKey = identity ? ((await ensurePrivateKey()) ?? undefined) : undefined;
        const bytes = await writeEliumPackage(f, {
          password: secret?.password,
          keyfile: secret?.keyfile,
          sealPrivateKeyHex: sealKey,
        });
        downloadBlob(`${f.manifest.title}.elium`, "application/x-elium", bytes);
        // Un élément de l'espace de travail vit déjà dans la bibliothèque : pas de doublon. Seuls les fichiers ouverts du disque sont recopiés.
        if (mirror) {
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
            await ws.registerSaved(
              {
                id: docKeyOf(f.manifest),
                kind,
                contentStore: "drive",
                title: f.manifest.title,
                size: bytes.length,
                profile: f.manifest.profile,
              },
              { updateTitle: true },
            );
          } catch (e) {
            reportError("library-mirror", e);
          }
        }
        setToast(`${label} enregistré (.elium${secret ? ", chiffré" : ""}${sealKey ? ", scellé" : ""})`);
        return true;
      } catch (e) {
        setError(msg(e));
        return false;
      }
    },
    [identity, ensurePrivateKey, askSecret, dialogs, vaultSecret, ws],
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
        const f = await fetchLauncherFile();
        if (!f) return;
        window.history.replaceState(null, "", window.location.pathname);
        await onOpen(new File([f.bytes], f.name));
      } catch {
        /* launcher absent (mode dev) : ignorer */
      }
    })();
  }, [onOpen]);

  // Elium déjà ouvert + double-clic sur un autre .elium : le 2e lancement confie
  // son fichier à CETTE fenêtre (cf. desktop/launcher-bridge.ts).
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(
    () =>
      watchLauncherInbox(async (f) => {
        await onOpenRef.current(new File([f.bytes], f.name));
      }),
    [],
  );

  // --- Espace de travail : ouvrir un élément, importer, raccourcis, commandes -------------------
  const openPdfRecord = useCallback(
    (id: string, name: string, bytes: Uint8Array) => {
      setPdfSource({
        bytes,
        name,
        destination: libraryDestination({
          id,
          name,
          label: t("pdf.library_label", { name }),
          getSecret: () => vaultSecretRef.current,
          onSaved: (size) => void ws.registerSaved({ id, kind: "pdf", size }),
        }),
      });
      setActiveItem(null);
      setAppView(null);
      setAppKey((k) => k + 1);
      setMode("pdf");
    },
    [ws],
  );

  const openItem = useCallback(
    async (item: WorkItem) => {
      try {
        if (item.locked) return;
        if (item.contentStore === "drive") {
          const doc = await getDriveDoc(item.id, vaultSecretRef.current);
          if (!doc) {
            void ws.refresh();
            return;
          }
          ws.touchOpened(item.id);
          await onOpenRef.current(
            new File([doc.bytes as unknown as BlobPart], `${item.title || "document"}.elium`, {
              type: "application/x-elium",
            }),
            { title: item.title },
          );
          return;
        }
        ws.touchOpened(item.id);
        if (item.contentStore === "pdfs") {
          const rec = await pdfStore.get(item.id, vaultSecretRef.current);
          if (!rec) {
            void ws.refresh();
            return;
          }
          openPdfRecord(item.id, rec.name, rec.bytes);
          return;
        }
        setPdfSource(null);
        setAppView(null);
        setActiveItem({
          kind: item.kind === "sheet" ? "sheet" : "slides",
          id: item.id,
          isNew: false,
          title: item.title,
        });
        setAppKey((k) => k + 1);
        setMode(item.kind === "sheet" ? "sheet" : "slides");
      } catch (e) {
        reportError("open-item", e);
        setError(`${t("search.open_failed")} : ${msg(e)}`);
      }
    },
    [ws, openPdfRecord],
  );

  const startNew = useCallback(
    (kind: "sheet" | "slides") => {
      setAppView(null);
      setPdfSource(null);
      setActiveItem({ kind, id: ws.service.newItemId(), isNew: true, title: "" });
      setAppKey((k) => k + 1);
      setMode(kind);
    },
    [ws],
  );
  const startNewPdf = useCallback(() => {
    setAppView(null);
    setActiveItem(null);
    setPdfSource(null);
    setAppKey((k) => k + 1);
    setMode("pdf");
  }, []);

  const openSettings = useCallback((target?: { category?: CategoryId; section?: SectionId }) => {
    setSettingsTarget(target);
    setSettingsOpen(true);
  }, []);

  /** Ouvre ce que l'utilisateur dépose ou choisit : PDF → bibliothèque, sauvegarde d'espace → Réglages, le reste → l'éditeur adapté. */
  const openPicked = useCallback(
    async (files: PickedFile[]) => {
      try {
        const pdfs = files.filter((f) => isPdfFile(f.file));
        const backups = files.filter((f) => /\.elium-workspace$/i.test(f.file.name));
        const rest = files.filter((f) => !pdfs.includes(f) && !backups.includes(f));
        let last: { id: string; bytes: Uint8Array; name: string } | undefined;
        for (const f of pdfs) last = await importPdf(ws, f.file, () => vaultSecretRef.current);
        if (pdfs.length > 0 && rest.length === 0 && backups.length === 0) {
          if (pdfs.length === 1 && last) openPdfRecord(last.id, last.name, last.bytes);
          else setToast(tn("workspace.import_done", pdfs.length));
          return;
        }
        if (backups.length > 0) {
          setToast(t("backup.use_restore"));
          openSettings({ category: "workspace", section: "ws_restore" });
          return;
        }
        if (rest[0]) await onOpenRef.current(rest[0].file, { handle: rest[0].handle });
      } catch (e) {
        reportError("open-picked", e);
        setError(msg(e));
      }
    },
    [ws, openPdfRecord, openSettings],
  );
  const openPickedRef = useRef(openPicked);
  openPickedRef.current = openPicked;
  const appFileInputRef = useRef<HTMLInputElement>(null);

  /** « Ouvrir… » avec le sélecteur natif quand il existe (renvoie false : l'appelant utilise un <input type=file>). */
  const pickNative = useCallback(async (): Promise<boolean> => {
    if (!fsAccessSupported()) return false;
    try {
      const picked = await pickFileToOpen();
      if (picked) await openPickedRef.current([picked]);
    } catch (e) {
      reportError("open-picker", e);
      setError(msg(e));
    }
    return true;
  }, []);

  // PWA installée : double-clic sur un .elium dans l'explorateur (file_handlers + launchQueue).
  useEffect(() => {
    consumeLaunchQueue(
      (picked) => openPickedRef.current([picked]),
      (e) => reportError("launch-queue", e),
    );
  }, []);

  const goView = useCallback(
    (v: ShellView) => {
      if (v === "library") ws.setCurrentFolderId(null);
      setView(v);
      setMode("home");
    },
    [ws],
  );
  const goSearch = useCallback((q: string) => {
    setSearchQuery(q);
    setView("search");
    setMode("home");
  }, []);
  const [newDocSignal, setNewDocSignal] = useState(0);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Raccourcis globaux (personnalisables dans Réglages). Phase de capture : ils passent avant ceux de l'éditeur.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isCapturingShortcut()) return;
      const id = shortcutFor(e, bindings);
      if (!id) return;
      const take = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      switch (id) {
        case "palette":
          if (modeRef.current === "pdf") return; // le module PDF a sa propre palette sur ce raccourci
          take();
          setPaletteOpen((v) => !v);
          return;
        case "paletteGlobal":
          take();
          setPaletteOpen((v) => !v);
          return;
        case "searchWorkspace":
          take();
          goSearch("");
          return;
        case "settings":
          take();
          openSettings();
          return;
        case "goHome":
          take();
          setMode("home");
          return;
        case "newDocument":
          take();
          setMode("home");
          setView("home");
          setNewDocSignal((n) => n + 1);
          return;
        case "newSpreadsheet":
          take();
          startNew("sheet");
          return;
        case "newPresentation":
          take();
          startNew("slides");
          return;
        case "openFile":
          take();
          void pickNative().then((handled) => {
            if (!handled) appFileInputRef.current?.click();
          });
          return;
        case "save":
        case "saveAs": {
          take(); // jamais la boîte « Enregistrer la page sous » du navigateur
          const cmd = commandRegistry.forShortcut(id);
          if (cmd) cmd.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bindings, goSearch, openSettings, startNew, pickNative]);

  // Commandes globales : navigation, espace de travail, réglages.
  const globalCommands = useMemo<AppCommand[]>(() => {
    return [
      {
        id: "nav.home",
        label: t("cmd.go_home"),
        group: "nav",
        shortcutId: "goHome",
        keywords: "accueil",
        run: () => setMode("home"),
      },
      {
        id: "nav.library",
        label: t("cmd.go_library"),
        group: "nav",
        keywords: "mes documents dossiers",
        run: () => goView("library"),
      },
      {
        id: "nav.starred",
        label: t("cmd.go_starred"),
        group: "nav",
        keywords: "favoris étoile",
        run: () => goView("starred"),
      },
      { id: "nav.recent", label: t("cmd.go_recent"), group: "nav", run: () => goView("recent") },
      {
        id: "nav.trash",
        label: t("cmd.go_trash"),
        group: "nav",
        keywords: "supprimés poubelle",
        run: () => goView("trash"),
      },
      {
        id: "nav.search",
        label: t("cmd.search_workspace"),
        group: "workspace",
        shortcutId: "searchWorkspace",
        keywords: "chercher trouver remplacer",
        run: () => goSearch(""),
      },
      {
        id: "nav.docs",
        label: t("cmd.go_docs"),
        group: "nav",
        keywords: "aide documentation manuel",
        run: () => setMode("documentation"),
      },
      {
        id: "nav.detector",
        label: t("cmd.go_detector"),
        group: "nav",
        keywords: "ia plagiat",
        run: () => setMode("detector"),
      },
      {
        id: "nav.drive",
        label: t("cmd.go_drive"),
        group: "nav",
        keywords: "cloud entreprise",
        run: () => setMode("drive-cloud"),
      },
      {
        id: "ws.new_doc",
        label: t("cmd.new_doc"),
        group: "workspace",
        shortcutId: "newDocument",
        keywords: "nouveau créer",
        run: () => {
          setMode("home");
          setView("home");
          setNewDocSignal((n) => n + 1);
        },
      },
      {
        id: "ws.new_sheet",
        label: t("cmd.new_sheet"),
        group: "workspace",
        shortcutId: "newSpreadsheet",
        keywords: "nouveau créer excel",
        run: () => startNew("sheet"),
      },
      {
        id: "ws.new_slides",
        label: t("cmd.new_slides"),
        group: "workspace",
        shortcutId: "newPresentation",
        keywords: "nouveau créer powerpoint diaporama",
        run: () => startNew("slides"),
      },
      { id: "ws.new_pdf", label: t("cmd.new_pdf"), group: "workspace", keywords: "nouveau ouvrir", run: startNewPdf },
      {
        id: "file.open",
        label: t("cmd.open_file"),
        group: "file",
        shortcutId: "openFile",
        keywords: "importer parcourir",
        run: () =>
          void pickNative().then((h) => {
            if (!h) appFileInputRef.current?.click();
          }),
      },
      {
        id: "ws.backup",
        label: t("cmd.backup"),
        group: "workspace",
        keywords: "exporter sauvegarde",
        run: () => openSettings({ category: "workspace", section: "ws_backup" }),
      },
      {
        id: "ws.restore",
        label: t("cmd.restore"),
        group: "workspace",
        keywords: "importer restaurer",
        run: () => openSettings({ category: "workspace", section: "ws_restore" }),
      },
      {
        id: "set.open",
        label: t("cmd.settings"),
        group: "settings",
        shortcutId: "settings",
        keywords: "préférences options",
        run: () => openSettings(),
      },
      {
        id: "set.shortcuts",
        label: t("cmd.settings_shortcuts"),
        group: "settings",
        keywords: "clavier raccourcis",
        run: () => openSettings({ category: "shortcuts" }),
      },
      {
        id: "set.fonts",
        label: t("cmd.settings_fonts"),
        group: "settings",
        keywords: "police typographie",
        run: () => openSettings({ category: "fonts" }),
      },
      {
        id: "set.port",
        label: t("cmd.settings_port"),
        group: "settings",
        keywords: "réseau serveur local",
        run: () => openSettings({ category: "updates", section: "upd_port" }),
      },
      {
        id: "set.theme",
        label: t("cmd.toggle_theme"),
        group: "settings",
        keywords: "sombre clair",
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "set.lang",
        label: getLocale() === "fr" ? t("cmd.lang_en") : t("cmd.lang_fr"),
        group: "settings",
        keywords: "langue english français",
        run: () => setLocale(getLocale() === "fr" ? "en" : "fr"),
      },
    ];
  }, [goView, goSearch, startNew, startNewPdf, pickNative, openSettings, setTheme, theme]);
  useRegisterCommands("global", globalCommands);

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
        ? {
            ...prev,
            manifest: { ...prev.manifest, protection: { ...prev.manifest.protection, metadataEncrypted: on } },
          }
        : prev,
    );
  }, []);

  // Generate this user's recipient key (so others can encrypt documents to them).
  // La génération force une sauvegarde immédiate (sans elle, vider le navigateur
  // rend à jamais illisibles les documents chiffrés pour cette clé).
  const generateRecipientKey = useCallback(async () => {
    if (await keyringRef.current?.createRecipientKey()) {
      setToast("Clé de réception générée. Partagez votre clé publique pour recevoir des documents chiffrés.");
    }
  }, []);

  // « Oublier » = suppression avec invite de sauvegarde obligatoire (cf. removeKey).
  const forgetMyRecipientKey = useCallback(async () => {
    const kr = keyringRef.current;
    const r = kr?.entries.find((e) => e.type === "recipient-p256" && e.status === "active");
    if (kr && r) await kr.removeKey(r.id);
  }, []);

  /** Replace the document's own named styles (Styles manager). */
  const updateStyles = useCallback((styles: EliumDocStyle[]) => {
    setFile((prev) => (prev ? { ...prev, document: { ...prev.document, styles } } : prev));
  }, []);

  /** Applique un thème : styles ET mémo écrits ensemble (voir editor/themes.ts). */
  const updateDocTheme = useCallback((theme: string, styles: EliumDocStyle[]) => {
    setFile((prev) => (prev ? { ...prev, document: { ...prev.document, theme, styles } } : prev));
  }, []);

  const updateWatermark = useCallback((watermark: EliumWatermark) => {
    setFile((prev) => (prev ? { ...prev, document: { ...prev.document, watermark } } : prev));
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

  const [backupOpen, setBackupOpen] = useState<"generated" | "manual" | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const copyWithToast = useCallback(async (text: string, label: string) => {
    if (await copyText(text)) setToast(label);
    else setError("Impossible d'accéder au presse-papier.");
  }, []);

  const generateIdentity = useCallback(async () => {
    // L'identité est dérivée du secret maître du trousseau (créé au premier usage,
    // protégé par UN mot de passe). Les erreurs sont remontées par le contrôleur.
    if (await keyringRef.current?.createIdentity()) {
      // Open the backup modal right away: without an export, the key only lives
      // in this browser's storage and a profile reset destroys it for good.
      setBackupOpen("generated");
    }
  }, []);

  // Sauvegarde .eliumkey v2 : TOUTES les clés (signature + réception), un seul fichier.
  const exportIdentityFile = useCallback(() => {
    void keyringRef.current?.exportBackup();
  }, []);

  const importIdentityFromFile = useCallback(
    async (text: string): Promise<boolean> => (await keyringRef.current?.importBackupText(text)) ?? false,
    [],
  );

  const importIdentityFromHex = useCallback(async (hex: string): Promise<boolean> => {
    try {
      const id = await identityFromPrivateHex(hex);
      const ok =
        (await keyringRef.current?.importRawIdentity(id.privateKeyHex, id.publicKeyHex, id.fingerprint)) ?? false;
      if (ok) setToast("Clé privée importée et chiffrée");
      return ok;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  }, []);

  const changeProfile = useCallback(
    async (p: EliumProfile) => {
      setBusy(true);
      try {
        setFile((prev) => prev); // ensure latest
        const current = file;
        if (!current) return;
        const nf = await setProfile(current, p);
        setFile(nf);
        await recompute(nf);
      } finally {
        setBusy(false);
      }
    },
    [file, recompute],
  );

  const createSignature = useCallback(
    async (draft: SignatureDraft) => {
      if (!file) return;
      setBusy(true);
      try {
        const id = randomId("sig");
        // Placement/visual must be final BEFORE signing so the proof binds them.
        const placement: EliumSignature["placement"] = {
          page: 1,
          xPct: 0.34,
          yPct: 0.78,
          wPct: 0.3,
          hPct: 0.12,
          rotation: 0,
          z: file.signatures.length,
          anchorType: "page",
        };
        let proof = null;
        if (draft.wantsProof && identity) {
          const pk = await ensurePrivateKey();
          if (pk)
            proof = await createProof({
              signatureId: id,
              model: file.document,
              signer: draft.signer,
              privateKeyHex: pk,
              placement,
              visual: draft.visual,
            });
        }
        const sig: EliumSignature = {
          id,
          kind: draft.kind,
          visual: draft.visual,
          placement,
          signer: draft.signer,
          proof,
          level: proof ? "advanced" : "visual",
          createdAt: new Date().toISOString(),
        };
        const nf = await addSignature(file, sig);
        setFile(nf);
        setCreatorOpen(false);
        setSelectedSig(id);
        await recompute(nf);
      } finally {
        setBusy(false);
      }
    },
    [file, identity, recompute, ensurePrivateKey],
  );

  const updateSignature = useCallback((sig: EliumSignature) => {
    setFile((prev) => (prev ? { ...prev, signatures: prev.signatures.map((s) => (s.id === sig.id ? sig : s)) } : prev));
  }, []);

  // Re-sign an advanced signature after the author repositions/resizes it, so
  // its proof keeps binding the new placement/visual. Only fires when the
  // signing key is ALREADY unlocked this session (no password prompt) AND it is
  // the ORIGINAL signer's key — otherwise the move stands as-is and the proof
  // reads "modified" (someone relocated a signature they didn't sign).
  const commitSignature = useCallback(
    async (id: string) => {
      const pk = identity?.privateKeyHex;
      if (!pk || !identity) return;
      const current = file;
      const sig = current?.signatures.find((s) => s.id === id);
      if (!current || !sig?.proof) return;
      if (identity.publicKeyHex.toLowerCase() !== sig.proof.publicKeyHex.toLowerCase()) return;
      const proof = await createProof({
        signatureId: id,
        model: current.document,
        signer: sig.signer,
        privateKeyHex: pk,
        placement: sig.placement,
        visual: sig.visual,
      });
      const nf = { ...current, signatures: current.signatures.map((s) => (s.id === id ? { ...s, proof } : s)) };
      setFile(nf);
      await recompute(nf);
    },
    [identity, file, recompute],
  );

  // Parapheur: the current user signs as a circuit party. Produces a REAL
  // embedded Ed25519 signature (proof) added to the document — it travels in the
  // .elium and is covered by the seal — and returns the link so the circuit can
  // record which signature backs this party's "signed" status.
  const signAsParty = useCallback(
    async (party: { name: string; role?: string }): Promise<{ signatureId: string; publicKeyHex: string } | null> => {
      if (!file) return null;
      if (!identity) {
        setError("Générez d'abord une identité de signature (Paramètres).");
        return null;
      }
      setBusy(true);
      try {
        const pk = await ensurePrivateKey();
        if (!pk) return null;
        const id = randomId("sig");
        const placement: EliumSignature["placement"] = {
          page: 1,
          xPct: 0.34,
          yPct: 0.78,
          wPct: 0.3,
          hPct: 0.12,
          rotation: 0,
          z: file.signatures.length,
          anchorType: "page",
        };
        const signer = { name: party.name, role: party.role };
        const visual = { text: party.name, subText: party.role };
        const proof = await createProof({
          signatureId: id,
          model: file.document,
          signer,
          privateKeyHex: pk,
          placement,
          visual,
        });
        const sig: EliumSignature = {
          id,
          kind: "typed",
          visual,
          placement,
          signer,
          proof,
          level: "advanced",
          createdAt: new Date().toISOString(),
        };
        const nf = await addSignature(file, sig);
        setFile(nf);
        setSelectedSig(id);
        await recompute(nf);
        return { signatureId: id, publicKeyHex: identity.publicKeyHex };
      } finally {
        setBusy(false);
      }
    },
    [file, identity, ensurePrivateKey, recompute],
  );

  const removeSignature = useCallback((id: string) => {
    setFile((prev) => (prev ? removeSig(prev, id) : prev));
    setSelectedSig((cur) => (cur === id ? null : cur));
    setVerdicts((v) => {
      const { [id]: _drop, ...rest } = v;
      return rest;
    });
  }, []);

  // Parapheur : le circuit vit dans le document (il voyage dans le .elium).
  const setParapheur = useCallback((parapheur: EliumParapheur) => {
    setFile((prev) => (prev ? { ...prev, parapheur } : prev));
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
    const docJson = JSON.stringify({
      t: file.manifest.title,
      d: file.document.doc,
      p: needsSecret,
      s: hasVaultSecret(secret),
    });
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
            preview: needsSecret ? undefined : previewOf(docText(snapshot.document.doc)),
            secret: needsSecret ? secret : undefined,
          });
          lastDraftJson.current = docJson;
        } catch (e) {
          // L'enregistrement automatique ne doit jamais interrompre la frappe — mais l'échec est journalisé, pas avalé.
          reportError("draft-autosave", e);
        }
      })();
    }, getPrefs().autosaveSeconds * 1000);
    return () => window.clearTimeout(handle);
  }, [file, mode, password, prefs.autosaveSeconds]);

  // Restore a document from an auto-saved draft. Prompts for the password/keyfile
  // first when the draft is protected, and recreates the document with its
  // original protection profile so recovery never silently drops it.
  const recoverDraft = useCallback(
    async (id: string) => {
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
          setError(t("recovery.wrong_password"));
          return;
        }
        const f = await createEliumFile({ title: d.title, profile: d.profile, doc: content.doc });
        f.manifest.docId = d.id; // reuse the stored draft's key so further autosaves update the same record
        f.document.page = content.page;
        docHandleRef.current = undefined;
        lastDraftJson.current = JSON.stringify({ t: d.title, d: content.doc });
        setPassword(secret?.password ?? "");
        keyfileRef.current = secret?.keyfile;
        await loadFile(f, { contentIntact: true, unchecked: true });
        setMode("studio");
      } catch (e) {
        setError(msg(e));
      }
    },
    [loadFile, askSecret],
  );

  // Download a draft's recovery .docx. Prompts for the password/keyfile first
  // when the draft is protected — the Word file is only ever built in memory.
  const downloadDraft = useCallback(
    async (id: string) => {
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
        const shape = {
          manifest: { title: d.title },
          document: { doc: content.doc, page: content.page },
        } as unknown as EliumFile;
        downloadBlob(
          `${d.title || "document"}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          docToDocx(shape),
        );
      } catch (e) {
        setError(msg(e));
      }
    },
    [askSecret],
  );

  /**
   * Enregistrer / Enregistrer sous. Le fichier cible est choisi AVANT tout calcul
   * long (chiffrement Argon2) : les navigateurs n'autorisent le sélecteur et la
   * demande de permission que dans le geste de l'utilisateur. Sans API fichier,
   * repli sur le téléchargement d'une copie.
   */
  const saveDoc = useCallback(
    async (forcePick: boolean) => {
      if (!file) return;
      const key = docKeyOf(file.manifest);
      let handle: FsFileHandle | undefined;
      let target: "disk" | "download" = "download";
      try {
        handle = docHandleRef.current ?? (await recallHandle(key));
        const plan = planSave({
          supported: fsAccessSupported(),
          hasHandle: !!handle,
          permission: handle ? await permissionOf(handle) : "unknown",
          forcePick,
        });
        if (plan.kind === "request_then_write" && handle && !(await ensurePermission(handle))) {
          handle = (await pickSaveHandle(file.manifest.title)) ?? undefined;
          if (!handle) return;
        } else if (plan.kind === "pick") {
          handle = (await pickSaveHandle(file.manifest.title)) ?? undefined;
          if (!handle) return; // annulé
        }
        if (plan.kind !== "download") target = "disk";
      } catch (e) {
        reportError("save-target", e);
        setError(msg(e));
        return;
      }
      setBusy(true);
      try {
        const encrypted = profileOf(file.manifest.profile).encrypted;
        const useRecipients = encrypted && recipients.length > 0;
        let pwd = password;
        // Only prompt for a credential when we have NONE: a keyfile (e.g. from
        // opening an eliumkey-protected doc) or recipient encryption is already
        // enough, so editing + re-saving such a file must not nag for a password.
        // Le fichier-clé est purgé au verrouillage du trousseau : un document qui l'exige
        // le redemande, au lieu de se ré-enregistrer silencieusement sans ce 2e facteur.
        const keyfileLost = !!file.manifest.protection.keyfileRequired && !keyfileRef.current;
        if (encrypted && !useRecipients && ((!pwd && !keyfileRef.current) || keyfileLost)) {
          const got = await askSecret("Protéger le document (mot de passe et/ou fichier-clé)", "set", true);
          if (!got) return;
          pwd = got.password;
          setPassword(got.password);
          keyfileRef.current = got.keyfile;
        }
        // Flush the queued session events (opened / export / signature.validated)
        // and one document.modified into the journal, THEN seal — so the seal covers
        // the new journal. Queuing (rather than logging live) keeps a viewed sealed
        // document's seal intact until this save re-anchors it.
        const f1 = await recordSave(file, pendingJournalRef.current);
        pendingJournalRef.current = [];
        // Carry the binaries of any imported font the text actually uses, so the
        // document renders in its own typefaces on a machine that lacks them.
        const f2 = await syncEmbeddedFonts(f1, embeddableFonts());
        // Seal the file with the user's identity (tamper-evidence anchor) when available.
        let sealKey: string | undefined;
        if (identity) sealKey = (await ensurePrivateKey()) ?? undefined;
        const bytes = await writeEliumPackage(f2, {
          password: useRecipients ? undefined : pwd || undefined,
          keyfile: useRecipients ? undefined : keyfileRef.current,
          recipients: useRecipients ? recipients : undefined,
          sealPrivateKeyHex: sealKey,
          encryptMetadata: !!f2.manifest.protection.metadataEncrypted,
        });
        setFile(f2);
        if (target === "disk" && handle) {
          await writeToHandle(handle, bytes);
          docHandleRef.current = handle;
          await rememberHandle(docKeyOf(f2.manifest), handle);
        } else {
          downloadBlob(`${f2.manifest.title || "document"}.elium`, "application/x-elium", bytes);
        }
        // Mirror into the local library (this browser only) and the workspace catalog.
        try {
          await putDriveDoc(
            {
              id: docKeyOf(f2.manifest),
              title: f2.manifest.title || "Document",
              profile: f2.manifest.profile,
              savedAt: new Date().toISOString(),
              size: bytes.length,
              bytes,
            },
            vaultSecret,
          );
          await ws.registerSaved(
            {
              id: docKeyOf(f2.manifest),
              kind: "doc",
              title: f2.manifest.title || undefined,
              size: bytes.length,
              profile: f2.manifest.profile,
            },
            { updateTitle: true },
          );
          // Le contenu est maintenant dans la bibliothèque : le brouillon de récupération n'a plus lieu d'être.
          await deleteDraft(docKeyOf(f2.manifest)).catch((e) => reportError("draft-cleanup", e));
          lastDraftJson.current = "";
        } catch (e) {
          reportError("library-mirror", e);
        }
        await recompute(f2);
        if (sealKey) setSealVerdict("valid");
        const how = useRecipients
          ? t("save.how_recipients", { n: recipients.length })
          : keyfileRef.current
            ? t("save.how_keyfile")
            : "";
        setToast(
          target === "disk" && handle
            ? t(sealKey ? "save.done_disk_sealed" : "save.done_disk", { name: handle.name, how })
            : t(sealKey ? "save.done_sealed" : "save.done", { how }),
        );
      } catch (e) {
        setError(msg(e));
      } finally {
        setBusy(false);
      }
    },
    [askSecret, file, password, recompute, identity, ensurePrivateKey, recipients, vaultSecret, ws],
  );
  const save = useCallback(() => saveDoc(false), [saveDoc]);
  const saveAs = useCallback(() => saveDoc(true), [saveDoc]);

  const exportAs = useCallback(
    async (kind: ExportKind) => {
      if (!file) return;
      try {
        const { verdicts: v } = await computeVerdicts(file, loadTrustBook());
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
        // Log the export (flushed into the journal at the next save).
        if (tracksJournal(file)) queueJournal({ type: "export", at: nowIso(), data: { format: kind } });
      } catch (e) {
        setError(msg(e));
      }
    },
    [file, queueJournal],
  );

  const goHome = useCallback(() => setMode("home"), []);
  const toViewer = useCallback(async () => {
    if (file) await recompute(file);
    setMode("viewer");
  }, [file, recompute]);
  const toEditor = useCallback(() => setMode("studio"), []);

  // --- Build studio contract ---------------------------------------------

  // The owner (who holds the credential) can edit ANY of their .elium files,
  // including locked / secure_max profiles — re-saving simply regenerates the
  // seal. The "locked" flag is informational here, not a read-only wall.
  const editable = mode === "studio" && !!file;

  const studio: Studio | null = file
    ? {
        file,
        editable,
        identity,
        trustBook,
        attributions,
        sealAttribution,
        verdicts,
        integrity,
        journalVerdict,
        sealVerdict,
        sealPin,
        selectedSig,
        busy,
        versionSecret: { password, keyfile: keyfileRef.current },
        vaultSecret,
        recipients,
        recipientPublic,
        setTitle,
        trustContact,
        untrustContact,
        generateIdentity,
        changeProfile,
        setAccessExpiry,
        setEncryptMetadata,
        updatePage,
        updateStyles,
        updateDocTheme,
        updateWatermark,
        setRecipients,
        generateRecipientKey,
        forgetRecipientKey: forgetMyRecipientKey,
        openSignatureCreator: () => setCreatorOpen(true),
        createSignature,
        updateSignature,
        commitSignature,
        removeSignature,
        selectSignature: setSelectedSig,
        signAsParty,
        setParapheur,
        onDocChange,
        save,
        saveAs,
        exportAs,
        goHome,
        toViewer,
        toEditor,
        trustSealKey,
        openSettings: () => setSettingsOpen(true),
      }
    : null;

  const settingsBridge: WorkspaceSettingsBridge = {
    ws,
    getSecret: () => vaultSecretRef.current,
    vaultActive: vaultState === "unlocked",
    notify: setToast,
    onSettingsRestored: () => {
      void dialogs
        .confirm({
          title: t("backup.reload_title"),
          message: t("backup.reload_body"),
          confirmLabel: t("backup.reload_now"),
        })
        .then((ok) => ok && window.location.reload());
    },
    rebuildIndex: search.rebuild,
    indexProgress: search.progress,
    indexedCount: search.indexedCount,
  };

  /** Rouvre un fichier PDF dont un brouillon de récupération garde la poignée (le module PDF propose alors de restaurer). */
  const reopenPdfDraft = async (id: string) => {
    try {
      const { getPdfDraft } = await import("./pdf/model/recovery");
      const d = await getPdfDraft(id);
      const handle = d?.handle;
      if (!handle) return;
      if (!(await ensurePermission(handle, "readwrite"))) {
        setError(t("recovery.permission_denied"));
        return;
      }
      const file = await handle.getFile();
      const { fileDestination } = await import("./pdf/core/destination");
      setPdfSource({
        bytes: new Uint8Array(await file.arrayBuffer()),
        name: file.name,
        destination: fileDestination(handle),
      });
      setActiveItem(null);
      setAppView(null);
      setAppKey((k) => k + 1);
      setMode("pdf");
    } catch (e) {
      reportError("pdf-draft-reopen", e);
      setError(msg(e));
    }
  };

  // The presenter window (?presenter=1) is a standalone speaker screen driven
  // entirely by BroadcastChannel from the main window — no vault, server or deck.
  const isPresenter = (() => {
    try {
      return new URLSearchParams(window.location.search).get("presenter") === "1";
    } catch {
      return false;
    }
  })();
  if (isPresenter) {
    return (
      <Suspense fallback={<div className="pv pv--empty">Chargement de la vue présentateur…</div>}>
        <PresenterView />
      </Suspense>
    );
  }

  // A remote signature request (?sign=…) takes over the whole app — no account
  // needed; the decryption secret lives in the URL fragment (Approche A).
  const signToken = (() => {
    try {
      return new URLSearchParams(window.location.search).get("sign");
    } catch {
      return null;
    }
  })();
  // `?party=` : correlates the link to its ParapheurParty.id in the document's
  // circuit (see SignLinkView / format/document.ts#markPartySigned). Absent
  // for links minted before this bridge, or for documents without a circuit.
  const signPartyId = (() => {
    try {
      return new URLSearchParams(window.location.search).get("party");
    } catch {
      return null;
    }
  })();
  if (signToken) {
    return (
      <div className="app">
        <Suspense fallback={<div className="pdf-loading">Ouverture de la demande de signature…</div>}>
          <SignLinkView
            token={signToken}
            partyId={signPartyId}
            onHome={() => {
              try {
                window.history.replaceState(null, "", window.location.pathname);
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          />
        </Suspense>
      </div>
    );
  }

  // A public share link (?link=…) takes over the whole app — no account needed;
  // the decryption secret lives in the URL fragment (never sent to the server).
  const linkToken = (() => {
    try {
      return new URLSearchParams(window.location.search).get("link");
    } catch {
      return null;
    }
  })();
  if (linkToken) {
    return (
      <div className="app">
        <Suspense fallback={<div className="pdf-loading">Ouverture du lien chiffré…</div>}>
          <OpenLinkView
            token={linkToken}
            onHome={() => {
              try {
                window.history.replaceState(null, "", window.location.pathname);
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          />
        </Suspense>
      </div>
    );
  }

  const ui = (
    <div className="app">
      {vaultState === "checking" ? (
        <div className="vault-gate" aria-hidden="true" />
      ) : vaultState === "locked" ? (
        <div className="vault-gate">
          <div className="vault-gate__card">
            <Lock size={28} />
            <h1>{t("vault.gate_title")}</h1>
            <p>{t("vault.gate_body")}</p>
            <Button onClick={() => void unlockVault()}>{t("vault.gate_unlock")}</Button>
            <button type="button" className="vault-gate__forgot" onClick={() => void resetVault()}>
              {t("vault.gate_forgot")}
            </button>
          </div>
        </div>
      ) : mode === "sheet" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_sheet")}</div>}>
          <SheetView
            key={`sheet-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "sheet" ? (appView.data as Workbook) : undefined}
            onExportElium={(data, title) => exportAppElium("sheet", data, title, !activeItem)}
            session={activeItem?.kind === "sheet" ? activeItem : undefined}
            workspace={ws}
            vaultSecret={vaultSecret}
          />
        </Suspense>
      ) : mode === "slides" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_slides")}</div>}>
          <SlidesView
            key={`slides-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "slides" ? (appView.data as Deck) : undefined}
            onExportElium={(data, title) => exportAppElium("slides", data, title, !activeItem)}
            vaultSecret={vaultSecret}
            session={activeItem?.kind === "slides" ? activeItem : undefined}
            workspace={ws}
          />
        </Suspense>
      ) : mode === "pdf" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_pdf")}</div>}>
          <PdfView
            key={`pdf-${appKey}`}
            onHome={() => setMode("home")}
            initial={appView?.kind === "pdf" ? (appView.data as PdfFile) : undefined}
            onExportElium={(data, title) => exportAppElium("pdf", data, title, !pdfSource)}
            vaultSecret={vaultSecret}
            source={pdfSource ?? undefined}
          />
        </Suspense>
      ) : mode === "drive-cloud" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_drive")}</div>}>
          <DriveCloudView onHome={() => setMode("home")} />
        </Suspense>
      ) : mode === "documentation" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_docs")}</div>}>
          <DocumentationView onHome={() => setMode("home")} />
        </Suspense>
      ) : mode === "detector" ? (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_detector")}</div>}>
          <DetectorView onHome={() => setMode("home")} />
        </Suspense>
      ) : mode === "home" || !studio ? (
        <HomeView
          ws={ws}
          search={search}
          replaceDeps={replaceDeps}
          view={view}
          onView={setView}
          searchQuery={searchQuery}
          onSearchQuery={setSearchQuery}
          onCreate={onCreate}
          onOpenPicked={(files) => void openPicked(files)}
          onPickNative={pickNative}
          onOpenItem={(item) => void openItem(item)}
          onOpenSettings={(target) =>
            openSettings(target as { category?: CategoryId; section?: SectionId } | undefined)
          }
          onNewSheet={() => startNew("sheet")}
          onNewSlides={() => startNew("slides")}
          onNewPdf={startNewPdf}
          onOpenDriveCloud={() => setMode("drive-cloud")}
          onOpenDocumentation={() => setMode("documentation")}
          onOpenDetector={() => setMode("detector")}
          onOpenPalette={() => setPaletteOpen(true)}
          onRecoverDraft={recoverDraft}
          onDownloadDraft={downloadDraft}
          onReopenPdfDraft={(id) => void reopenPdfDraft(id)}
          uncleanExit={sessionInfo.uncleanExit}
          previousStartedAt={sessionInfo.previousStartedAt}
          notify={setToast}
          newDocSignal={newDocSignal}
        />
      ) : (
        <Suspense fallback={<div className="pdf-loading">{t("app.loading_editor")}</div>}>
          <StudioView key={`${editorKey}-${editable}`} studio={studio} />
        </Suspense>
      )}

      {settingsOpen && (
        <SettingsModal
          key={`${settingsTarget?.category ?? ""}-${settingsTarget?.section ?? ""}`}
          initialCategory={settingsTarget?.category}
          initialSection={settingsTarget?.section}
          recipientPublic={recipientPublic}
          onGenerateRecipientKey={() => void generateRecipientKey()}
          onForgetRecipientKey={forgetMyRecipientKey}
          onOpenDocumentation={() => {
            setSettingsOpen(false);
            setMode("documentation");
          }}
          workspace={settingsBridge}
          theme={theme}
          onSetTheme={setTheme}
          identity={identity}
          trustBook={trustBook}
          onTrustContact={trustContact}
          onUntrustContact={untrustContact}
          onRegenerateIdentity={generateIdentity}
          onForgetIdentity={forgetIdentity}
          onBackupIdentity={() => setBackupOpen("manual")}
          onImportIdentity={() => setImportOpen(true)}
          onCopy={copyWithToast}
          onClearStorage={clearLocalStorage}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsTarget(undefined);
          }}
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
          onGenerateIdentity={generateIdentity}
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
          onSubmit={(v) => {
            pw.resolve(v);
            setPw(null);
          }}
          onCancel={() => {
            pw.resolve(null);
            setPw(null);
          }}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          items={ws.items}
          onOpenItem={(item) => void openItem(item)}
          onSearchWorkspace={goSearch}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      <input
        ref={appFileInputRef}
        type="file"
        hidden
        multiple
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void openPicked(files.map((file) => ({ file })));
          e.target.value = "";
        }}
      />
      {error && <Toast tone="danger" message={error} onClose={() => setError(null)} />}
      {toast && <Toast tone="success" message={toast} onClose={() => setToast(null)} />}
      {/* Le mot de passe est validé et sa boîte de dialogue se referme AVANT que
        le chiffrement/déchiffrement (Argon2id) ne s'exécute — sans ce repère,
        les ~200 ms qui suivent ne montrent rien du tout. */}
      {busy && (
        <div className="busy-indicator" role="status" aria-live="polite">
          <Loader2 size={14} className="icon-spin" /> {t("app.busy")}
        </div>
      )}
    </div>
  );
  return <KeyringContext.Provider value={keyring}>{ui}</KeyringContext.Provider>;
}
