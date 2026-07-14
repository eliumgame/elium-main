/**
 * Account lifecycle (client-side). Registration and login build/consume the
 * zero-knowledge payloads: the server only ever receives public keys, the
 * `authSecret`, the KDF salt/params, and the (opaque) encrypted key bundle.
 */
import { generateIdentity, signMessage, publicKeyHexFromPrivate } from "../sign/keys";
import { generateRecipientKeypair, type RecipientKeypair } from "../crypto/recipients";
import {
  deriveAccountSecrets,
  sealKeyBundle,
  openKeyBundle,
  DEFAULT_KDF_PARAMS,
  type KdfParams,
  type KeyBundle,
} from "./kdf";
import { toHex } from "../format/canonical";

export interface RegistrationPayload {
  email: string;
  displayName: string;
  ed25519PublicHex: string;
  p256PublicHex: string;
  fingerprint: string;
  /** Public key of the password-derived Ed25519 auth key (the login verifier). */
  authSignPublicHex: string;
  /** Signature over the email by the auth key, proving the client holds it. */
  authSignProof: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  keyBundle: KeyBundle;
  bindingProof: string;
}

export interface AccountKeys {
  identity: { privateKeyHex: string; publicKeyHex: string; fingerprint: string };
  recipient: RecipientKeypair;
}

export function bindingMessage(email: string, ed25519PublicHex: string, p256PublicHex: string): string {
  return `${email.toLowerCase()}|${ed25519PublicHex}|${p256PublicHex}`;
}

export interface BuiltRegistration {
  payload: RegistrationPayload;
  keys: AccountKeys;
  masterKey: Uint8Array;
}

/** Build everything the server needs to create a zero-knowledge account, plus
 *  the in-memory keys (so the caller need not re-run the KDF after register). */
export async function buildRegistration(
  email: string,
  password: string,
  displayName = "",
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<BuiltRegistration> {
  const identity = await generateIdentity();
  const recipient = await generateRecipientKeypair();
  const kdfSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const { authSignSeedHex, masterKey } = await deriveAccountSecrets(password, kdfSalt, params);

  // The password-derived Ed25519 auth key: only its PUBLIC key is registered.
  const authSignPublicHex = await publicKeyHexFromPrivate(authSignSeedHex);
  const authSignProof = await signMessage(email.toLowerCase(), authSignSeedHex);

  const keyBundle = await sealKeyBundle(masterKey, {
    ed25519Priv: identity.privateKeyHex!,
    p256Priv: recipient.privateHex,
  });
  const bindingProof = await signMessage(
    bindingMessage(email, identity.publicKeyHex, recipient.publicHex),
    identity.privateKeyHex!,
  );

  const payload: RegistrationPayload = {
    email,
    displayName,
    ed25519PublicHex: identity.publicKeyHex,
    p256PublicHex: recipient.publicHex,
    fingerprint: identity.fingerprint,
    authSignPublicHex,
    authSignProof,
    kdfSalt,
    kdfParams: params,
    keyBundle,
    bindingProof,
  };
  const keys: AccountKeys = {
    identity: { privateKeyHex: identity.privateKeyHex!, publicKeyHex: identity.publicKeyHex, fingerprint: identity.fingerprint },
    recipient,
  };
  return { payload, keys, masterKey };
}

/** Derive the login secrets (auth-sign seed + masterKey to open the bundle). */
export async function prepareLogin(password: string, kdfSalt: string, params: KdfParams) {
  return deriveAccountSecrets(password, kdfSalt, params);
}

/** Sign a server login challenge with the password-derived auth key. */
export async function signLoginChallenge(challenge: string, authSignSeedHex: string): Promise<string> {
  return signMessage(challenge, authSignSeedHex);
}

/** Decrypt the key bundle returned by /login into usable private keys. */
export async function unlockAccount(
  keyBundle: KeyBundle,
  masterKey: Uint8Array,
  publicKeys: { ed25519PublicHex: string; p256PublicHex: string; fingerprint: string },
): Promise<AccountKeys> {
  const secrets = await openKeyBundle(masterKey, keyBundle);
  return {
    identity: {
      privateKeyHex: secrets.ed25519Priv,
      publicKeyHex: publicKeys.ed25519PublicHex,
      fingerprint: publicKeys.fingerprint,
    },
    recipient: { privateHex: secrets.p256Priv, publicHex: publicKeys.p256PublicHex },
  };
}
