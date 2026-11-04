import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ParapheurPanel from "../src/panels/ParapheurPanel";
import { createEliumFile } from "../src/format/document";
import { createProof, verifyProof } from "../src/sign/proof";
import { generateIdentity } from "../src/sign/keys";
import type { EliumSignature } from "../src/format/types";
import type { Studio } from "../src/studio/types";

vi.mock("../src/ui/dialogs", () => ({ useDialogs: () => ({ prompt: vi.fn(), alert: vi.fn() }) }));

async function signedState(): Promise<Studio> {
  const file = await createEliumFile({});
  const identity = await generateIdentity();
  const signature: EliumSignature = {
    id: "sig-a",
    kind: "typed",
    signer: { name: "Alice" },
    visual: { text: "Alice" },
    placement: { page: 1, xPct: 0, yPct: 0, wPct: 0.2, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" },
    level: "advanced",
    createdAt: file.manifest.createdAt,
    proof: await createProof({
      signatureId: "sig-a",
      model: file.document,
      signer: { name: "Alice" },
      privateKeyHex: identity.privateKeyHex!,
      docId: file.manifest.docId,
    }),
  };
  file.signatures = [signature];
  file.parapheur = {
    parties: [
      {
        id: "p-a",
        name: "Alice",
        role: "",
        status: "signed",
        signatureId: "sig-a",
        publicKeyHex: identity.publicKeyHex,
      },
    ],
  };
  return {
    file,
    identity: null,
    editable: false,
    attributions: {},
    verdicts: { "sig-a": await verifyProof(signature, file.document, undefined, file.manifest.docId) },
  } as unknown as Studio;
}

describe("Parapheur completion requires verified evidence", () => {
  it("accepts the verified proof of the matching party", async () => {
    const html = renderToStaticMarkup(<ParapheurPanel studio={await signedState()} />);
    expect(html).toContain(">Terminé<");
    expect(html).toContain("Signature valide");
  });

  it.each(["missing", "invalid", "modified", "wrong-name", "wrong-key", "duplicate-proof", "reused-proof"])(
    "does not mark a forged circuit complete: %s",
    async (mutation) => {
      const studio = await signedState();
      const party = studio.file.parapheur!.parties[0];
      if (mutation === "missing") studio.file.signatures = [];
      if (mutation === "invalid" || mutation === "modified") studio.verdicts["sig-a"] = mutation;
      if (mutation === "wrong-name") party.name = "Mallory";
      if (mutation === "wrong-key") party.publicKeyHex = "00".repeat(32);
      if (mutation === "duplicate-proof") studio.file.signatures.push({ ...studio.file.signatures[0] });
      if (mutation === "reused-proof") studio.file.parapheur!.parties.push({ ...party, id: "p-b" });
      const html = renderToStaticMarkup(<ParapheurPanel studio={studio} />);
      expect(html).not.toContain(">Terminé<");
      expect(html).toContain("Signature introuvable / non vérifiée");
      expect(html).not.toContain("sig-tag--valid");
    },
  );
});
