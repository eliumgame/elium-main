/** Shared DTO shapes for the cloud Drive client (mirror the server responses). */
import type { KeyBundle, KdfParams } from "./kdf";
import type { WrappedKey } from "./node-crypto";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  ed25519PublicHex: string;
  p256PublicHex: string;
  fingerprint: string;
}

export interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
}

export interface LoginResult extends Tokens {
  user: PublicUser;
  keyBundle: KeyBundle;
}

/** Returned by /login when MFA is enabled: the password passed, prove factor 2. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResponse = LoginResult | MfaChallenge;

export function isMfaChallenge(r: LoginResponse): r is MfaChallenge {
  return (r as MfaChallenge).mfaRequired === true;
}

export interface MfaStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export interface PreloginResult {
  kdfSalt: string;
  kdfParams: KdfParams;
}

export type PrincipalType = "user" | "group" | "org";

export interface KeyShareInput {
  principalType: PrincipalType;
  principalId: string;
  roleId: string;
  wrappedKey: WrappedKey;
  /** Ancestor folder whose deep share fanned this row out (revocation cleanup). */
  inheritedFrom?: string | null;
}

export interface NodeMeta {
  id: string;
  orgId: string;
  parentId: string | null;
  kind: "folder" | "file";
  ownerUserId: string;
  nameEncrypted: string;
  nameNonce: string;
  metaEncrypted: string | null;
  metaNonce: string | null;
  appKind: string | null;
  sizeBytes: number;
  hasContent: boolean;
  contentNonce: string | null;
  trashedAt: string | null;
  /** CEK generation counter — bumped by every key rotation. */
  keyEpoch?: number;
  /** Previous CEK encrypted under the current one (finishes interrupted rotations). */
  prevKeyWrapped?: string | null;
  prevKeyNonce?: string | null;
  createdAt: string;
  modifiedAt: string;
  myWrappedKey?: WrappedKey | null;
}

/** A node as seen through the org recovery lens: its org-wrapped CEK travels
 *  with it so a recovery admin can decrypt the (still-encrypted) name and, on a
 *  grant, recover the CEK. Only holders of the org private key can use it. */
export interface RecoveryNode {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  appKind: string | null;
  nameEncrypted: string;
  nameNonce: string;
  trashed: boolean;
  orgWrappedKey: WrappedKey;
}

/** A member who holds a wrapped copy of the org private key (can recover). */
export interface RecoveryAdmin {
  userId: string;
  email: string;
  displayName: string;
  since: string;
}

export interface VersionInfo {
  id: string;
  versionNo: number;
  sizeBytes: number;
  /** Epoch of the CEK this version's blob is encrypted under. */
  keyEpoch: number;
  createdBy: string | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ShareInfo {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  name: string;
  inheritedFrom: string | null;
}

export interface RoleDef {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  isSystem: boolean;
  permissions: string[];
}

export interface PermissionDef {
  key: string;
  domain: string;
  label: string;
  scope: "node" | "org";
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  roleId?: string;
  roleKey?: string;
}
