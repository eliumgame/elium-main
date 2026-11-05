/**
 * Déplacement par glisser-déposer (drive-cloud/move.ts) : le serveur supprime les parts HÉRITÉES du
 * sous-arbre déplacé ; le client doit les recréer pour les ayants droit du nouveau parent, y compris
 * lors d'un déplacement à l'intérieur du même dossier partagé — et ne pas en créer pour ceux qui n'ont
 * accès qu'à l'ANCIEN emplacement.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { moveWithKeyShares } from "../src/drive-cloud/move";
import type { OpsCtx, DriveEntry } from "../src/drive-cloud/ops";
import {
  encryptName,
  generateNodeKey,
  unwrapNodeKey,
  wrapNodeKeyFor,
  type WrappedKey,
} from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { setKeyPinStorage } from "../src/drive-cloud/key-pins";

beforeEach(() => setKeyPinStorage(null));

type Row = {
  id: string;
  nodeId: string;
  principalType: "user" | "group" | "org";
  principalId: string;
  roleId: string;
  inheritedFrom: string | null;
  wrappedKey: WrappedKey;
};

describe("moveWithKeyShares", () => {
  it("recrée les parts d'équipe d'un fichier déplacé dans le même dossier partagé", async () => {
    const me = await generateRecipientKeypair();
    const team = await generateRecipientKeypair();
    const other = await generateRecipientKeypair();
    const parents: Record<string, string | null> = {
      projet: null,
      brouillons: "projet",
      final: "projet",
      f: "brouillons",
      c: "f",
    };
    const kinds: Record<string, "folder" | "file"> = {
      projet: "folder",
      brouillons: "folder",
      final: "folder",
      f: "folder",
      c: "file",
    };
    const keys: Record<string, Uint8Array> = Object.fromEntries(
      Object.keys(parents).map((k) => [k, generateNodeKey()]),
    );
    let rows: Row[] = [];
    let n = 0;
    const add = async (
      nodeId: string,
      principalType: Row["principalType"],
      principalId: string,
      pub: string,
      inheritedFrom: string | null,
    ) =>
      rows.push({
        id: `r${n++}`,
        nodeId,
        principalType,
        principalId,
        roleId: "r",
        inheritedFrom,
        wrappedKey: await wrapNodeKeyFor(keys[nodeId]!, pub),
      });
    for (const id of Object.keys(parents)) {
      // Moi : part héritée seulement (je ne suis pas propriétaire) sauf sur projet.
      await add(id, "user", "me", me.publicHex, id === "projet" ? null : "projet");
      await add(id, "group", "team", team.publicHex, id === "projet" ? null : "projet");
    }
    // « brouillons » est AUSSI partagé (profondément) avec « other » : il ne doit pas suivre le déplacement.
    for (const id of ["brouillons", "f", "c"])
      await add(id, "user", "other", other.publicHex, id === "brouillons" ? null : "brouillons");

    const subtree = (root: string): string[] => [
      root,
      ...Object.keys(parents)
        .filter((k) => parents[k] === root)
        .flatMap(subtree),
    ];
    const entry = async (id: string): Promise<DriveEntry> => {
      const mine = rows.find((r) => r.nodeId === id && r.principalId === "me");
      const nm = await encryptName(keys[id]!, id);
      return {
        id,
        parentId: parents[id]!,
        kind: kinds[id]!,
        nameEncrypted: nm.nameEncrypted,
        nameNonce: nm.nameNonce,
        myWrappedKey: mine?.wrappedKey ?? null,
        name: id,
      } as DriveEntry;
    };
    const api = {
      listShares: async (id: string) => ({ shares: rows.filter((r) => r.nodeId === id) }),
      listChildren: async (_org: string, parentId?: string, trashed = false) => ({
        nodes: trashed
          ? []
          : await Promise.all(
              Object.keys(parents)
                .filter((k) => parents[k] === parentId)
                .map(entry),
            ),
      }),
      patchNode: async (id: string, body: { parentId: string | null }) => {
        parents[id] = body.parentId;
        const sub = new Set(subtree(id));
        rows = rows.filter((r) => !(sub.has(r.nodeId) && r.inheritedFrom !== null)); // comportement du serveur
        return { node: {} };
      },
      share: async (nodeId: string, b: Omit<Row, "id" | "nodeId">) => {
        rows = rows.filter((r) => !(r.nodeId === nodeId && r.principalId === b.principalId));
        rows.push({ id: `r${n++}`, nodeId, ...b, inheritedFrom: b.inheritedFrom ?? null });
        return { share: {} };
      },
      getUser: async (id: string) => ({
        user: { id, email: `${id}@x`, p256PublicHex: id === "me" ? me.publicHex : other.publicHex },
      }),
      listGroups: async () => ({ groups: [{ id: "team", groupPublicHex: team.publicHex }] }),
      groupKeys: async () => ({ groups: [{ id: "team", groupPublicHex: team.publicHex }] }),
      myGroups: async () => ({ groups: [] }),
    };
    const ctx = {
      api: api as unknown as OpsCtx["api"],
      keys: { recipient: me, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
      userId: "me",
      orgId: "o",
      orgPublicHex: "",
      roleIdByKey: { editor: "r" },
    } satisfies OpsCtx;

    const stats = await moveWithKeyShares(ctx, await entry("f"), "final");
    expect(stats.failed).toBe(0);
    for (const id of ["f", "c"]) {
      const teamRow = rows.find((r) => r.nodeId === id && r.principalId === "team");
      expect(teamRow, `part équipe sur ${id}`).toBeDefined();
      expect(await unwrapNodeKey(teamRow!.wrappedKey, team)).toEqual(keys[id]);
      expect(teamRow!.inheritedFrom).toBe("projet");
      // Ma propre part héritée est revenue aussi (sinon je perdrais l'accès en déplaçant).
      expect(rows.find((r) => r.nodeId === id && r.principalId === "me")).toBeDefined();
      // « other » n'avait accès que par l'ancien emplacement : rien n'est recréé pour lui.
      expect(rows.find((r) => r.nodeId === id && r.principalId === "other")).toBeUndefined();
    }
  });
});
