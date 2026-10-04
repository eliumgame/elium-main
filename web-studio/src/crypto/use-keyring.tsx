/**
 * Contrôleur React du trousseau : relie le cœur (keyring*.ts, sans DOM) aux
 * invites de l'application (mot de passe, confirmations) et expose UNE API
 * stable à App.tsx et au panneau « Mes clés » via un contexte.
 *
 * Invariants de sécurité tenus ici :
 *  - aucun secret dans l'état React : l'état ne porte que des métadonnées
 *    publiques ; les clés privées vivent dans `KeyringSession` et n'en sortent
 *    qu'à la demande (`ensureIdentityPrivate`) ;
 *  - toute suppression de clé passe par `removeKey`, qui propose la sauvegarde
 *    AVANT et n'efface une clé jamais sauvegardée qu'après une confirmation
 *    explicite ;
 *  - une erreur n'est jamais avalée : `reportError` + message à l'utilisateur.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { strToU8 } from "fflate";
import { reportError } from "../ui/crash-log";
import { useDialogs } from "../ui/dialogs";
import { downloadBlob } from "../export/exporters";
import type { EliumIdentity } from "../sign/keys";
import { decryptPrivateKey } from "../sign/identity-store";
import type { RecipientKeypair } from "./recipients";
import {
  KeyringError,
  activeEntry,
  createIdbStore,
  createMaster,
  createMemoryStore,
  decryptCandidates,
  deleteKey,
  generateIdentityKey,
  generateRecipientKey,
  getMasterRecord,
  migrateLegacy,
  mirrorLegacy,
  putMasterRecord,
  reactivateKey,
  recoveryChecklist,
  renameKey,
  retireKey,
  revokeKey,
  rotateIdentityKey,
  rotateRecipientKey,
  setKeyExpiry,
  setOsProtection,
  type KeyEntry,
  type KeyringStore,
  type MasterRecord,
  type RecoveryChecklist,
} from "./keyring";
import { KeyringSession, loadIdleMinutes, saveIdleMinutes, type UnlockResult } from "./keyring-session";
import { changeKeyringPassword } from "./keyring-password";
import { buildBackup, importOpenedBundle, restoreFromMaster } from "./keyring-backup";
import { bundleFileName, openKeyBundle, parseAnyKeyFile, parseKeyBundle } from "./keyfile-v2";
import { restoreFromKeyFile } from "../sign/identity-store";
import { masterToPhrase, phraseToMaster } from "./recovery-phrase";
import { combineShares, splitSecret, type Share } from "./shamir";
import {
  createWebAuthnPrfAuthenticator,
  enrollPasskey,
  revokePasskey,
  unlockWithPasskey,
  type PrfAuthenticator,
} from "./keyring-passkeys";
import { rpIdFromOrigin } from "../drive-cloud/prf-unlock";
import { createLauncherKeystore, osKeystoreAvailable } from "./os-keystore";
import { encryptPrivateKey } from "../sign/identity-store";
import { fingerprintOf } from "../sign/keys";
import { KEY_SUITES } from "./keyfile-v2";
import { kidOf } from "./keyring";

export interface KeyringControllerDeps {
  /** Invite mot de passe (mode « set » = création avec confirmation). */
  askPassword: (title: string, kind: "set" | "enter", confirmHint?: string) => Promise<string | null>;
  notify: (message: string) => void;
  /** Appelé au verrouillage : l'appelant purge ses propres secrets (fichier-clé, etc.). */
  onLock?: () => void;
  /** Injection pour les tests / environnements sans WebAuthn. */
  authenticator?: PrfAuthenticator;
}

export interface KeyringController {
  loaded: boolean;
  entries: KeyEntry[];
  master: MasterRecord | undefined;
  checklist: RecoveryChecklist;
  /** Un secret est déverrouillé en mémoire. */
  unlocked: boolean;
  idleMinutes: number;
  /** Identité de signature active (la clé privée n'y figure que pendant le déverrouillage). */
  identity: EliumIdentity | null;
  recipientPublic: { publicHex: string; fingerprint: string } | null;
  passkeySupported: boolean;
  /** Le lanceur expose Windows DPAPI (couche optionnelle). */
  osProtectionAvailable: boolean;
  osProtected: boolean;
  setOsProtection(on: boolean): Promise<boolean>;

