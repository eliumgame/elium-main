import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import VerificationBanner from "../src/components/VerificationBanner";
import { createEliumFile } from "../src/format/document";
import type { Studio } from "../src/studio/types";

vi.mock("../src/ui/dialogs", () => ({ useDialogs: () => ({ prompt: vi.fn() }) }));

async function state(): Promise<Studio> {
  const file = await createEliumFile({ profile: "standard" });
  return {
    file,
    integrity: { contentIntact: true, resourcesTampered: [] },
    journalVerdict: null,
    sealVerdict: "unsealed",
    sealPin: null,
    verdicts: {},
    attributions: {},
    sealAttribution: null,
    trustSealKey: vi.fn(),
    trustContact: vi.fn(),
  } as unknown as Studio;
}

describe("verification banner trust states", () => {
  it("shows danger when a known seal disappears, even on a standard profile", async () => {
    const studio = await state();
    studio.sealPin = { status: "missing" };
    const html = renderToStaticMarkup(<VerificationBanner studio={studio} />);
    expect(html).toContain("verify-banner--danger");
    expect(html).toContain("sceau absent");
    expect(html).not.toContain("Vérification : document intègre");
  });

  it("does not describe a first-seen seal as a verified identity", async () => {
    const studio = await state();
    studio.file.manifest.seal = {
      alg: "ed25519",
      publicKeyHex: "aa".repeat(32),
      fingerprint: "bb".repeat(32),
      sealedAt: studio.file.manifest.createdAt,
      signatureHex: "cc".repeat(64),
    };
    studio.sealVerdict = "valid";
    studio.sealPin = { status: "new" };
    const html = renderToStaticMarkup(<VerificationBanner studio={studio} />);
    expect(html).toContain("verify-banner--warning");
    expect(html).toContain("première ouverture");
    expect(html).not.toContain("clé du sceau reconnue");
    expect(html).not.toContain("ouverture précédente");
  });
});
