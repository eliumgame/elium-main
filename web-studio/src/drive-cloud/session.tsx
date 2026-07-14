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
  /** Complete a login that returned an MFA challenge (TOTP or backup code). */
  completeMfa: (code: string) => Promise<void>;
  /** Abandon a pending MFA challenge and return to the login screen. */
  cancelMfa: () => void;
  unlock: (password: string) => Promise<void>;
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
  // Invite token from the URL (?invite=…) — kept in a ref so finishAuth sees it.
  const inviteRef = useRef<string | null>(null);
  // Pending MFA challenge: the masterKey is already derived (password verified);
  // we hold it in memory ONLY until the second factor completes the login.
  const mfaPendingRef = useRef<{ mfaToken: string; masterKey: Uint8Array; kdfSalt: string; kdfParams: KdfParams } | null>(null);

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
        const { payload, keys: k } = await buildRegistration(email.trim(), password, displayName.trim());
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
      } catch (e) {
        setError(messageOf(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, finishLogin],
  );

  const cancelMfa = useCallback(() => {
    mfaPendingRef.current = null;
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

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best effort */
    }
    localStorage.removeItem(STORAGE_KEY);
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
    completeMfa,
    cancelMfa,
    unlock,
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