  lock(): void;
  unlock(): Promise<boolean>;
  setIdleMinutes(minutes: number): void;
  ensureIdentityPrivate(): Promise<string | null>;
  /** Clés de réception utilisables pour ouvrir un document (active d'abord, puis retirées). */
  recipientKeypairs(): Promise<RecipientKeypair[] | null>;

  createIdentity(): Promise<boolean>;
  createRecipientKey(): Promise<boolean>;
  rotate(id: string): Promise<boolean>;
  retire(id: string): Promise<void>;
  reactivate(id: string): Promise<void>;
  revoke(id: string): Promise<void>;
  setExpiry(id: string, iso: string | null): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  removeKey(id: string): Promise<boolean>;
  forgetAll(): Promise<void>;

  exportBackup(ids?: string[]): Promise<boolean>;
  importBackupText(text: string): Promise<boolean>;
  importRawIdentity(privateKeyHex: string, publicKeyHex: string, fingerprint: string): Promise<boolean>;
  changePassword(): Promise<boolean>;

  getRecoveryPhrase(): Promise<string | null>;
  markPhraseVerified(): Promise<void>;
  restoreFromPhrase(phrase: string): Promise<boolean>;
  splitMasterShares(k: number, n: number): Promise<Share[] | null>;
  markSharesExported(): Promise<void>;
  restoreFromShares(shares: Share[]): Promise<boolean>;

  enrollPasskey(label: string): Promise<boolean>;
  removePasskey(credentialId: string): Promise<void>;
  unlockWithPasskey(): Promise<boolean>;
}

const Ctx = createContext<KeyringController | null>(null);
export const KeyringContext = Ctx;

export function useKeyringController(): KeyringController {
  const c = useContext(Ctx);
  if (!c) throw new Error("useKeyringController doit être utilisé sous un KeyringContext.Provider");
  return c;
}

