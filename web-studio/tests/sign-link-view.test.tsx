// @vitest-environment jsdom
/**
 * Bout-en-bout : signer un lien pointant vers un `.elium` protégé par mot de
 * passe (SignLinkView, `web-studio/src/drive-cloud/ui/SignLinkView.tsx`).
 *
 * `tests/sign-link-crypto.test.ts` couvre `openSignLink`/`submitSignedElium`
 * en isolation, et `tests/parapheur-bridge.test.ts` simule la séquence de
 * `sign()` à la main — mais aucun des deux ne fait vraiment tourner le
 * composant. Un bug précis (writeEliumPackage appelé SANS le mot de passe
 * saisi à l'ouverture) ne se voit qu'en exécutant le VRAI flux : ouverture →
 * mot de passe → signature → écriture-retour. Ce test rend le composant, tape
 * le mot de passe, signe, et vérifie que l'artefact réellement posté au
 * serveur mock est le `.elium` signé, toujours protégé par le MÊME mot de
 * passe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createEliumFile } from "../src/format/document";
import { writeEliumPackage, readEliumPackage, EliumPasswordRequired } from "../src/format/elium-package";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { generateNodeKey, wrapNodeKeyFor, encryptName, encryptContent, decryptContent } from "../src/drive-cloud/node-crypto";
import type { NodeMeta } from "../src/drive-cloud/types";

const PASSWORD = "correct-horse-battery-staple";

// `SignLinkView` construit son propre `new DriveApi()` (pas d'injection) : on
// mocke la classe pour intercepter resolveLink/getLinkContent/submitSignature
// sans jamais toucher au réseau, tout en laissant tourner le VRAI code de
// déchiffrement/chiffrement (ops.ts, elium-package.ts, node-crypto.ts).
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    resolveLink: vi.fn(),
    getLinkContent: vi.fn(),
    submitSignature: vi.fn(),
    declineSignature: vi.fn(),
  },
}));
vi.mock("../src/drive-cloud/api", () => ({
  // `new DriveApi()` needs a constructible mock implementation — an arrow
  // function is not a valid constructor target for `Reflect.construct`.
  DriveApi: vi.fn().mockImplementation(function DriveApiMock() {
    return apiMock;
  }),
}));

import SignLinkView from "../src/drive-cloud/ui/SignLinkView";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function seedProtectedLink() {
  // Le lien lui-même (secret du fragment `#k=`) — distinct du mot de passe du
  // document, exactement comme le documente SignLinkView.
  const linkKp = await generateRecipientKeypair();
  const nodeKey = generateNodeKey();
  const wrappedKey = await wrapNodeKeyFor(nodeKey, linkKp.publicHex);
  const nameEnc = await encryptName(nodeKey, "Contrat confidentiel.elium");

  const node: NodeMeta = {
    id: "node-1",
    orgId: "org-1",
    parentId: null,
    kind: "file",
    ownerUserId: "u1",
    nameEncrypted: nameEnc.nameEncrypted,
    nameNonce: nameEnc.nameNonce,
    metaEncrypted: null,
    metaNonce: null,
    appKind: "elium",
    sizeBytes: 0,
    hasContent: true,
    contentNonce: null,
    trashedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };

  // Le `.elium` LUI-MÊME est protégé par mot de passe (profil "encrypted"),
  // indépendamment du secret du lien.
  const file = await createEliumFile({ title: "Contrat confidentiel", profile: "encrypted" });
  const packageBytes = await writeEliumPackage(file, { password: PASSWORD });
  const content = await encryptContent(nodeKey, packageBytes);

  apiMock.resolveLink.mockResolvedValue({ node, wrappedKey, hasPassword: false, roleKey: "signer" });
  apiMock.getLinkContent.mockResolvedValue({ bytes: content.ciphertext, nonceHex: content.nonceHex });
  apiMock.submitSignature.mockResolvedValue({ ok: true });

  window.location.hash = `#k=${linkKp.privateHex}.${linkKp.publicHex}`;
  return { nodeKey };
}

describe("SignLinkView — signature d'un .elium protégé par mot de passe (bout en bout)", () => {
  it("déverrouille avec le mot de passe puis signe et renvoie l'artefact, TOUJOURS protégé par le même mot de passe", async () => {
    const { nodeKey } = await seedProtectedLink();

    render(<SignLinkView token="tok-1" onHome={() => {}} />);

    // Phase "password" : le document est chiffré, distinct du secret du lien.
    expect(await screen.findByText(/Document protégé/i)).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("Mot de passe du document"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: /Déverrouiller/i }));

    // Phase "ready" : le titre déchiffré s'affiche. readEliumPackage() avec mot
    // de passe passe par une dérivation Argon2id (~1,3 s) — laisser large.
    expect(await screen.findByText("Contrat confidentiel", {}, { timeout: 15000 })).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Votre nom"), "Alice");
    await userEvent.click(screen.getByRole("button", { name: /Signer et renvoyer/i }));

    // Avant le correctif, writeEliumPackage() est appelé SANS le mot de passe
    // pour un profil chiffré : il lève EliumPasswordRequired, sign() le
    // rattrape et repasse en phase "ready" avec un message d'erreur — la
    // signature échoue TOUJOURS à cette dernière étape. Avec le correctif,
    // la soumission aboutit et l'écran affiche la confirmation. writeEliumPackage()
    // re-dérive Argon2id à l'écriture : encore ~1,3 s à absorber ici.
    await waitFor(() => expect(apiMock.submitSignature).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(await screen.findByText(/Document signé/i, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.queryByText(/mot de passe est requis/i)).toBeNull();

    // L'artefact réellement posté déchiffre sous la CEK du nœud...
    const [token, ciphertext, nonceHex] = apiMock.submitSignature.mock.calls[0]!;
    expect(token).toBe("tok-1");
    const signedPackageBytes = await decryptContent(nodeKey, nonceHex as string, ciphertext as Uint8Array);

    // ...et reste un .elium chiffré : lire SANS mot de passe échoue toujours...
    await expect(readEliumPackage(signedPackageBytes, {})).rejects.toBeInstanceOf(EliumPasswordRequired);
    // ...mais avec le MÊME mot de passe qu'à l'ouverture, il se lit et porte
    // bien la signature d'Alice — la protection par mot de passe a survécu au
    // aller-retour complet ouverture → signature → écriture.
    const { file: reopened } = await readEliumPackage(signedPackageBytes, { password: PASSWORD });
    expect(reopened.signatures).toHaveLength(1);
    expect(reopened.signatures[0]!.signer.name).toBe("Alice");
  }, 45000);

  it("échoue proprement (sans planter) si le mauvais mot de passe est saisi", async () => {
    await seedProtectedLink();
    render(<SignLinkView token="tok-2" onHome={() => {}} />);

    expect(await screen.findByText(/Document protégé/i)).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("Mot de passe du document"), "mauvais-mot-de-passe");
    await userEvent.click(screen.getByRole("button", { name: /Déverrouiller/i }));

    expect(await screen.findByText(/Mot de passe incorrect/i, {}, { timeout: 15000 })).toBeTruthy();
    expect(apiMock.submitSignature).not.toHaveBeenCalled();
  }, 30000);
});
