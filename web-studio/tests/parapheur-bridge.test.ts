/**
 * Pont entre les DEUX circuits de signature (voir DOCUMENTATION §"parapheur") :
 * le circuit local qui voyage dans le `.elium` (`format/document.ts`) et la
 * demande de signature par lien cloud (`drive-cloud/ops.ts`). Le fichier .elium
 * est la source de vérité ; ces tests vérifient que la réconciliation reste
 * strictement client-side et qu'un signataire distant ne peut jamais affecter
 * qu'UNE seule partie du circuit — jamais une autre.
 */
import { describe, it, expect } from "vitest";
import { createEliumFile, addSignature, markPartySigned } from "../src/format/document";
import { writeEliumPackage, readEliumPackage, type WriteOptions } from "../src/format/elium-package";
import { generateIdentity, fingerprintOf } from "../src/sign/keys";
import { createProof, verifyProof } from "../src/sign/proof";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { generateNodeKey, wrapNodeKeyFor, encryptContent, decryptContent } from "../src/drive-cloud/node-crypto";
import {
  loadEliumFile,
  syncCircuitForSignRequest,
  reconcileCircuitForSignRequest,
  type DriveEntry,
  type OpsCtx,
} from "../src/drive-cloud/ops";
import { randomId } from "../src/format/canonical";
import type { EliumFile, EliumSignature } from "../src/format/types";
import type { DriveApi, SignRequestDto } from "../src/drive-cloud/api";

interface FakeBlob {
  ciphertext: Uint8Array;
  nonceHex: string;
}

/** Just enough of `DriveApi` for ops.ts's content read/write path — an
 *  in-memory node-id -> encrypted-blob store standing in for the server,
 *  which only ever needs to move ciphertext around. `extra` overrides/adds
 *  methods (e.g. `getSignRequests` for reconciliation tests, or a flaky
 *  `getContent` for retry tests) without disturbing the base implementation
 *  every other test in this file already relies on. */
function fakeDriveApi(store: Map<string, FakeBlob>, extra: Partial<DriveApi> = {}): DriveApi {
  return {
    async getContent(id: string) {
      const rec = store.get(id);
      if (!rec) throw new Error("not found");
      return { bytes: rec.ciphertext, nonceHex: rec.nonceHex };
    },
    async putContent(id: string, ciphertext: Uint8Array, nonceHex: string) {
      store.set(id, { ciphertext, nonceHex });
      return { node: {} };
    },
    async getSignRequests() {
      return { requests: [] };
    },
    ...extra,
  } as unknown as DriveApi;
}

