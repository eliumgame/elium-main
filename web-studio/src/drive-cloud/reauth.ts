/**
 * Ré-authentification : prouve, à l'instant, la connaissance du mot de passe (défi signé par la
 * clé d'authentification dérivée) et, si la 2FA est active, un code valide. Renvoie un jeton
 * de 5 minutes à joindre (`x-reauth-token`) aux opérations sensibles : passkeys, SSO/SCIM.
 */
import type { DriveApi } from "./api";
import { prepareLogin, signLoginChallenge } from "./account";
import type { KdfParams } from "./kdf";

export async function reauthenticate(api: DriveApi, email: string, password: string, code?: string): Promise<string> {
  const pre = await api.prelogin(email);
  const { authSignSeedHex } = await prepareLogin(password, pre.kdfSalt, pre.kdfParams as KdfParams);
  const { challengeId, challenge } = await api.loginInit(email);
  const signature = await signLoginChallenge(challenge, authSignSeedHex);
  return (await api.reauth({ challengeId, signature, ...(code ? { code } : {}) })).reauthToken;
}
