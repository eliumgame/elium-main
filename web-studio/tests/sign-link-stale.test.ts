/** Signature par lien : un 409 de contenu de base déclenche le rechargement (jamais une re-signature). */
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/drive-cloud/api";
import { isStaleContentError, STALE_SIGN_NOTICE, submitSignedElium } from "../src/drive-cloud/ops";

describe("isStaleContentError", () => {
  it("reconnaît le 409 du serveur uniquement", () => {
    expect(isStaleContentError(new ApiError(409, "conflict", "x"))).toBe(true);
    expect(isStaleContentError(new ApiError(428, "precondition_required", "x"))).toBe(false);
    expect(isStaleContentError(new ApiError(500, "boom", "x"))).toBe(false);
    expect(isStaleContentError(new Error("409"))).toBe(false);
    expect(isStaleContentError(null)).toBe(false);
  });

  it("le message invite à vérifier avant de signer", () => {
    expect(STALE_SIGN_NOTICE).toBe(
      "Le document a été modifié ; la dernière version a été rechargée, vérifiez-la avant de signer.",
    );
  });

  it("submitSignedElium propage l'ApiError 409 telle quelle (le composant décide de recharger)", async () => {
    const err = new ApiError(409, "conflict", "changé");
    const api = {
      submitSignature: async () => {
        throw err;
      },
    };
    await expect(
      submitSignedElium(api as never, "t", new Uint8Array(32), new Uint8Array([1]), undefined, {
        baseVersionId: null,
        keyEpoch: 1,
      }),
    ).rejects.toBe(err);
  });
});
