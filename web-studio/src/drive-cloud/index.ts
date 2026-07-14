/**
 * Elium Drive Entreprise — client SDK barrel.
 * Zero-knowledge cloud Drive: accounts, per-node crypto, sharing, RBAC, and
 * end-to-end-encrypted real-time collaboration. All cryptography is client-side.
 */
export * from "./kdf";
export * from "./node-crypto";
export * from "./account";
export * from "./types";
export { DriveApi, ApiError, type ApiOptions } from "./api";
export { EncryptedCollabChannel, type CollabHandlers } from "./collab";
