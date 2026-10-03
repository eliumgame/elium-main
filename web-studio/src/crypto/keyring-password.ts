/**
 * Changement du mot de passe du trousseau : ré-enveloppe le secret maître et
 * chaque clé héritée sous le NOUVEAU mot de passe. Atomique côté données : tout
 * est recalculé en mémoire avant la moindre écriture, donc un mauvais ancien mot
 * de passe ne laisse aucun état intermédiaire. Unifie aussi l'ancien régime
 * « un mot de passe par clé » : toute clé héritée qui s'ouvre avec l'ancien mot
 * de passe passe sous le nouveau ; les autres sont signalées (`skipped`).
 */
import { KeyringError, getMasterRecord, putMasterRecord, unwrapMasterWithPassword, wrapMasterWithPassword } from "./keyring";
import type { KeyEntry, KeyringStore } from "./keyring";
import { decryptPrivateKey, encryptPrivateKey } from "../sign/identity-store";

export async function changeKeyringPassword(
  store: KeyringStore,
  oldPassword: string,
  newPassword: string,
): Promise<{ rewrapped: string[]; skipped: string[]; masterRewrapped: boolean }> {
  if (!newPassword) throw new KeyringError("Le nouveau mot de passe ne peut pas être vide.");
  const entries = await store.getAll();
  const record = await getMasterRecord(store);

  let newWrap: string | undefined;
  if (record?.passwordWrap) {
    let master: Uint8Array;
    try {
      master = await unwrapMasterWithPassword(record.passwordWrap, oldPassword);
    } catch {
      throw new KeyringError("Ancien mot de passe incorrect.");
    }
    newWrap = await wrapMasterWithPassword(master, newPassword);
    master.fill(0);
  }

  const updated: KeyEntry[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.protection !== "password" || !e.enc) continue;
    try {
      const priv = await decryptPrivateKey(e.enc, oldPassword);
      updated.push({ ...e, enc: await encryptPrivateKey(priv, newPassword) });
    } catch {
      skipped.push(e.id);
    }
  }
  if (!newWrap && updated.length === 0) throw new KeyringError("Ancien mot de passe incorrect.");

  for (const e of updated) await store.put(e);
  if (record && newWrap) await putMasterRecord(store, { ...record, passwordWrap: newWrap });
  return { rewrapped: updated.map((e) => e.id), skipped, masterRewrapped: !!newWrap };
}
