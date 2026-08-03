/**
 * Drive session context. Holds the API client, the (in-memory only) account
 * keys, the current organization and its roles, and orchestrates register /
 * login / unlock / logout. Private keys are NEVER persisted: on reload we keep
 * only the tokens + the (already-encrypted) key bundle, and require the password
 * again to unlock the keys.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DriveApi, ApiError } from "./api";
import { buildRegistration, prepareLogin, unlockAccount, signLoginChallenge, type AccountKeys } from "./account";
import { generateRecipientKeypair, encryptForRecipients } from "../crypto/recipients";
import { fromHex } from "../format/canonical";
import {
  enrollPrf,
  wrapMaster,
  unwrapMaster,
  evaluatePrf,
  savePrfRecord,
  removePrfRecord,
  getPrfRecord,
  hasPrfRecord,
  webauthnSupported,
  rpIdFromOrigin,
  prfResultToBytes,
  PRF_SALT_B64URL,
} from "./prf-unlock";
import { isMfaChallenge, type Tokens, type PublicUser, type RoleDef, type LoginResult } from "./types";
import type { KdfParams, KeyBundle } from "./kdf";

const STORAGE_KEY = "elium_drive_session_v1";

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  orgPublicHex: string;
  roleId?: string;
  roleKey?: string;
}

type Status = "loading" | "anonymous" | "locked" | "mfa" | "authenticated";

interface Persisted {
  tokens: Tokens;
  snapshot: { user: PublicUser; keyBundle: KeyBundle; kdfSalt: string; kdfParams: KdfParams };
  currentOrgId?: string;
}

export interface DriveSession {
  status: Status;
  api: DriveApi;
  user: PublicUser | null;
  keys: AccountKeys | null;
  orgs: OrgInfo[];
  currentOrg: OrgInfo | null;
  roles: RoleDef[];
  roleIdByKey: Record<string, string>;
  lockedEmail: string | null;
  /** An org invite token found in the URL (?invite=…), auto-accepted after auth. */
  pendingInvite: string | null;
  busy: boolean;
  error: string | null;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  /** Connexion SANS mot de passe via clé d'accès (WebAuthn 1er facteur + PRF). */
  loginWithPasskey: () => Promise<void>;
  /** Complete a login that returned an MFA challenge (TOTP or backup code). */
  completeMfa: (code: string) => Promise<void>;
  /** Complete the login's second factor with a WebAuthn passkey. */
  completeMfaWebauthn: () => Promise<void>;
  /** Second factors available for the pending MFA challenge (TOTP / WebAuthn). */
  mfaMethods: { totp: boolean; webauthn: boolean } | null;
  /** Abandon a pending MFA challenge and return to the login screen. */
  cancelMfa: () => void;
  unlock: (password: string) => Promise<void>;
  /** Déverrouille la session verrouillée via une clé d'accès (PRF WebAuthn). */
  unlockWithPasskey: () => Promise<void>;
  /** Active le déverrouillage par clé d'accès pour la passkey `credentialId`
   *  (issue de l'enrôlement). Renvoie false si l'authentificateur n'a pas PRF. */
  enrollPasskeyUnlock: (credentialId: string | null) => Promise<boolean>;
  /** Désactive (oublie localement) le déverrouillage par clé d'accès. */
  disablePasskeyUnlock: () => void;
  /** Vrai si une clé d'accès peut déverrouiller la session actuellement verrouillée. */
  passkeyUnlockAvailable: boolean;
  /** Vrai si le déverrouillage par clé d'accès est activé pour l'utilisateur connecté. */
  passkeyUnlockEnabled: boolean;
  logout: () => Promise<void>;
  refreshOrgs: () => Promise<void>;
  selectOrg: (orgId: string) => Promise<void>;
  createOrg: (name: string, slug: string) => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<DriveSession | null>(null);

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Erreur inattendue.";
}

