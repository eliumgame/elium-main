// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the Drive session so the panel drives a fake SDK (no backend needed).
const { api } = vi.hoisted(() => ({
  api: {
    serverUrl: "https://drive.example.fr/api",
    getOrgSso: vi.fn(),
    setOrgSso: vi.fn(),
    disableOrgSso: vi.fn(),
    createScimToken: vi.fn(),
  },
}));
vi.mock("../src/drive-cloud/session", () => ({
  useDrive: () => ({ api, currentOrg: { id: "org-1", name: "Acme" } }),
}));

import SsoScimPanel from "../src/drive-cloud/ui/SsoScimPanel";

beforeEach(() => {
  vi.clearAllMocks();
  api.getOrgSso.mockResolvedValue({ sso: null });
  api.setOrgSso.mockResolvedValue({ ok: true });
  api.disableOrgSso.mockResolvedValue({ ok: true });
  api.createScimToken.mockResolvedValue({ token: "scim-secret-xyz" });
});
afterEach(cleanup);

describe("SsoScimPanel (component)", () => {
  it("loads current SSO config on mount and shows the SCIM endpoint", async () => {
    render(<SsoScimPanel />);
    await waitFor(() => expect(api.getOrgSso).toHaveBeenCalledWith("org-1"));
    expect(screen.getByText("https://drive.example.fr/api/scim/v2")).toBeTruthy();
  });

  it("saves a valid SSO configuration (parses JWKS, trims domains)", async () => {
    render(<SsoScimPanel />);
    await userEvent.type(screen.getByPlaceholderText("https://exemple.okta.com"), "https://acme.okta.com");
    await userEvent.type(screen.getByPlaceholderText("0oa…"), "client-42");
    fireEvent.change(screen.getByPlaceholderText(/keys/), { target: { value: '{"keys":[{"kid":"k1"}]}' } });
    await userEvent.type(screen.getByPlaceholderText(/exemple.fr/), "acme.fr, filiale.fr");
    await userEvent.click(screen.getByRole("button", { name: /Enregistrer le SSO/ }));

    await waitFor(() => expect(api.setOrgSso).toHaveBeenCalledTimes(1));
    expect(api.setOrgSso).toHaveBeenCalledWith("org-1", {
      issuer: "https://acme.okta.com",
      clientId: "client-42",
      jwks: [{ kid: "k1" }],
      allowedDomains: ["acme.fr", "filiale.fr"],
    });
    expect(await screen.findByText(/Configuration SSO enregistrée/)).toBeTruthy();
  });

  it("rejects an invalid JWKS without calling the API", async () => {
    render(<SsoScimPanel />);
    await userEvent.type(screen.getByPlaceholderText("https://exemple.okta.com"), "https://acme.okta.com");
    await userEvent.type(screen.getByPlaceholderText("0oa…"), "client-42");
    fireEvent.change(screen.getByPlaceholderText(/keys/), { target: { value: "pas du json" } });
    await userEvent.click(screen.getByRole("button", { name: /Enregistrer le SSO/ }));

    expect(await screen.findByText(/JWKS invalide/)).toBeTruthy();
    expect(api.setOrgSso).not.toHaveBeenCalled();
  });

  it("generates a SCIM token and reveals it", async () => {
    render(<SsoScimPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Générer un jeton SCIM/ }));
    await waitFor(() => expect(api.createScimToken).toHaveBeenCalledWith("org-1"));
    expect(await screen.findByText("scim-secret-xyz")).toBeTruthy();
  });

  it("shows the SSO as active and can disable it when already configured", async () => {
    api.getOrgSso.mockResolvedValue({ sso: { issuer: "https://acme.okta.com", clientId: "c1", allowedDomains: ["acme.fr"] } });
    render(<SsoScimPanel />);
    expect(await screen.findByText("Actif")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Désactiver/ }));
    await waitFor(() => expect(api.disableOrgSso).toHaveBeenCalledWith("org-1"));
    expect(await screen.findByText(/SSO désactivé/)).toBeTruthy();
  });
});