/** Variante non lançante (composants rendus hors App, ex. tests de rendu). */
export function useOptionalKeyring(): KeyringController | null {
  return useContext(Ctx);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useKeyring(deps: KeyringControllerDeps): KeyringController {
  const { confirm, alert } = useDialogs();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const store = useMemo<KeyringStore>(() => {
    try {
      if (typeof indexedDB !== "undefined") return createIdbStore();
    } catch (e) {
      reportError("keyring.store", e);
    }
    return createMemoryStore();
  }, []);
  const auth = useMemo(() => deps.authenticator ?? createWebAuthnPrfAuthenticator(), [deps.authenticator]);
  const session = useMemo(
    () =>
      new KeyringSession({
        idleMinutes: loadIdleMinutes(localStorage),
        onLock: () => depsRef.current.onLock?.(),
      }),
    [],
  );

  // Couche optionnelle « Protéger avec Windows » (lanceur de bureau uniquement).
  const os = useMemo(() => createLauncherKeystore(), []);
  const [osAvailable, setOsAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void osKeystoreAvailable(os).then((ok) => alive && setOsAvailable(ok));
    return () => {
      alive = false;
    };
  }, [os]);

  const [loaded, setLoaded] = useState(false);
  const [entries, setEntries] = useState<KeyEntry[]>([]);
  const [master, setMaster] = useState<MasterRecord | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [idleMinutes, setIdleState] = useState(() => loadIdleMinutes(localStorage));

  const refresh = useCallback(async () => {
    const all = await store.getAll();
    setEntries(all);
    setMaster(await getMasterRecord(store));
    try {
      await mirrorLegacy(store, localStorage);
    } catch (e) {
      reportError("keyring.mirror", e);
    }
  }, [store]);

  useEffect(() => session.onChange(() => setTick((t) => t + 1)), [session]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await migrateLegacy(store, localStorage);
        await refresh();
      } catch (e) {
        reportError("keyring.init", e);
        depsRef.current.notify(`Trousseau indisponible : ${msg(e)}`);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
      session.lock();
    };
  }, [store, refresh, session]);

  const fail = useCallback(
    (source: string, e: unknown) => {
      reportError(source, e);
      void alert({ title: "Trousseau", message: msg(e) });
    },
    [alert],
  );

  // --- Déverrouillage -----------------------------------------------------------

  const unlockInteractive = useCallback(
    async (title = "Déverrouiller le trousseau de clés"): Promise<boolean> => {
      if (session.unlocked) {
        session.touch();
        return true;
      }
      const rec = await getMasterRecord(store);
      if (rec?.passkeys.length && auth.supported()) {
        const usePasskey = await confirm({
          title,
          message: "Une clé d'accès est enrôlée pour ce trousseau. L'utiliser plutôt que le mot de passe ?",
          confirmLabel: "Clé d'accès",
          cancelLabel: "Mot de passe",
        });
        if (usePasskey) {
          try {
            const { master: m } = await unlockWithPasskey(store, auth, rpIdFromOrigin());
            await session.unlockWithMaster(await store.getAll(), m);
            m.fill(0);
            return true;
          } catch (e) {
            reportError("keyring.passkey", e);
            depsRef.current.notify(`Clé d'accès indisponible (${msg(e)}) — utilisez le mot de passe.`);
          }
        }
      }
      const pass = await depsRef.current.askPassword(title, "enter");
      if (!pass) return false;
      let res: UnlockResult;
      try {
        res = await session.unlockWithPassword(store, pass, os);
      } catch (e) {
        depsRef.current.notify(msg(e));
        return false;
      }
      if (res.failed.length) {
        depsRef.current.notify(
          `${res.failed.length} clé(s) héritée(s) ont un autre mot de passe : elles seront demandées à l'usage. « Changer le mot de passe » les unifie.`,
        );
      }
      return true;
    },
    [session, store, auth, confirm],
  );

  /** Déverrouille une clé héritée protégée par UN AUTRE mot de passe. */
  const unlockLegacyKey = useCallback(
    async (e: KeyEntry): Promise<string | null> => {
      if (e.protection !== "password" || !e.enc) return null;
      const pass = await depsRef.current.askPassword(`Mot de passe de la clé « ${e.label} »`, "enter");
      if (!pass) return null;
      try {
        const priv = await decryptPrivateKey(e.enc, pass);
        session.adopt(e.id, priv);
        return priv;
      } catch {
        depsRef.current.notify("Mot de passe de la clé incorrect.");
        return null;
      }
    },
    [session],
  );

  const ensureIdentityPrivate = useCallback(async (): Promise<string | null> => {
    const all = await store.getAll();
    const id =
      activeEntry(all, "identity-ed25519") ?? all.find((e) => e.type === "identity-ed25519" && e.status !== "revoked");
    if (!id) {
      depsRef.current.notify("Aucune identité de signature : générez-en une dans « Mes clés ».");
      return null;
    }
    const have = session.getPrivate(id.id);
    if (have) return have;
    if (!(await unlockInteractive("Déverrouiller votre clé de signature"))) return null;
    return session.getPrivate(id.id) ?? (await unlockLegacyKey(id));
  }, [store, session, unlockInteractive, unlockLegacyKey]);

  const recipientKeypairs = useCallback(async (): Promise<RecipientKeypair[] | null> => {
    const cands = decryptCandidates(await store.getAll());
    if (cands.length === 0) return null;
    if (!cands.some((c) => session.getPrivate(c.id))) {
      if (!(await unlockInteractive("Déverrouiller votre clé de réception"))) return null;
    }
    const out: RecipientKeypair[] = [];
    for (const c of cands) {
      const priv = session.getPrivate(c.id) ?? (c.status === "active" ? await unlockLegacyKey(c) : null);
      if (priv) out.push({ privateHex: priv, publicHex: c.publicHex });
    }
    return out.length ? out : null;
  }, [store, session, unlockInteractive, unlockLegacyKey]);

  /** Garantit un secret maître déverrouillé (le crée au premier usage). */
  const ensureMaster = useCallback(async (): Promise<Uint8Array | null> => {
    const have = session.getMaster();
    if (have) return have;
    const rec = await getMasterRecord(store);
    if (rec) {
      if (!(await unlockInteractive())) return null;
      return session.getMaster();
    }
    const pass = await depsRef.current.askPassword(
      "Définir le mot de passe de votre trousseau de clés",
      "set",
      "Un seul mot de passe protège toutes vos clés. 4 caractères minimum. Sans lui (ni phrase de récupération), elles sont irrécupérables.",
    );
    if (!pass) return null;
    const { master: m } = await createMaster(store, pass);
    session.adoptMaster(m);
    return session.getMaster();
  }, [session, store, unlockInteractive]);

  // --- Sauvegarde ------------------------------------------------------------------

  const exportBackup = useCallback(
    async (ids?: string[]): Promise<boolean> => {
      try {
        const targets = (await store.getAll()).filter((e) => e.type !== "contact" && (!ids || ids.includes(e.id)));
        if (targets.length === 0) return false;
        if (targets.some((e) => !session.getPrivate(e.id))) {
          if (!(await unlockInteractive("Déverrouiller le trousseau pour le sauvegarder"))) return false;
          for (const e of targets) if (!session.getPrivate(e.id)) await unlockLegacyKey(e);
        }
        const pass = await depsRef.current.askPassword(
          "Mot de passe de la sauvegarde .eliumkey",
          "set",
          "Ce mot de passe chiffre le fichier de sauvegarde (Argon2id + AES-256-GCM). Notez-le séparément du fichier.",
        );
        if (!pass) return false;
        const file = await buildBackup(store, session, pass, ids);
        downloadBlob(bundleFileName(), "application/json", strToU8(JSON.stringify(file, null, 2)));
        await refresh();
        depsRef.current.notify(`Sauvegarde .eliumkey téléchargée (${targets.length} clé(s)).`);
        return true;
      } catch (e) {
        fail("keyring.export", e);
        return false;
      }
    },
    [store, session, unlockInteractive, unlockLegacyKey, refresh, fail],
  );

  /** Après création d'une clé : sauvegarde IMMÉDIATE obligatoire (sinon avertissement durable). */
  const forceBackup = useCallback(
    async (id: string, what: string) => {
      const ok = await exportBackup([id]);
      if (!ok) {
        await alert({
          title: "Clé non sauvegardée",
          message: `Votre ${what} n'est pas sauvegardée. Si ce navigateur est réinitialisé, elle sera perdue — et avec elle l'accès aux documents qui lui sont destinés. Sauvegardez-la depuis « Mes clés » dès que possible.`,
        });
      }
    },
    [exportBackup, alert],
  );

  // --- Création / rotation ----------------------------------------------------------

  const createIdentity = useCallback(async (): Promise<boolean> => {
    try {
      const m = await ensureMaster();
      if (!m) return false;
      const { entry, privateKeyHex } = await generateIdentityKey(store, m);
      session.adopt(entry.id, privateKeyHex);
      await refresh();
      return true;
    } catch (e) {
      fail("keyring.createIdentity", e);
      return false;
    }
  }, [ensureMaster, store, session, refresh, fail]);

  const createRecipientKey = useCallback(async (): Promise<boolean> => {
    try {
      const m = await ensureMaster();
      if (!m) return false;
      const { entry, privateHex } = await generateRecipientKey(store, m);
      session.adopt(entry.id, privateHex);
      await refresh();
      await forceBackup(entry.id, "clé de réception");
      return true;
    } catch (e) {
      fail("keyring.createRecipient", e);
      return false;
    }
  }, [ensureMaster, store, session, refresh, forceBackup, fail]);

  const rotate = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const entry = (await store.getAll()).find((e) => e.id === id);
        if (!entry) return false;
        const ok = await confirm({
          title: "Faire tourner cette clé ?",
          message:
            entry.type === "identity-ed25519"
              ? "Une nouvelle identité est créée et liée à l'ancienne par un certificat de succession ; l'ancienne reste vérifiable mais n'est plus utilisée pour signer. Vos correspondants devront accepter la succession."
              : "Une nouvelle clé de réception est créée. L'ancienne est conservée pour ouvrir les anciens documents ; communiquez la nouvelle clé publique à vos correspondants.",
          confirmLabel: "Faire tourner",
        });
        if (!ok) return false;
        const m = await ensureMaster();
        if (!m) return false;
        if (entry.type === "identity-ed25519") {
          const priv = session.getPrivate(entry.id) ?? (await ensureIdentityPrivate());
          if (!priv) return false;
          const res = await rotateIdentityKey(store, m, { entry, privateKeyHex: priv });
          session.adopt(res.entry.id, res.privateKeyHex);
          await refresh();
          await forceBackup(res.entry.id, "nouvelle identité");
        } else if (entry.type === "recipient-p256") {
          const res = await rotateRecipientKey(store, m, entry);
          session.adopt(res.entry.id, res.privateHex);
          await refresh();
          await forceBackup(res.entry.id, "nouvelle clé de réception");
        }
        return true;
      } catch (e) {
        fail("keyring.rotate", e);
        return false;
      }
    },
    [store, confirm, ensureMaster, session, ensureIdentityPrivate, refresh, forceBackup, fail],
  );

  const run = useCallback(
    async (source: string, f: () => Promise<unknown>) => {
      try {
        await f();
        await refresh();
      } catch (e) {
        fail(source, e);
      }
    },
    [refresh, fail],
  );

  const removeKey = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const entry = (await store.getAll()).find((e) => e.id === id);
        if (!entry) return false;
        if (!entry.backedUpAt) {
          const backupFirst = await confirm({
            title: "Cette clé n'est pas sauvegardée",
            message:
              "La supprimer la rend IRRÉCUPÉRABLE (et les documents chiffrés pour elle deviennent illisibles). Exportez d'abord une sauvegarde .eliumkey.",
            confirmLabel: "Sauvegarder d'abord",
            cancelLabel: "Continuer sans sauvegarde",
          });
          if (backupFirst) {
            if (!(await exportBackup([id]))) return false;
          } else {
            const sure = await confirm({
              title: "Supprimer définitivement sans sauvegarde ?",
              message: `« ${entry.label} » sera perdue pour toujours. Cette action est irréversible.`,
              confirmLabel: "Supprimer définitivement",
              danger: true,
            });
            if (!sure) return false;
          }
        } else if (
          !(await confirm({
            title: "Supprimer cette clé ?",
            message: `« ${entry.label} » sera retirée de ce navigateur. Votre sauvegarde reste valable.`,
            confirmLabel: "Supprimer",
            danger: true,
          }))
        ) {
          return false;
        }
        const fresh = (await store.getAll()).find((e) => e.id === id);
        await deleteKey(store, id, { acknowledgeLoss: !fresh?.backedUpAt });
        await refresh();
        depsRef.current.notify("Clé supprimée de ce navigateur");
        return true;
      } catch (e) {
        fail("keyring.remove", e);
        return false;
      }
    },
    [store, confirm, exportBackup, refresh, fail],
  );

  const forgetAll = useCallback(async () => {
    session.lock();
    await store.clear();
    try {
      localStorage.removeItem("elium_identity");
      localStorage.removeItem("elium_recipient_key");
    } catch (e) {
      reportError("keyring.forgetAll", e);
    }
    await refresh();
  }, [session, store, refresh]);

  // --- Import -----------------------------------------------------------------------

  const importBackupText = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        const parsed = parseAnyKeyFile(text);
        if (parsed.version === 1) {
          const pass = await depsRef.current.askPassword("Mot de passe de la clé sauvegardée", "enter");
          if (!pass) return false;
          const id = await restoreFromKeyFile(parsed.stored, pass);
          const fingerprint = id.fingerprint;
          const added = await store.getAll();
          if (!added.some((e) => e.id === kidOf(fingerprint))) {
            await store.put({
              id: kidOf(fingerprint),
              type: "identity-ed25519",
              suite: KEY_SUITES["identity-ed25519"],
              label: "Identité importée",
              createdAt: new Date().toISOString(),
              status: "active",
              usage: "sign",
              publicHex: id.publicKeyHex,
              fingerprint,
              protection: "password",
              enc: parsed.stored.enc,
              backedUpAt: new Date().toISOString(),
            });
          }
          session.adopt(kidOf(fingerprint), id.privateKeyHex);
          await refresh();
          depsRef.current.notify("Identité restaurée depuis la sauvegarde");
          return true;
        }
        const pass = await depsRef.current.askPassword("Mot de passe de la sauvegarde .eliumkey", "enter");
        if (!pass) return false;
        const opened = await openKeyBundle(parseKeyBundle(text), pass);
        const hadMaster = !!(await getMasterRecord(store));
        const res = await importOpenedBundle(store, opened, pass);
        // Les clés importées sont déjà en clair ici : on les confie à la session (aucun nouveau mot de passe).
        for (const k of opened.keys) session.adopt(k.meta.kid, k.privateHex);
        if (res.masterInstalled && opened.master) session.adoptMaster(opened.master);
        await refresh();
        depsRef.current.notify(
          `${res.added.length} clé(s) importée(s)${res.existing.length ? `, ${res.existing.length} déjà présente(s)` : ""}` +
            (hadMaster ? " — protégées par le mot de passe de la sauvegarde." : "."),
        );
        return true;
      } catch (e) {
        fail("keyring.import", e);
        return false;
      }
    },
    [store, session, refresh, fail],
  );

  const importRawIdentity = useCallback(
    async (privateKeyHex: string, publicKeyHex: string, fingerprint: string): Promise<boolean> => {
      try {
        const pass = await depsRef.current.askPassword("Définir un mot de passe pour protéger votre clé privée", "set");
        if (!pass) return false;
        const enc = await encryptPrivateKey(privateKeyHex, pass);
        const id = kidOf(fingerprint || (await fingerprintOf(publicKeyHex)));
        await store.put({
          id,
          type: "identity-ed25519",
          suite: KEY_SUITES["identity-ed25519"],
          label: "Identité importée",
          createdAt: new Date().toISOString(),
          status: "active",
          usage: "sign",
          publicHex: publicKeyHex,
          fingerprint,
          protection: "password",
          enc,
        });
        session.adopt(id, privateKeyHex);
        await refresh();
        return true;
      } catch (e) {
        fail("keyring.importRaw", e);
        return false;
      }
    },
    [store, session, refresh, fail],
  );

  const changePassword = useCallback(async (): Promise<boolean> => {
    try {
      const old = await depsRef.current.askPassword("Mot de passe actuel du trousseau", "enter");
      if (!old) return false;
      const next = await depsRef.current.askPassword("Nouveau mot de passe du trousseau", "set");
      if (!next) return false;
      const res = await changeKeyringPassword(store, old, next, os);
      await refresh();
      depsRef.current.notify(
        res.skipped.length
          ? `Mot de passe changé. ${res.skipped.length} clé(s) héritée(s) avaient un autre mot de passe et n'ont pas été modifiées.`
          : "Mot de passe du trousseau changé",
      );
      return true;
    } catch (e) {
      fail("keyring.changePassword", e);
      return false;
    }
  }, [store, refresh, fail]);

  // --- Récupération ------------------------------------------------------------------

  const getRecoveryPhrase = useCallback(async (): Promise<string | null> => {
    try {
      const m = await ensureMaster();
      if (!m) return null;
      const phrase = masterToPhrase(m);
      m.fill(0);
      return phrase;
    } catch (e) {
      fail("keyring.phrase", e);
      return null;
    }
  }, [ensureMaster, fail]);

  const markPhraseVerified = useCallback(async () => {
    const rec = await getMasterRecord(store);
    if (!rec) return;
    await putMasterRecord(store, { ...rec, phraseVerifiedAt: new Date().toISOString() });
    await refresh();
  }, [store, refresh]);

  const afterRestore = useCallback(
    async (m: Uint8Array, pass: string) => {
      const { restored } = await restoreFromMaster(store, m, pass);
      session.adoptMaster(m);
      await session.unlockWithMaster(await store.getAll(), m);
      await refresh();
      depsRef.current.notify(`Trousseau restauré (${restored.length} clé(s) re-dérivée(s)).`);
    },
    [store, session, refresh],
  );

  const restoreFromPhrase = useCallback(
    async (phrase: string): Promise<boolean> => {
      try {
        const m = phraseToMaster(phrase);
        const pass = await depsRef.current.askPassword("Nouveau mot de passe du trousseau restauré", "set");
        if (!pass) return false;
        await afterRestore(m, pass);
        return true;
      } catch (e) {
        fail("keyring.restorePhrase", e);
        return false;
      }
    },
    [afterRestore, fail],
  );

  const splitMasterShares = useCallback(
    async (k: number, n: number): Promise<Share[] | null> => {
      try {
        const m = await ensureMaster();
        if (!m) return null;
        const shares = await splitSecret(m, k, n);
        m.fill(0);
        return shares;
      } catch (e) {
        fail("keyring.split", e);
        return null;
      }
    },
    [ensureMaster, fail],
  );

  const markSharesExported = useCallback(async () => {
    const rec = await getMasterRecord(store);
    if (!rec) return;
    await putMasterRecord(store, { ...rec, sharesExportedAt: new Date().toISOString() });
    await refresh();
  }, [store, refresh]);

  const restoreFromShares = useCallback(
    async (shares: Share[]): Promise<boolean> => {
      try {
        const m = await combineShares(shares);
        const pass = await depsRef.current.askPassword("Nouveau mot de passe du trousseau restauré", "set");
        if (!pass) return false;
        await afterRestore(m, pass);
        return true;
      } catch (e) {
        fail("keyring.restoreShares", e);
        return false;
      }
    },
    [afterRestore, fail],
  );

  // --- Passkeys ------------------------------------------------------------------------

  const enrollPasskeyAction = useCallback(
    async (label: string): Promise<boolean> => {
      try {
        const m = await ensureMaster();
        if (!m) return false;
        await enrollPasskey(store, m, auth, rpIdFromOrigin(), label);
        m.fill(0);
        await refresh();
        depsRef.current.notify("Clé d'accès enrôlée : elle peut désormais déverrouiller le trousseau.");
        return true;
      } catch (e) {
        fail("keyring.enrollPasskey", e);
        return false;
      }
    },
    [ensureMaster, store, auth, refresh, fail],
  );

  const removePasskey = useCallback(
    (credentialId: string) => run("keyring.revokePasskey", () => revokePasskey(store, credentialId)),
    [run, store],
  );

  const unlockWithPasskeyAction = useCallback(async (): Promise<boolean> => {
    try {
      const { master: m } = await unlockWithPasskey(store, auth, rpIdFromOrigin());
      await session.unlockWithMaster(await store.getAll(), m);
      m.fill(0);
      return true;
    } catch (e) {
      fail("keyring.unlockPasskey", e);
      return false;
    }
  }, [store, auth, session, fail]);

  // --- Valeurs dérivées ------------------------------------------------------------------

  const identity = useMemo<EliumIdentity | null>(() => {
    const id =
      activeEntry(entries, "identity-ed25519") ??
      entries.find((e) => e.type === "identity-ed25519" && e.status !== "revoked");
    if (!id) {
      if (loaded) return null;
      // Avant la fin du chargement IndexedDB : état initial synchrone depuis le stockage historique.
      try {
        const raw = JSON.parse(localStorage.getItem("elium_identity") ?? "null") as {
          publicKeyHex?: string;
          fingerprint?: string;
        } | null;
        return raw?.publicKeyHex && raw.fingerprint
          ? { publicKeyHex: raw.publicKeyHex, fingerprint: raw.fingerprint }
          : null;
      } catch {
        return null;
      }
    }
    const priv = session.isKeyUnlocked(id.id) ? session.getPrivate(id.id) : undefined;
    return { publicKeyHex: id.publicHex, fingerprint: id.fingerprint, ...(priv ? { privateKeyHex: priv } : {}) };
    // `tick` : recalcul à chaque (dé)verrouillage pour que la clé privée disparaisse de l'état au lock().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, loaded, session, tick]);

  const recipientPublic = useMemo(() => {
    const r = activeEntry(entries, "recipient-p256") ?? decryptCandidates(entries).find((e) => e.status !== "revoked");
    if (!r) {
      if (loaded) return null;
      try {
        const raw = JSON.parse(localStorage.getItem("elium_recipient_key") ?? "null") as {
          publicHex?: string;
          fingerprint?: string;
        } | null;
        return raw?.publicHex && raw.fingerprint ? { publicHex: raw.publicHex, fingerprint: raw.fingerprint } : null;
      } catch {
        return null;
      }
    }
    return { publicHex: r.publicHex, fingerprint: r.fingerprint };
  }, [entries, loaded]);

  const setIdleMinutes = useCallback(
    (minutes: number) => {
      saveIdleMinutes(localStorage, minutes);
      session.setIdleMinutes(minutes);
      setIdleState(minutes);
    },
    [session],
  );

  const checklist = useMemo(() => recoveryChecklist(entries, master), [entries, master]);

  return useMemo<KeyringController>(
    () => ({
      loaded,
      entries,
      master,
      checklist,
      unlocked: session.unlocked,
      idleMinutes,
      identity,
      recipientPublic,
      passkeySupported: auth.supported(),
      osProtectionAvailable: osAvailable,
      osProtected: !!master?.osLayer,
      setOsProtection: async (on: boolean) => {
        try {
          if (!os) return false;
          // Le secret maître doit exister : on le crée (mot de passe) si besoin.
          if (!(await getMasterRecord(store)) && !(await ensureMaster())) return false;
          await setOsProtection(store, os, on);
          await refresh();
          depsRef.current.notify(
            on ? "Trousseau protégé par Windows (en plus du mot de passe)" : "Protection Windows retirée",
          );
          return true;
        } catch (e) {
          fail("keyring.os", e);
          return false;
        }
      },
      lock: () => session.lock(),
      unlock: () => unlockInteractive(),
      setIdleMinutes,
      ensureIdentityPrivate,
      recipientKeypairs,
      createIdentity,
      createRecipientKey,
      rotate,
      retire: (id) => run("keyring.retire", () => retireKey(store, id)),
      reactivate: (id) => run("keyring.reactivate", () => reactivateKey(store, id)),
      revoke: (id) => run("keyring.revoke", () => revokeKey(store, id)),
      setExpiry: (id, iso) => run("keyring.expiry", () => setKeyExpiry(store, id, iso)),
      rename: (id, label) => run("keyring.rename", () => renameKey(store, id, label)),
      removeKey,
      forgetAll,
      exportBackup,
      importBackupText,
      importRawIdentity,
      changePassword,
      getRecoveryPhrase,
      markPhraseVerified,
      restoreFromPhrase,
      splitMasterShares,
      markSharesExported,
      restoreFromShares,
      enrollPasskey: enrollPasskeyAction,
      removePasskey,
      unlockWithPasskey: unlockWithPasskeyAction,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      loaded,
      entries,
      master,
      checklist,
      tick,
      idleMinutes,
      identity,
      recipientPublic,
      auth,
      session,
      store,
      os,
      osAvailable,
    ],
  );
}

export { KeyringError };
