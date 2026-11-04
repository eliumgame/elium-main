/**
 * Confiance au premier usage (key-pins.ts) : un destinataire JAMAIS vu — notamment hérité d'un dossier
 * partagé — lève un avis visible au lieu d'être épinglé en silence ; un partage direct vers une personne
 * jamais épinglée exige la confirmation (annulable) de l'empreinte.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import {
  setKeyPinStorage,
  requireKeyPin,
  requireKeyPinConfirmed,
  keyPinNotices,
  dismissKeyPinNotice,
  isKeyPinned,
  pinKey,
} from "../src/drive-cloud/key-pins";
import { makePrincipalResolver } from "../src/drive-cloud/principal-keys";
import { shareWithUser, addTeamMember, type OpsCtx, type DriveEntry } from "../src/drive-cloud/ops";

beforeEach(() => setKeyPinStorage(null));

describe("avis « nouveau destinataire non vérifié »", () => {
  it("requireKeyPin lève un avis à la première vue, pas aux suivantes", async () => {
    const a = await generateRecipientKeypair();
    requireKeyPin("user", "u1", a.publicHex, "alice@x.fr");
    expect(keyPinNotices().map((n) => n.id)).toEqual(["u1"]);
    dismissKeyPinNotice("user", "u1");
    requireKeyPin("user", "u1", a.publicHex, "alice@x.fr");
    expect(keyPinNotices()).toHaveLength(0);
  });

  it("un destinataire hérité nouveau (résolveur utilisé par le ré-emballage) lève un avis", async () => {
    const team = await generateRecipientKeypair();
    const user = await generateRecipientKeypair();
    const resolver = makePrincipalResolver({
      orgId: "o",
      orgPublicHex: "",
      api: {
        getUser: async () => ({ user: { p256PublicHex: user.publicHex, email: "bob@x.fr" } }),
        listGroups: async () => ({ groups: [{ id: "g1", groupPublicHex: team.publicHex, name: "Compta" }] }),
      },
    } as unknown as OpsCtx);
    expect(await resolver.resolve({ principalType: "user", principalId: "u2" })).toBe(user.publicHex);
    expect(await resolver.resolve({ principalType: "group", principalId: "g1" })).toBe(team.publicHex);
    expect(
      keyPinNotices()
        .map((n) => `${n.kind}:${n.id}`)
        .sort(),
    ).toEqual(["group:g1", "user:u2"]);
  });

  it("un destinataire déjà épinglé ne lève aucun avis, une clé changée reste bloquée", async () => {
    const a = await generateRecipientKeypair();
    const b = await generateRecipientKeypair();
    pinKey("user", "u3", a.publicHex);
    requireKeyPin("user", "u3", a.publicHex);
    expect(keyPinNotices()).toHaveLength(0);
    expect(() => requireKeyPin("user", "u3", b.publicHex)).toThrow(/modifiée/);
  });
});

describe("confirmation d'empreinte avant partage direct / ajout d'équipe", () => {
  it("demande l'empreinte pour une personne jamais épinglée, refuse si annulée, puis accepte et épingle", async () => {
    const a = await generateRecipientKeypair();
    let asked = 0;
    const no = async () => (asked++, false);
    await expect(requireKeyPinConfirmed("user", "u4", a.publicHex, "c@x.fr", no)).rejects.toThrow(/annulé/);
    expect(isKeyPinned("user", "u4")).toBe(false); // l'annulation n'épingle rien : on peut réessayer
    let seen: { words: string; grouped: string } | null = null;
    await requireKeyPinConfirmed("user", "u4", a.publicHex, "c@x.fr", async (fp) => ((seen = fp), true));
    expect(seen!.words.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    expect(isKeyPinned("user", "u4")).toBe(true);
    expect(asked).toBe(1);
    // déjà épinglée : plus de question
    await requireKeyPinConfirmed("user", "u4", a.publicHex, "c@x.fr", no);
    expect(asked).toBe(1);
  });

  it("shareWithUser s'arrête (sans appel réseau) si la confirmation est refusée", async () => {
    const a = await generateRecipientKeypair();
    const calls: string[] = [];
    const ctx = {
      api: new Proxy({}, { get: (_t, p) => () => (calls.push(String(p)), Promise.reject(new Error("réseau"))) }),
    } as unknown as OpsCtx;
    await expect(
      shareWithUser(
        ctx,
        { id: "n" } as DriveEntry,
        { id: "u5", email: "d@x.fr", p256PublicHex: a.publicHex } as never,
        "r",
        async () => false,
      ),
    ).rejects.toThrow(/annulé/);
    expect(calls).toEqual([]);
  });

  it("addTeamMember exige aussi la confirmation pour un nouveau membre jamais épinglé", async () => {
    const group = await generateRecipientKeypair();
    const member = await generateRecipientKeypair();
    const { wrapNodeKeyFor } = await import("../src/drive-cloud/node-crypto");
    const priv = Uint8Array.from(group.privateHex.match(/../g)!.map((h) => parseInt(h, 16)));
    const myKp = await generateRecipientKeypair();
    const wrapped = await wrapNodeKeyFor(priv, myKp.publicHex);
    pinKey("group", "g9", group.publicHex);
    const added: unknown[] = [];
    const ctx = {
      orgId: "o",
      keys: { recipient: myKp },
      api: { addGroupMember: async (...a: unknown[]) => void added.push(a) },
    } as unknown as OpsCtx;
    await expect(
      addTeamMember(
        ctx,
        "g9",
        wrapped,
        { id: "u6", email: "e@x.fr", p256PublicHex: member.publicHex } as never,
        false,
        async () => false,
      ),
    ).rejects.toThrow(/annulé/);
    expect(added).toHaveLength(0);
    await addTeamMember(
      ctx,
      "g9",
      wrapped,
      { id: "u6", email: "e@x.fr", p256PublicHex: member.publicHex } as never,
      false,
      async () => true,
    );
    expect(added).toHaveLength(1);
  });
});