function makeEntry(over: Partial<DriveEntry> & { id: string }): DriveEntry {
  return {
    orgId: "o1",
    parentId: null,
    kind: "file",
    ownerUserId: "u1",
    name: "doc.elium",
    nameEncrypted: "",
    nameNonce: "",
    metaEncrypted: null,
    metaNonce: null,
    appKind: "elium",
    sizeBytes: 0,
    hasContent: true,
    contentNonce: null,
    trashedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as DriveEntry;
}

/** A ctx + entry pair backed by a real (in-memory) node key, wrapped exactly
 *  as the Drive layer would — so `nodeKeyFrom`/`loadEliumFile` exercise the
 *  real unwrap path, not a shortcut. */
async function makeCtxAndEntry(
  // A function (not a plain object) so overrides can close over the SAME
  // in-memory `store` this helper creates — e.g. a flaky `getContent` that
  // still needs to read whatever `putContent` really wrote.
  apiExtra: (store: Map<string, FakeBlob>) => Partial<DriveApi> = () => ({}),
): Promise<{
  ctx: OpsCtx;
  entry: DriveEntry;
  nodeKey: Uint8Array;
  store: Map<string, FakeBlob>;
}> {
  const recipient = await generateRecipientKeypair();
  const nodeKey = generateNodeKey();
  const myWrappedKey = await wrapNodeKeyFor(nodeKey, recipient.publicHex);
  const store = new Map<string, FakeBlob>();
  const ctx: OpsCtx = {
    api: fakeDriveApi(store, apiExtra(store)),
    keys: { recipient, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
    userId: "u1",
    orgId: "o1",
    orgPublicHex: "",
    roleIdByKey: {},
  };
  const entry = makeEntry({ id: "node-1", myWrappedKey });
  return { ctx, entry, nodeKey, store };
}

async function seed(
  nodeKey: Uint8Array,
  store: Map<string, FakeBlob>,
  id: string,
  file: EliumFile,
  opts: WriteOptions = {},
): Promise<void> {
  const bytes = await writeEliumPackage(file, opts);
  const enc = await encryptContent(nodeKey, bytes);
  store.set(id, { ciphertext: enc.ciphertext, nonceHex: enc.nonceHex });
}

describe("markPartySigned (invariant : ne touche qu'UNE partie)", () => {
  it("met à jour la partie visée sans toucher aux autres", () => {
    const file = {
      parapheur: {
        parties: [
          { id: "a", name: "Alice", role: "", status: "pending" },
          { id: "b", name: "Bob", role: "", status: "pending" },
        ],
      },
    } as unknown as EliumFile;
    const out = markPartySigned(file, "b", { status: "signed", signatureId: "sig-1" });
    expect(out.parapheur!.parties[0]).toEqual(file.parapheur!.parties[0]); // Alice intacte
    expect(out.parapheur!.parties[1]).toMatchObject({ id: "b", status: "signed", signatureId: "sig-1" });
  });

  it("ne fait rien si le document n'a pas de circuit", () => {
    const file = {} as EliumFile;
    expect(markPartySigned(file, "x", { status: "signed" })).toBe(file);
  });

  it("ne fait rien si l'id ne correspond à aucune partie (jamais de forge)", () => {
    const file = {
      parapheur: { parties: [{ id: "a", name: "Alice", role: "", status: "pending" }] },
    } as unknown as EliumFile;
    const out = markPartySigned(file, "does-not-exist", { status: "signed" });
    expect(out).toBe(file);
  });
});

describe("syncCircuitForSignRequest (émetteur) — alignement du circuit embarqué", () => {
  it("crée un circuit « pending » à partir des libellés quand le document n'en a pas encore", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    await seed(nodeKey, store, entry.id, file);

    const loaded = await loadEliumFile(ctx, entry);
    expect(loaded).not.toBeNull();
    expect(loaded!.file.parapheur).toBeUndefined();

    await syncCircuitForSignRequest(ctx, entry, loaded!, [
      { partyId: "p1", label: "Alice" },
      { partyId: "p2", label: "Bob" },
    ]);

    const after = await loadEliumFile(ctx, entry);
    expect(after!.file.parapheur?.parties).toEqual([
      { id: "p1", name: "Alice", role: "", status: "pending" },
      { id: "p2", name: "Bob", role: "", status: "pending" },
    ]);
  });

  it("réaligne les id sans réinitialiser une partie déjà signée quand la taille correspond", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    file.parapheur = {
      parties: [
        {
          id: "old-1",
          name: "Alice",
          role: "RH",
          status: "signed",
          signatureId: "sig-1",
          signedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    await seed(nodeKey, store, entry.id, file);

    const loaded = await loadEliumFile(ctx, entry);
    // Le libellé envoyé au serveur ("Quelqu'un d'autre") est IGNORÉ : le
    // circuit existant est la source de vérité, seul l'id de corrélation change.
    await syncCircuitForSignRequest(ctx, entry, loaded!, [{ partyId: "new-1", label: "Quelqu'un d'autre" }]);

    const after = await loadEliumFile(ctx, entry);
    expect(after!.file.parapheur?.parties).toEqual([
      {
        id: "new-1",
        name: "Alice",
        role: "RH",
        status: "signed",
        signatureId: "sig-1",
        signedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("repart d'un circuit neuf (pending) si le nombre de parties a changé", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    file.parapheur = {
      parties: [
        { id: "old-1", name: "Alice", role: "", status: "signed", signatureId: "sig-1" },
        { id: "old-2", name: "Bob", role: "", status: "pending" },
      ],
    };
    await seed(nodeKey, store, entry.id, file);

    const loaded = await loadEliumFile(ctx, entry);
    await syncCircuitForSignRequest(ctx, entry, loaded!, [{ partyId: "new-1", label: "Carole" }]);

    const after = await loadEliumFile(ctx, entry);
    expect(after!.file.parapheur?.parties).toEqual([{ id: "new-1", name: "Carole", role: "", status: "pending" }]);
  });

  it("préserve un sceau existant lors d'une mise à jour qui ne touche que le circuit", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const identity = await generateIdentity();
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    await seed(nodeKey, store, entry.id, file, { sealPrivateKeyHex: identity.privateKeyHex! });

    const loaded = await loadEliumFile(ctx, entry);
    expect(loaded!.file.manifest.seal).toBeDefined();

    await syncCircuitForSignRequest(ctx, entry, loaded!, [{ partyId: "p1", label: "Alice" }]);

    const rec = store.get(entry.id)!;
    const plaintext = await decryptContent(nodeKey, rec.nonceHex, rec.ciphertext);
    const { file: after, seal } = await readEliumPackage(plaintext);
    expect(after.manifest.seal).toEqual(loaded!.file.manifest.seal);
    // Le sceau n'est pas juste copié : il re-vérifie réellement (rien qu'il
    // couvre — manifeste/signatures/journal — n'a changé, seul le parapheur,
    // délibérément hors sceau, a bougé).
    expect(seal.verdict).toBe("valid");
  });

  it("renvoie null (pas de bridge) pour un document protégé par mot de passe", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const file = await createEliumFile({ title: "Secret", profile: "encrypted" });
    await seed(nodeKey, store, entry.id, file, { password: "pw" });

    const loaded = await loadEliumFile(ctx, entry);
    expect(loaded).toBeNull();
  });
});

describe("bout en bout : signature par lien réconciliée dans le circuit local", () => {
  it("la partie visée obtient une preuve Ed25519 réelle et vérifiable ; l'autre partie reste intacte", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    await seed(nodeKey, store, entry.id, file);

    const loaded0 = await loadEliumFile(ctx, entry);
    await syncCircuitForSignRequest(ctx, entry, loaded0!, [
      { partyId: "p1", label: "Alice" },
      { partyId: "p2", label: "Bob" },
    ]);

    // Simule exactement la séquence de SignLinkView.sign() pour le lien de p1 :
    // identité éphémère, preuve réelle, puis markPartySigned(..., "p1", ...).
    const loaded1 = await loadEliumFile(ctx, entry);
    const id = await generateIdentity();
    const sigId = randomId("sig");
    const signer = { name: "Alice" };
    const placement: EliumSignature["placement"] = {
      page: 1,
      xPct: 0.34,
      yPct: 0.78,
      wPct: 0.3,
      hPct: 0.12,
      rotation: 0,
      z: 0,
      anchorType: "page",
    };
    const visual = { text: "Alice" };
    const proof = await createProof({
      signatureId: sigId,
      model: loaded1!.file.document,
      signer,
      privateKeyHex: id.privateKeyHex!,
      placement,
      visual,
    });
    const sig: EliumSignature = {
      id: sigId,
      kind: "typed",
      visual,
      placement,
      signer,
      proof,
      level: "advanced",
      createdAt: new Date().toISOString(),
    };
    let nf = await addSignature(loaded1!.file, sig);
    nf = markPartySigned(nf, "p1", {
      status: "signed",
      signatureId: sigId,
      publicKeyHex: id.publicKeyHex,
      signedAt: sig.createdAt,
      updatedAt: sig.createdAt,
    });
    const bytes = await writeEliumPackage(nf, { sealPrivateKeyHex: id.privateKeyHex! });
    const enc = await encryptContent(nodeKey, bytes);
    await ctx.api.putContent(entry.id, enc.ciphertext, enc.nonceHex);

    const final = await loadEliumFile(ctx, entry);
    const parties = final!.file.parapheur!.parties;
    const p1 = parties.find((p) => p.id === "p1")!;
    const p2 = parties.find((p) => p.id === "p2")!;
    expect(p1.status).toBe("signed");
    expect(p1.signatureId).toBe(sigId);
    // La partie NON signée par ce lien reste STRICTEMENT intacte.
    expect(p2).toEqual({ id: "p2", name: "Bob", role: "", status: "pending" });

    // La preuve embarquée est réellement vérifiable, pas un simple drapeau.
    const matchingSig = final!.file.signatures.find((s) => s.id === p1.signatureId)!;
    const verdict = await verifyProof(matchingSig, final!.file.document);
    expect(verdict).toBe("valid");
  });
});

/**
 * Le bug concret visé par le durcissement du pont : si l'alignement initial
 * du circuit (syncCircuitForSignRequest, à la création de la demande) échoue
 * — best effort, réseau par ex. — les liens de signature restent malgré tout
 * fonctionnels (ils ne dépendent QUE du token serveur, pas du circuit
 * embarqué). Un signataire peut donc signer via son lien AVANT qu'une
 * resynchronisation n'ait jamais réussi. Sans réconciliation, une
 * (re)construction tardive du circuit (`alignCircuitWithRequest` sans
 * connaître le statut serveur) fabrique alors un « pending » pour une partie
 * qui a DÉJÀ signé — elle reste ainsi bloquée « en attente » dans le panneau
 * Parapheur pour toujours, même si la signature cloud a réellement abouti.
 */
describe("réconciliation : un signataire déjà signé côté serveur n'est jamais laissé « pending »", () => {
  it("syncCircuitForSignRequest reprend le statut « signed » connu du serveur au lieu de fabriquer un « pending »", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry();

    // Alice a déjà signé via son lien : une VRAIE signature Ed25519 est
    // embarquée dans le document, mais SANS passer par markPartySigned (le
    // circuit n'a jamais contenu "p1" — c'est exactement ce qui se produit
    // quand l'alignement initial a échoué avant que quiconque ne clique sur
    // le lien).
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    const id = await generateIdentity();
    const sigId = randomId("sig");
    const signer = { name: "Alice" };
    const placement: EliumSignature["placement"] = {
      page: 1,
      xPct: 0.34,
      yPct: 0.78,
      wPct: 0.3,
      hPct: 0.12,
      rotation: 0,
      z: 0,
      anchorType: "page",
    };
    const visual = { text: "Alice" };
    const proof = await createProof({
      signatureId: sigId,
      model: file.document,
      signer,
      privateKeyHex: id.privateKeyHex!,
      placement,
      visual,
    });
    const sig: EliumSignature = {
      id: sigId,
      kind: "typed",
      visual,
      placement,
      signer,
      proof,
      level: "advanced",
      createdAt: "2026-02-01T10:00:00.000Z",
    };
    const fileWithSig = await addSignature(file, sig);
    expect(fileWithSig.parapheur).toBeUndefined(); // pas de circuit du tout, comme après un échec d'alignement
    await seed(nodeKey, store, entry.id, fileWithSig);

    // Ce que le serveur (source de vérité pour le "Suivi") sait déjà : p1 a
    // signé (même empreinte que la preuve embarquée), p2 est toujours en
    // attente.
    const signerFpr = await fingerprintOf(id.publicKeyHex);
    const requestsDto: SignRequestDto[] = [
      {
        id: "req-1",
        status: "pending",
        ordered: false,
        deadline: null,
        createdAt: "2026-02-01T09:00:00.000Z",
        completedAt: null,
        parties: [
          {
            id: "p1",
            index: 0,
            label: "Alice",
            status: "signed",
            signerFpr,
            signedAt: "2026-02-01T10:00:00.000Z",
            submissionVersionId: "v2",
            linkId: "l1",
          },
          {
            id: "p2",
            index: 1,
            label: "Bob",
            status: "pending",
            signerFpr: null,
            signedAt: null,
            submissionVersionId: null,
            linkId: "l2",
          },
        ],
      },
    ];
    ctx.api = fakeDriveApi(store, { getSignRequests: async () => ({ requests: requestsDto }) });

    // Resynchronisation tardive (ex. relance manuelle depuis le bandeau
    // persistant, ou nouvelle tentative automatique) : reconstruit le
    // circuit à partir de zéro puisqu'il n'existait pas encore.
    const loaded = await loadEliumFile(ctx, entry);
    await syncCircuitForSignRequest(ctx, entry, loaded!, [
      { partyId: "p1", label: "Alice" },
      { partyId: "p2", label: "Bob" },
    ]);

    const after = await loadEliumFile(ctx, entry);
    const parties = after!.file.parapheur!.parties;
    const p1 = parties.find((p) => p.id === "p1")!;
    const p2 = parties.find((p) => p.id === "p2")!;

    // AVANT le correctif : p1.status === "pending" ici (alignCircuitWithRequest
    // ignorait tout statut serveur et repartait toujours de "pending" quand le
    // circuit n'existait pas encore) — alors que la signature cloud a
    // RÉELLEMENT abouti. C'est le bug utilisateur concret visé par la tâche.
    expect(p1.status).toBe("signed");
    expect(p1.signatureId).toBe(sigId);
    expect(p1.publicKeyHex).toBe(id.publicKeyHex);
    // p2 n'a pas signé : reste "pending", sans être affecté par la réconciliation.
    expect(p2.status).toBe("pending");

    // La signature retrouvée est réellement vérifiable, pas un simple drapeau
    // recopié depuis le serveur.
    const matchingSig = after!.file.signatures.find((s) => s.id === p1.signatureId)!;
    expect(await verifyProof(matchingSig, after!.file.document)).toBe("valid");
  });

  it("un échec de lecture du tableau de suivi (réseau) retombe sur le comportement précédent, sans casser l'alignement", async () => {
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry(() => ({
      getSignRequests: async () => {
        throw new Error("panne réseau simulée");
      },
    }));
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    await seed(nodeKey, store, entry.id, file);

    const loaded = await loadEliumFile(ctx, entry);
    await expect(
      syncCircuitForSignRequest(ctx, entry, loaded!, [{ partyId: "p1", label: "Alice" }]),
    ).resolves.toBeUndefined();

    const after = await loadEliumFile(ctx, entry);
    expect(after!.file.parapheur?.parties).toEqual([{ id: "p1", name: "Alice", role: "", status: "pending" }]);
  });
});

/**
 * `reconcileCircuitForSignRequest` (le point d'entrée fiable côté émetteur,
 * appelé par SignRequestDialog) : investigation de ce qui pouvait échouer
 * dans l'ancien code — un accroc réseau transitoire pendant la lecture
 * (`loadEliumFile` avale l'erreur et renvoie juste `null`) faisait échouer le
 * bridge une seule fois, sans la moindre nouvelle tentative, ET sans le
 * moindre avertissement si l'échec se produisait à CE point précis (voir
 * l'ancien SignRequestDialog.createLinks : `if (fresh) await sync(...)` ne
 * déclenchait le message d'erreur que si `sync` lui-même levait — jamais si
 * `loadEliumFile` renvoyait silencieusement `null`).
 */
describe("reconcileCircuitForSignRequest (émetteur, avec tentatives)", () => {
  it("un accroc réseau transitoire (getContent échoue une fois) est absorbé par une nouvelle tentative", async () => {
    let getContentCalls = 0;
    const { ctx, entry, nodeKey, store } = await makeCtxAndEntry((store) => ({
      getContent: async (id: string) => {
        getContentCalls++;
        if (getContentCalls === 1) throw new Error("panne réseau simulée (1 seule fois)");
        const rec = store.get(id)!;
        return { bytes: rec.ciphertext, nonceHex: rec.nonceHex };
      },
    }));
    const file = await createEliumFile({ title: "Contrat", profile: "standard" });
    await seed(nodeKey, store, entry.id, file);

    await reconcileCircuitForSignRequest(ctx, entry, [{ partyId: "p1", label: "Alice" }], {
      attempts: 3,
      delayMs: 0, // pas d'attente réelle dans le test
    });

    expect(getContentCalls).toBeGreaterThanOrEqual(2); // a bien retenté après l'échec

    const after = await loadEliumFile(ctx, entry);
    expect(after!.file.parapheur?.parties).toEqual([{ id: "p1", name: "Alice", role: "", status: "pending" }]);
  });

  it("un échec PERSISTANT n'est jamais avalé silencieusement : la fonction rejette après épuisement des tentatives", async () => {
    const { ctx, entry } = await makeCtxAndEntry(() => ({
      getContent: async () => {
        throw new Error("hors ligne (simulé, en permanence)");
      },
    }));

    await expect(
      reconcileCircuitForSignRequest(ctx, entry, [{ partyId: "p1", label: "Alice" }], { attempts: 2, delayMs: 0 }),
    ).rejects.toThrow();
  });
});
