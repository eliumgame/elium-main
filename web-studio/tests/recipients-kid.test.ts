import { describe, it, expect } from "vitest";
import {
  generateRecipientKeypair,
  encryptForRecipients,
  decryptAsRecipient,
  decryptWithAnyKey,
  listRecipientKids,
  recipientKid,
  recipientFingerprint,
} from "../src/crypto/recipients";

const te = new TextEncoder();
const td = new TextDecoder();

describe("kid d'enveloppe et clés retirées (rotation)", () => {
  it("chaque destinataire porte un kid = 16 premiers hex de l'empreinte", async () => {
    const a = await generateRecipientKeypair();
    const blob = await encryptForRecipients(te.encode("x"), [a.publicHex]);
    const env = JSON.parse(td.decode(blob));
    expect(env.recipients[0].kid).toBe(recipientKid(await recipientFingerprint(a.publicHex)));
    expect(listRecipientKids(blob)).toEqual([env.recipients[0].kid]);
  });

  it("une enveloppe ANCIENNE sans kid reste lisible (kid déduit de fpr)", async () => {
    const a = await generateRecipientKeypair();
    const blob = await encryptForRecipients(te.encode("x"), [a.publicHex]);
    const env = JSON.parse(td.decode(blob));
    delete env.recipients[0].kid;
    const legacy = te.encode(JSON.stringify(env));
    expect(listRecipientKids(legacy)).toEqual([recipientKid(env.recipients[0].fpr)]);
    expect(td.decode(await decryptAsRecipient(legacy, a))).toBe("x");
  });

  it("après rotation, la clé retirée déchiffre encore l'ancien document", async () => {
    const oldKey = await generateRecipientKeypair();
    const newKey = await generateRecipientKeypair();
    const blob = await encryptForRecipients(te.encode("avant rotation"), [oldKey.publicHex]);
    await expect(decryptAsRecipient(blob, newKey)).rejects.toThrow();
    expect(td.decode(await decryptWithAnyKey(blob, [newKey, oldKey]))).toBe("avant rotation");
    await expect(decryptWithAnyKey(blob, [newKey])).rejects.toThrow();
  });
});
