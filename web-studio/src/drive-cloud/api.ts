/**
 * Typed client for the Elium Drive Entreprise API. Handles bearer tokens with
 * one automatic refresh on 401, JSON and raw-binary (encrypted blob) transport.
 * All cryptography happens in the caller (see node-crypto.ts / account.ts); this
 * layer only moves ciphertext and metadata.
 */
import type {
  LoginResult,
  LoginResponse,
  MfaStatus,
  PreloginResult,
  Tokens,
  PublicUser,
  NodeMeta,
  RoleDef,
  PermissionDef,
  KeyShareInput,
  PrincipalType,
} from "./types";
import type { RegistrationPayload } from "./account";
import type { WrappedKey } from "./node-crypto";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_BASE_KEY = "elium_drive_api_base";

/**
 * The Drive API base URL. Priority: a runtime override saved by the user
 * (localStorage) → build-time VITE_API_BASE → "/api". The runtime override
 * lets the DESKTOP app (which bundles no backend) point at a deployed Drive
 * server, instead of failing against its own static file server.
 */
export function getConfiguredApiBase(): string {
  try {
    const saved = localStorage.getItem(API_BASE_KEY);
    if (saved) return saved;
  } catch {
    /* no localStorage (SSR / sandbox) */
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_API_BASE ?? "/api";
}

/** Persist a Drive server base URL (empty string clears the override). */
export function setConfiguredApiBase(url: string): void {
  try {
    const clean = url.trim().replace(/\/+$/, "");
    if (clean) localStorage.setItem(API_BASE_KEY, clean);
    else localStorage.removeItem(API_BASE_KEY);
  } catch {
    /* ignore */
  }
}

function defaultBase(): string {
  return getConfiguredApiBase();
}

export interface ApiOptions {
  baseUrl?: string;
  tokens?: Tokens | null;
  onTokens?: (tokens: Tokens | null) => void;
}

type Query = Record<string, string | number | boolean | undefined>;

export class DriveApi {
  private baseUrl: string;
  private tokens: Tokens | null;
  private onTokens?: (t: Tokens | null) => void;
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: ApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? defaultBase()).replace(/\/$/, "");
    this.tokens = opts.tokens ?? null;
    if (opts.onTokens !== undefined) this.onTokens = opts.onTokens;
  }

  setTokens(t: Tokens | null): void {
    this.tokens = t;
    this.onTokens?.(t);
  }
  getTokens(): Tokens | null {
    return this.tokens;
  }

  private url(path: string, query?: Query): string {
    const u = this.baseUrl + path;
    if (!query) return u;
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return qs ? `${u}?${qs}` : u;
  }

  private async parseError(res: Response): Promise<never> {
    let code = "error";
    let message = res.statusText;
    let details: unknown;
    let parsed = false;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (body.error) {
        parsed = true;
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      /* non-JSON error */
    }
    // A non-JSON 4xx/5xx means we did not reach an Elium API (e.g. the desktop
    // app's static file server has no /api). Give an actionable message rather
    // than a cryptic "Not Found".
    if (!parsed && [404, 405, 500, 501, 502, 503].includes(res.status)) {
      code = "server_unreachable";
      message = `Serveur Drive injoignable à « ${this.baseUrl} » (HTTP ${res.status}). Le Drive entreprise nécessite un serveur déployé — vérifiez l'URL du serveur.`;
    }
    throw new ApiError(res.status, code, message, details);
  }

  private authHeaders(): Record<string, string> {
    return this.tokens?.accessToken ? { authorization: `Bearer ${this.tokens.accessToken}` } : {};
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.tokens?.refreshToken) return false;
    if (!this.refreshing) {
      const rt = this.tokens.refreshToken;
      this.refreshing = (async () => {
        try {
          const res = await fetch(this.url("/auth/refresh"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: rt }),
          });
          if (!res.ok) {
            this.setTokens(null);
            return false;
          }
          const t = (await res.json()) as Tokens;
          this.setTokens(t);
          return true;
        } catch {
          return false;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private async json<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query; auth?: boolean; retry?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { ...(auth ? this.authHeaders() : {}) };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      // fetch() rejects on a transport failure (server down, bad URL, CORS).
      throw new ApiError(
        0,
        "server_unreachable",
        `Serveur Drive injoignable à « ${this.baseUrl} ». Vérifiez l'URL du serveur Drive et votre connexion.`,
      );
    }
    if (res.status === 401 && auth && opts.retry !== false && (await this.tryRefresh())) {
      return this.json<T>(method, path, { ...opts, retry: false });
    }
    if (!res.ok) return this.parseError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // === Auth ================================================================
  register(payload: RegistrationPayload) {
    return this.json<LoginResult>("POST", "/auth/register", { body: payload, auth: false });
  }
  prelogin(email: string) {
    return this.json<PreloginResult>("POST", "/auth/prelogin", { body: { email }, auth: false });
  }
  /** Oracle-free login step 1: obtain a random challenge to sign. */
  loginInit(email: string) {
    return this.json<{ challengeId: string; challenge: string }>("POST", "/auth/login/init", { body: { email }, auth: false });
  }
  /** Step 2: submit the signature over the challenge (may return an MFA challenge). */
  loginVerify(email: string, challengeId: string, signature: string) {
    return this.json<LoginResponse>("POST", "/auth/login/verify", { body: { email, challengeId, signature }, auth: false });
  }
  /** Third step when MFA is enabled: prove the TOTP / backup code. */
  loginMfa(mfaToken: string, code: string) {
    return this.json<LoginResult>("POST", "/auth/login/mfa", { body: { mfaToken, code }, auth: false });
  }
  // === MFA management (authenticated) ======================================
  mfaStatus() {
    return this.json<MfaStatus>("GET", "/auth/mfa/status");
  }
  mfaSetup() {
    return this.json<{ secret: string; otpauthUri: string }>("POST", "/auth/mfa/setup", { body: {} });
  }
  mfaEnable(code: string) {
    return this.json<{ enabled: boolean; backupCodes: string[] }>("POST", "/auth/mfa/enable", { body: { code } });
  }
  mfaDisable(code: string) {
    return this.json<{ enabled: boolean }>("POST", "/auth/mfa/disable", { body: { code } });
  }
  mfaRegenerateBackupCodes(code: string) {
    return this.json<{ backupCodes: string[] }>("POST", "/auth/mfa/backup-codes", { body: { code } });
  }
  logout() {
    return this.json<{ ok: boolean }>("POST", "/auth/logout", {
      body: { refreshToken: this.tokens?.refreshToken },
      auth: false,
    });
  }
  me() {
    return this.json<{ user: PublicUser; organizations: unknown[] }>("GET", "/auth/me");
  }

  // === Users ===============================================================
  lookupUser(by: { email?: string; fingerprint?: string }) {
    return this.json<{ user: PublicUser }>("GET", "/users/lookup", { query: by });
  }
  getUser(id: string) {
    return this.json<{ user: PublicUser }>("GET", `/users/${id}`);
  }
  updateMe(patch: Record<string, unknown>) {
    return this.json<{ user: PublicUser }>("PATCH", "/users/me", { body: patch });
  }
  listSessions() {
    return this.json<{ sessions: unknown[] }>("GET", "/users/me/sessions");
  }
  revokeSession(id: string) {
    return this.json<{ ok: boolean }>("DELETE", `/users/me/sessions/${id}`);
  }

  // === Organizations =======================================================
  createOrg(body: { name: string; slug: string; orgPublicHex: string; wrappedOrgPrivate: WrappedKey }) {
    return this.json<{ org: { id: string; name: string; slug: string; orgPublicHex: string }; roles: RoleDef[] }>(
      "POST",
      "/orgs",
      { body },
    );
  }
  listOrgs() {
    return this.json<{ organizations: unknown[] }>("GET", "/orgs");
  }
  getOrg(orgId: string) {
    return this.json<{ org: unknown; role: unknown }>("GET", `/orgs/${orgId}`);
  }
  listMembers(orgId: string) {
    return this.json<{ members: unknown[] }>("GET", `/orgs/${orgId}/members`);
  }
  invite(orgId: string, body: { email: string; roleId: string }) {
    return this.json<{ token: string; expiresAt: string }>("POST", `/orgs/${orgId}/invites`, { body });
  }
  acceptInvite(token: string) {
    return this.json<{ orgId: string; roleId: string }>("POST", "/orgs/invites/accept", { body: { token } });
  }
  setMemberRole(orgId: string, userId: string, roleId: string) {
    return this.json<{ ok: boolean }>("PATCH", `/orgs/${orgId}/members/${userId}`, { body: { roleId } });
  }
  removeMember(orgId: string, userId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/orgs/${orgId}/members/${userId}`);
  }
  getRecoveryKey(orgId: string) {
    return this.json<{ wrappedOrgPrivate: WrappedKey }>("GET", `/orgs/${orgId}/recovery-key`);
  }
  getOrgUsage(orgId: string) {
    return this.json<{ usedBytes: number; quotaBytes: number | null; versionCount: number }>("GET", `/orgs/${orgId}/usage`);
  }
  // === SSO (OIDC) + SCIM ====================================================
  /** Sign in via an OIDC id_token obtained from the org's IdP (identity only;
   *  the returned key bundle is still unlocked client-side with the passphrase). */
  ssoVerify(orgId: string, idToken: string) {
    return this.json<LoginResult>("POST", "/auth/sso/verify", { body: { orgId, idToken }, auth: false });
  }
  setOrgSso(orgId: string, config: { issuer: string; clientId: string; jwks: unknown[]; allowedDomains?: string[] }) {
    return this.json<{ ok: boolean }>("PUT", `/orgs/${orgId}/sso`, { body: config });
  }
  getOrgSso(orgId: string) {
    return this.json<{ sso: unknown | null }>("GET", `/orgs/${orgId}/sso`);
  }
  disableOrgSso(orgId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/orgs/${orgId}/sso`);
  }
  createScimToken(orgId: string) {
    return this.json<{ token: string }>("POST", `/orgs/${orgId}/scim-token`, { body: {} });
  }
  setOrgQuota(orgId: string, quotaBytes: number | null) {
    return this.json<{ quotaBytes: number | null }>("PATCH", `/orgs/${orgId}/quota`, { body: { quotaBytes } });
  }
  addRecoveryAdmin(orgId: string, body: { adminUserId: string; wrappedOrgPrivate: WrappedKey }) {
    return this.json<{ ok: boolean }>("POST", `/orgs/${orgId}/recovery/admins`, { body });
  }
  recoveryGrant(orgId: string, body: { nodeId: string; targetUserId: string; roleId: string; wrappedKey: WrappedKey }) {
    return this.json<{ ok: boolean }>("POST", `/orgs/${orgId}/recovery/grant`, { body });
  }

  // === Roles ===============================================================
  permissionCatalog() {
    return this.json<{ permissions: PermissionDef[] } | PermissionDef[]>("GET", "/orgs/permission-catalog");
  }
  listRoles(orgId: string) {
    return this.json<{ roles: RoleDef[] }>("GET", `/orgs/${orgId}/roles`);
  }
  createRole(orgId: string, body: { name: string; description?: string; color?: string; permissions: string[] }) {
    return this.json<{ role: RoleDef }>("POST", `/orgs/${orgId}/roles`, { body });
  }
  updateRole(orgId: string, roleId: string, body: Partial<{ name: string; description: string; color: string; permissions: string[] }>) {
    return this.json<{ role: RoleDef }>("PATCH", `/orgs/${orgId}/roles/${roleId}`, { body });
  }
  cloneRole(orgId: string, roleId: string) {
    return this.json<{ role: RoleDef }>("POST", `/orgs/${orgId}/roles/${roleId}/clone`, { body: {} });
  }
  deleteRole(orgId: string, roleId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/orgs/${orgId}/roles/${roleId}`);
  }

  // === Groups ==============================================================
  listGroups(orgId: string) {
    return this.json<{ groups: unknown[] }>("GET", `/orgs/${orgId}/groups`);
  }
  createGroup(
    orgId: string,
    body: {
      name: string;
      description?: string;
      color?: string;
      groupPublicHex: string;
      members: { userId: string; wrappedGroupPrivate: WrappedKey; isManager?: boolean }[];
    },
  ) {
    return this.json<{ group: unknown }>("POST", `/orgs/${orgId}/groups`, { body });
  }
  getGroup(orgId: string, groupId: string) {
    return this.json<{ group: unknown; members: unknown[]; myWrappedGroupPrivate: WrappedKey | null }>(
      "GET",
      `/orgs/${orgId}/groups/${groupId}`,
    );
  }
  addGroupMember(orgId: string, groupId: string, body: { userId: string; wrappedGroupPrivate: WrappedKey; isManager?: boolean }) {
    return this.json<{ ok: boolean }>("POST", `/orgs/${orgId}/groups/${groupId}/members`, { body });
  }
  removeGroupMember(orgId: string, groupId: string, userId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/orgs/${orgId}/groups/${groupId}/members/${userId}`);
  }
  deleteGroup(orgId: string, groupId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/orgs/${orgId}/groups/${groupId}`);
  }

  // === Nodes (tree) ========================================================
  createNode(body: {
    orgId: string;
    parentId: string | null;
    kind: "folder" | "file";
    nameEncrypted: string;
    nameNonce: string;
    metaEncrypted?: string;
    metaNonce?: string;
    appKind?: string;
    keyShares: KeyShareInput[];
  }) {
    return this.json<{ node: NodeMeta }>("POST", "/nodes", { body });
  }
  getNode(id: string) {
    return this.json<{ node: NodeMeta; myWrappedKey: WrappedKey | null; permissions: string[] }>("GET", `/nodes/${id}`);
  }
  listChildren(orgId: string, parentId?: string, trashed = false) {
    return this.json<{ nodes: NodeMeta[] }>("GET", "/nodes", { query: { orgId, parentId, trashed } });
  }
  listTrash(orgId: string) {
    return this.json<{ nodes: NodeMeta[] }>("GET", "/nodes/trash", { query: { orgId } });
  }
  purgeNode(id: string) {
    return this.json<{ ok: boolean }>("DELETE", `/nodes/${id}/purge`);
  }
  patchNode(
    id: string,
    body: Partial<{ nameEncrypted: string; nameNonce: string; metaEncrypted: string; metaNonce: string; parentId: string | null }>,
  ) {
    return this.json<{ node: NodeMeta }>("PATCH", `/nodes/${id}`, { body });
  }
  trashNode(id: string) {
    return this.json<{ ok: boolean }>("DELETE", `/nodes/${id}`);
  }
  restoreNode(id: string) {
    return this.json<{ ok: boolean }>("POST", `/nodes/${id}/restore`, { body: {} });
  }

  async putContent(id: string, ciphertext: Uint8Array, nonceHex: string, keyEpoch?: number): Promise<{ node: NodeMeta }> {
    const doFetch = () =>
      fetch(this.url(`/nodes/${id}/content`), {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": "application/octet-stream",
          "x-content-nonce": nonceHex,
          ...(keyEpoch !== undefined ? { "x-key-epoch": String(keyEpoch) } : {}),
        },
        body: ciphertext as unknown as BodyInit,
      });
    let res = await doFetch();
    if (res.status === 401 && (await this.tryRefresh())) res = await doFetch();
    if (!res.ok) return this.parseError(res);
    return (await res.json()) as { node: NodeMeta };
  }

  async getContent(id: string): Promise<{ bytes: Uint8Array; nonceHex: string }> {
    const doFetch = () => fetch(this.url(`/nodes/${id}/content`), { headers: this.authHeaders() });
    let res = await doFetch();
    if (res.status === 401 && (await this.tryRefresh())) res = await doFetch();
    if (!res.ok) return this.parseError(res);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, nonceHex: res.headers.get("x-content-nonce") ?? "" };
  }

  // === Shares & links ======================================================
  listShares(nodeId: string) {
    return this.json<{ shares: unknown[] }>("GET", `/nodes/${nodeId}/shares`);
  }
  share(
    nodeId: string,
    body: { principalType: PrincipalType; principalId: string; roleId: string; wrappedKey: WrappedKey; inheritedFrom?: string | null },
  ) {
    return this.json<{ share: unknown }>("POST", `/nodes/${nodeId}/shares`, { body });
  }
  updateShare(nodeId: string, shareId: string, roleId: string) {
    return this.json<{ ok: boolean }>("PATCH", `/nodes/${nodeId}/shares/${shareId}`, { body: { roleId } });
  }
  /** `deep` (folders): also removes the principal's inherited rows on the subtree. */
  revokeShare(nodeId: string, shareId: string, deep = false) {
    return this.json<{ ok: boolean }>("DELETE", `/nodes/${nodeId}/shares/${shareId}`, { query: { deep } });
  }
  /**
   * Key rotation: submit name/meta re-encrypted under a fresh CEK plus the
   * complete new crypto-ACL. Bumps the node's key epoch and revokes its links.
   */
  rotateNode(
    nodeId: string,
    body: {
      nameEncrypted: string;
      nameNonce: string;
      metaEncrypted?: string;
      metaNonce?: string;
      /** Old CEK encrypted under the new one (crash-resilient rotation). */
      prevKeyWrapped?: string;
      prevKeyNonce?: string;
      expectedEpoch?: number;
      keyShares: KeyShareInput[];
    },
  ) {
    return this.json<{ node: NodeMeta; revokedLinks: number }>("POST", `/nodes/${nodeId}/rotate`, { body });
  }
  /** Re-encrypt one version's blob in place (rotation follow-up). */
  async putVersionContent(nodeId: string, versionId: string, ciphertext: Uint8Array, nonceHex: string): Promise<void> {
    const doFetch = () =>
      fetch(this.url(`/nodes/${nodeId}/versions/${versionId}/content`), {
        method: "PUT",
        headers: { ...this.authHeaders(), "content-type": "application/octet-stream", "x-content-nonce": nonceHex },
        body: ciphertext as unknown as BodyInit,
      });
    let res = await doFetch();
    if (res.status === 401 && (await this.tryRefresh())) res = await doFetch();
    if (!res.ok) return this.parseError(res);
  }
  /** Replace a node's collab update log with one snapshot (rotation follow-up). */
  compactCollab(nodeId: string, ciphertextHex: string, nonceHex: string) {
    return this.json<{ seq: number }>("POST", `/collab/${nodeId}/compact`, {
      body: { ciphertext: ciphertextHex, nonce: nonceHex },
    });
  }
  createLink(
    nodeId: string,
    body: { roleId: string; wrappedKey: WrappedKey; hasPassword?: boolean; expiresAt?: string; maxDownloads?: number },
  ) {
    return this.json<{ token: string; linkId: string }>("POST", `/nodes/${nodeId}/links`, { body });
  }
  listLinks(nodeId: string) {
    return this.json<{ links: unknown[] }>("GET", `/nodes/${nodeId}/links`);
  }
  revokeLink(nodeId: string, linkId: string) {
    return this.json<{ ok: boolean }>("DELETE", `/nodes/${nodeId}/links/${linkId}`);
  }
  resolveLink(token: string) {
    return this.json<{ node: NodeMeta; wrappedKey: WrappedKey; hasPassword: boolean; roleKey: string }>(
      "GET",
      `/links/${token}`,
      { auth: false },
    );
  }
  async getLinkContent(token: string): Promise<{ bytes: Uint8Array; nonceHex: string }> {
    const res = await fetch(this.url(`/links/${token}/content`));
    if (!res.ok) return this.parseError(res);
    return { bytes: new Uint8Array(await res.arrayBuffer()), nonceHex: res.headers.get("x-content-nonce") ?? "" };
  }

  // === Versions ============================================================
  listVersions(nodeId: string) {
    return this.json<{ versions: unknown[] }>("GET", `/nodes/${nodeId}/versions`);
  }
  async getVersionContent(nodeId: string, versionId: string): Promise<{ bytes: Uint8Array; nonceHex: string }> {
    const doFetch = () => fetch(this.url(`/nodes/${nodeId}/versions/${versionId}/content`), { headers: this.authHeaders() });
    let res = await doFetch();
    if (res.status === 401 && (await this.tryRefresh())) res = await doFetch();
    if (!res.ok) return this.parseError(res);
    return { bytes: new Uint8Array(await res.arrayBuffer()), nonceHex: res.headers.get("x-content-nonce") ?? "" };
  }
  restoreVersion(nodeId: string, versionId: string) {
    return this.json<{ node: NodeMeta }>("POST", `/nodes/${nodeId}/versions/${versionId}/restore`, { body: {} });
  }

  // === Audit ===============================================================
  listAudit(orgId: string, query: { limit?: number; beforeId?: number } = {}) {
    return this.json<{ entries: unknown[]; nextBeforeId: number | null }>("GET", `/orgs/${orgId}/audit`, { query });
  }

  // === Collaboration =======================================================
  getCollabUpdates(nodeId: string, since = 0) {
    return this.json<{ updates: { seq: number; ciphertext: string; nonce: string; author: string | null; createdAt: string }[] }>(
      "GET",
      `/collab/${nodeId}/updates`,
      { query: { since } },
    );
  }
  /** WebSocket URL for the encrypted collaboration room. */
  collabSocketUrl(nodeId: string): string {
    const base = this.baseUrl.startsWith("http")
      ? this.baseUrl.replace(/^http/, "ws")
      : `${location.origin.replace(/^http/, "ws")}${this.baseUrl}`;
    const token = encodeURIComponent(this.tokens?.accessToken ?? "");
    return `${base}/collab/${nodeId}?token=${token}`;
  }
}
