// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OpsCtx, DriveEntry } from "../src/drive-cloud/ops";
vi.mock("../src/drive-cloud/ops", () => ({ downloadVersion: vi.fn(), triggerDownload: vi.fn() }));
vi.mock("../src/ui/dialogs", () => ({ useDialogs: () => ({ confirm: async () => true }) }));
import VersionsDialog from "../src/drive-cloud/ui/VersionsDialog";
afterEach(cleanup);

function setup(permissions: string[]) {
  const api = {
    listVersions: vi.fn(async () => ({
      versions: [{ id: "v1", versionNo: 1, sizeBytes: 12, createdAt: "2026-01-01" }],
    })),
    getNode: vi.fn(async () => ({ permissions })),
    restoreVersion: vi.fn(async () => {
      throw new Error("Conflit de version");
    }),
  };
  render(
    <VersionsDialog
      ctx={{ api } as unknown as OpsCtx}
      entry={{ id: "n1", name: "Document" } as DriveEntry}
      onClose={() => {}}
    />,
  );
  return api;
}

describe("VersionsDialog", () => {
  it("ne propose pas de restauration à un lecteur", async () => {
    const api = setup(["node.read"]);
    await screen.findByText("v1");
    expect(screen.queryByTitle("Restaurer cette version")).toBeNull();
    expect(api.restoreVersion).not.toHaveBeenCalled();
  });
  it("affiche un échec de restauration et réactive le bouton", async () => {
    setup(["node.version.restore"]);
    const button = await screen.findByTitle("Restaurer cette version");
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe("Conflit de version");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