export function DriveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [keys, setKeys] = useState<AccountKeys | null>(null);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot needed to unlock keys with the password after a reload.
  const snapshotRef = useRef<Persisted["snapshot"] | null>(null);
  // La masterKey (dérivée de la passphrase) — EN MÉMOIRE UNIQUEMENT, jamais
  // persistée. Conservée pour activer le déverrouillage par clé d'accès (PRF),
  // qui doit chiffrer cette clé sous le secret de l'authentificateur.
  const masterKeyRef = useRef<Uint8Array | null>(null);
  // Incrémenté après enrôlement/oubli d'une clé d'accès, pour recalculer les
  // drapeaux dérivés (passkeyUnlock*) sans lire localStorage à chaque rendu.
  const [prfTick, setPrfTick] = useState(0);
  // Invite token from the URL (?invite=…) — kept in a ref so finishAuth sees it.
  const inviteRef = useRef<string | null>(null);
  // Pending MFA challenge: the masterKey is already derived (password verified);
  // we hold it in memory ONLY until the second factor completes the login.
  const mfaPendingRef = useRef<{ mfaToken: string; masterKey: Uint8Array; kdfSalt: string; kdfParams: KdfParams } | null>(null);
  const [mfaMethods, setMfaMethods] = useState<{ totp: boolean; webauthn: boolean } | null>(null);

  const persist = useCallback((patch: Partial<Persisted>) => {
    const cur = readPersisted() ?? ({} as Partial<Persisted>);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
  }, []);

  // One API client for the whole session; token refreshes are persisted.
  const api = useMemo(
    () =>
      new DriveApi({
        tokens: readPersisted()?.tokens ?? null,
        onTokens: (t) => {
          if (t) persist({ tokens: t });
          else localStorage.removeItem(STORAGE_KEY);
        },
      }),
    [persist],
  );

  const loadOrgs = useCallback(async (): Promise<OrgInfo[]> => {
    const { organizations } = await api.listOrgs();
    const list = (organizations as OrgInfo[]) ?? [];
    setOrgs(list);
    return list;
  }, [api]);

  const selectOrg = useCallback(
    async (orgId: string) => {
      setCurrentOrgId(orgId);
      persist({ currentOrgId: orgId });
      try {
        const { roles: r } = await api.listRoles(orgId);
        setRoles(r ?? []);
      } catch {
        setRoles([]);
      }
    },
    [api, persist],
  );

  const refreshOrgs = useCallback(async () => {
    const list = await loadOrgs();
    if (list.length && !list.some((o) => o.id === currentOrgId)) {
      await selectOrg(list[0]!.id);
    }
  }, [loadOrgs, currentOrgId, selectOrg]);

  const finishAuth = useCallback(
    async (u: PublicUser, k: AccountKeys, preferOrgId?: string) => {
      setUser(u);
      setKeys(k);
      setStatus("authenticated");
      // If arriving via an invite link, join that organization first.
      let joinedOrgId: string | undefined;
      if (inviteRef.current) {
        try {
          const { orgId } = await api.acceptInvite(inviteRef.current);
          joinedOrgId = orgId;
        } catch {
          /* invalid/expired invite — the user is still authenticated */
        }
        inviteRef.current = null;
        setPendingInvite(null);
        try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
      }
      const list = await loadOrgs();
      const pref = joinedOrgId ?? preferOrgId;
      const target = pref && list.some((o) => o.id === pref) ? pref : list[0]?.id;
      if (target) await selectOrg(target);
    },
    [api, loadOrgs, selectOrg],
  );

  // --- Attempt to restore a locked session on mount ------------------------
  useEffect(() => {
    try {
      const t = new URLSearchParams(location.search).get("invite");
      if (t) { inviteRef.current = t; setPendingInvite(t); }
    } catch { /* ignore */ }
    const p = readPersisted();
    if (p?.snapshot && p.tokens) {
      snapshotRef.current = p.snapshot;
      setLockedEmail(p.snapshot.user.email);
      setUser(p.snapshot.user);
      if (p.currentOrgId) setCurrentOrgId(p.currentOrgId);
      setStatus("locked");
    } else {
      setStatus("anonymous");
    }
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      setBusy(true);
      setError(null);
      try {
        const { payload, keys: k, masterKey } = await buildRegistration(email.trim(), password, displayName.trim());
        masterKeyRef.current = masterKey;
        const res = await api.register(payload);
        api.setTokens({ accessToken: res.accessToken, accessTokenExpiresAt: res.accessTokenExpiresAt, refreshToken: res.refreshToken });
        snapshotRef.current = { user: res.user, keyBundle: payload.keyBundle, kdfSalt: payload.kdfSalt, kdfParams: payload.kdfParams };
        persist({ snapshot: snapshotRef.current });
        setLockedEmail(res.user.email);
        await finishAuth(res.user, k);
      } catch (e) {
        setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, persist, finishAuth],
  );

  // Shared tail of a successful login (single-step or after MFA): store tokens,
  // unlock keys with the already-derived masterKey, persist the snapshot.
  const finishLogin = useCallback(
    async (res: LoginResult, masterKey: Uint8Array, kdfSalt: string, kdfParams: KdfParams) => {
      api.setTokens({ accessToken: res.accessToken, accessTokenExpiresAt: res.accessTokenExpiresAt, refreshToken: res.refreshToken });
      masterKeyRef.current = masterKey;
      const k = await unlockAccount(res.keyBundle, masterKey, res.user);
      snapshotRef.current = { user: res.user, keyBundle: res.keyBundle, kdfSalt, kdfParams };
      persist({ snapshot: snapshotRef.current });
      setLockedEmail(res.user.email);
      await finishAuth(res.user, k);
    },
    [api, persist, finishAuth],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      setBusy(true);
      setError(null);
      try {
        const pre = await api.prelogin(email.trim());
        const { authSignSeedHex, masterKey } = await prepareLogin(password, pre.kdfSalt, pre.kdfParams as KdfParams);
        // Oracle-free handshake: fetch a challenge, sign it with the password-
        // derived auth key. The password itself never leaves the browser.
        const { challengeId, challenge } = await api.loginInit(email.trim());
        const signature = await signLoginChallenge(challenge, authSignSeedHex);
        const res = await api.loginVerify(email.trim(), challengeId, signature);
        if (isMfaChallenge(res)) {
          // Password OK, second factor required. Hold the derived masterKey in
          // memory (never persisted) until the code completes the login.
          mfaPendingRef.current = { mfaToken: res.mfaToken, masterKey, kdfSalt: pre.kdfSalt, kdfParams: pre.kdfParams as KdfParams };
          setMfaMethods(res.methods ?? { totp: true, webauthn: false });
          setLockedEmail(email.trim());
          setStatus("mfa");
          return;
        }
        await finishLogin(res, masterKey, pre.kdfSalt, pre.kdfParams as KdfParams);
      } catch (e) {
        setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, finishLogin],
  );

  // Connexion SANS mot de passe : une seule cérémonie WebAuthn (clé découvrable)
  // authentifie AU SERVEUR (retourne tokens + keyBundle) ET produit, via
  // l'extension PRF, le secret qui déchiffre la masterKey localement. Si aucun
  // enregistrement PRF n'existe sur cet appareil, on reste authentifié mais
  // « verrouillé » (déverrouillage par mot de passe, keyBundle déjà en main).
  const loginWithPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await api.webauthnAssertOptions();
      const optionsJSON = {
        ...(options as Record<string, unknown>),
        extensions: {
          ...((options as { extensions?: Record<string, unknown> }).extensions ?? {}),
          prf: { eval: { first: PRF_SALT_B64URL } },
        },
      };
      const assertion = await startAuthentication({ optionsJSON: optionsJSON as never });
      const res = await api.webauthnAssertVerify(challengeId, assertion);
      const prfB64 = (assertion as { clientExtensionResults?: { prf?: { results?: { first?: string } } } })
        .clientExtensionResults?.prf?.results?.first;
      const rec = getPrfRecord(res.user.email);
      if (prfB64 && rec) {
        // Déverrouillage complet : PRF → masterKey → keyBundle.
        const masterKey = await unwrapMaster(prfResultToBytes(prfB64), rec.wrapped);
        await finishLogin(res, masterKey, res.kdfSalt, res.kdfParams);
      } else {
        // Authentifié au serveur mais pas de secret local : session verrouillée.
        api.setTokens({ accessToken: res.accessToken, accessTokenExpiresAt: res.accessTokenExpiresAt, refreshToken: res.refreshToken });
        snapshotRef.current = { user: res.user, keyBundle: res.keyBundle, kdfSalt: res.kdfSalt, kdfParams: res.kdfParams };
        persist({ snapshot: snapshotRef.current });
        setUser(res.user);
        setLockedEmail(res.user.email);
        setStatus("locked");
        if (!prfB64) setError("Clé sans PRF : entrez votre mot de passe pour déverrouiller.");
        else setError("Pas de déverrouillage par clé sur cet appareil : entrez votre mot de passe.");
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") setError("Connexion par clé d'accès impossible.");
      throw e;
    } finally {
      setBusy(false);
    }
  }, [api, persist, finishLogin]);

  const completeMfa = useCallback(
    async (code: string) => {
      const pending = mfaPendingRef.current;
      if (!pending) {
        setStatus("anonymous");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await api.loginMfa(pending.mfaToken, code.trim());
        await finishLogin(res, pending.masterKey, pending.kdfSalt, pending.kdfParams);
        mfaPendingRef.current = null;
        setMfaMethods(null);
      } catch (e) {
        setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, finishLogin],
  );

  // Second factor via WebAuthn passkey: fetch a challenge, run the browser
  // ceremony (navigator.credentials.get), verify server-side, then finish login.
  const completeMfaWebauthn = useCallback(
    async () => {
      const pending = mfaPendingRef.current;
      if (!pending) {
        setStatus("anonymous");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const { startAuthentication } = await import("@simplewebauthn/browser");
        const options = await api.webauthnLoginOptions(pending.mfaToken);
        const assertion = await startAuthentication({ optionsJSON: options as never });
        const res = await api.webauthnLoginVerify(pending.mfaToken, assertion);
        await finishLogin(res, pending.masterKey, pending.kdfSalt, pending.kdfParams);
        mfaPendingRef.current = null;
        setMfaMethods(null);
      } catch (e) {
        // Annulation / timeout / page sans focus de la cérémonie passkey : rester
        // sur l'écran du 2e facteur sans erreur alarmante (filtrage par NOM).
        const name = e instanceof Error ? e.name : "";
        if (name !== "NotAllowedError" && name !== "AbortError") setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, finishLogin],
  );

  const cancelMfa = useCallback(() => {
    mfaPendingRef.current = null;
    setMfaMethods(null);
    setError(null);
    setStatus("anonymous");
  }, []);

  const unlock = useCallback(
    async (password: string) => {
      const snap = snapshotRef.current;
      if (!snap) {
        setStatus("anonymous");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const { masterKey } = await prepareLogin(password, snap.kdfSalt, snap.kdfParams);
        masterKeyRef.current = masterKey;
        const k = await unlockAccount(snap.keyBundle, masterKey, snap.user);
        await finishAuth(snap.user, k, readPersisted()?.currentOrgId);
      } catch (e) {
        setError("Mot de passe incorrect.");
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [finishAuth],
  );

  // Déverrouillage par clé d'accès (PRF). La session verrouillée garde tokens +
  // keyBundle (snapshot) ; il ne manque que la masterKey pour ouvrir le paquet.
  // La passkey régénère le secret PRF → on déchiffre la masterKey stockée.
  const unlockWithPasskey = useCallback(async () => {
    const snap = snapshotRef.current;
    if (!snap) {
      setStatus("anonymous");
      return;
    }
    const rec = getPrfRecord(snap.user.email);
    if (!rec) {
      setError("Aucune clé d'accès enregistrée sur cet appareil.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const evaluated = await evaluatePrf(rec.credentialId, rec.salt, rpIdFromOrigin());
      if (!evaluated) throw new Error("La clé d'accès n'a pas fourni de secret PRF.");
      const masterKey = await unwrapMaster(evaluated.prfOutput, rec.wrapped);
      masterKeyRef.current = masterKey;
      const k = await unlockAccount(snap.keyBundle, masterKey, snap.user);
      await finishAuth(snap.user, k, readPersisted()?.currentOrgId);
    } catch (e) {
      // Annulation / timeout / absence de focus de la cérémonie : pas d'erreur
      // alarmante (le mot de passe reste disponible en repli).
      const name = e instanceof Error ? e.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setError("Déverrouillage par clé d'accès impossible.");
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }, [finishAuth]);

  const enrollPasskeyUnlock = useCallback(async (credentialId: string | null): Promise<boolean> => {
    const mk = masterKeyRef.current;
    const u = user;
    if (!mk || !u) return false;
    const enrolled = await enrollPrf(credentialId, rpIdFromOrigin());
    if (!enrolled) return false; // authentificateur sans PRF
    const wrapped = await wrapMaster(enrolled.prfOutput, mk);
    savePrfRecord({ email: u.email, credentialId: enrolled.credentialId, salt: enrolled.saltHex, wrapped });
    setPrfTick((t) => t + 1);
    return true;
  }, [user]);

  const disablePasskeyUnlock = useCallback(() => {
    if (user) removePrfRecord(user.email);
    else if (lockedEmail) removePrfRecord(lockedEmail);
    setPrfTick((t) => t + 1);
  }, [user, lockedEmail]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best effort */
    }
    localStorage.removeItem(STORAGE_KEY);
    masterKeyRef.current = null;
    snapshotRef.current = null;
    api.setTokens(null);
    setUser(null);
    setKeys(null);
    setOrgs([]);
    setCurrentOrgId(null);
    setRoles([]);
    setLockedEmail(null);
    setStatus("anonymous");
  }, [api]);

  const createOrg = useCallback(
    async (name: string, slug: string) => {
      if (!keys) throw new Error("Session verrouillée.");
      setBusy(true);
      setError(null);
      try {
        // Generate the org recovery keypair; wrap its private key to the creator
        // (first admin). The server never sees the org private key.
        const orgKp = await generateRecipientKeypair();
        const wrappedEnvelope = await encryptForRecipients(fromHex(orgKp.privateHex), [keys.recipient.publicHex]);
        const wrappedOrgPrivate = JSON.parse(new TextDecoder().decode(wrappedEnvelope)) as Record<string, unknown>;
        const { org } = await api.createOrg({ name: name.trim(), slug: slug.trim(), orgPublicHex: orgKp.publicHex, wrappedOrgPrivate });
        await refreshOrgs();
        await selectOrg(org.id);
      } catch (e) {
        setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, keys, refreshOrgs, selectOrg],
  );

  const roleIdByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of roles) m[r.key] = r.id;
    return m;
  }, [roles]);

  const currentOrg = useMemo(() => orgs.find((o) => o.id === currentOrgId) ?? null, [orgs, currentOrgId]);

  // Drapeaux du déverrouillage par clé d'accès (recalculés au tick d'enrôlement).
  const passkeyUnlockAvailable = useMemo(
    () => webauthnSupported() && !!lockedEmail && hasPrfRecord(lockedEmail),
    [lockedEmail, prfTick],
  );
  const passkeyUnlockEnabled = useMemo(
    () => webauthnSupported() && !!user && hasPrfRecord(user.email),
    [user, prfTick],
  );

  const value: DriveSession = {
    status,
    api,
    user,
    keys,
    orgs,
    currentOrg,
    roles,
    roleIdByKey,
    lockedEmail,
    pendingInvite,
    busy,
    error,
    register,
    login,
    loginWithPasskey,
    completeMfa,
    completeMfaWebauthn,
    mfaMethods,
    cancelMfa,
    unlock,
    unlockWithPasskey,
    enrollPasskeyUnlock,
    disablePasskeyUnlock,
    passkeyUnlockAvailable,
    passkeyUnlockEnabled,
    logout,
    refreshOrgs,
    selectOrg,
    createOrg,
    clearError: () => setError(null),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDrive(): DriveSession {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDrive doit être utilisé dans <DriveProvider>.");
  return ctx;
}
