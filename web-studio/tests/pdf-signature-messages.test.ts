import { expect, it } from "vitest";
import { signatureRevisionMessage, signaturesSummary } from "../src/pdf/ui/SignaturesPane";
import type { PadesVerification } from "../src/pdf/ops/pades";

const verified = (coversWholeDocument: boolean) =>
  ({
    intact: true,
    valid: true,
    trust: "trusted",
    modifications: "none",
    coversWholeDocument,
  }) as PadesVerification;

it("does not claim no change when a later revision is present", () => {
  expect(signatureRevisionMessage(verified(false))).toContain("révision postérieure");
  expect(signatureRevisionMessage(verified(false))).not.toContain("Aucune modification depuis");
  expect(signaturesSummary([verified(false)]).text).toContain("révisions postérieures");
  expect(signatureRevisionMessage(verified(true))).toBe("Aucune modification depuis la signature.");
});
