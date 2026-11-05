import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveApi } from "../src/drive-cloud/api";
import type { Tokens } from "../src/drive-cloud/types";

const old: Tokens = { accessToken: "old", refreshToken: "refresh-old", accessTokenExpiresAt: 1 };
const fresh: Tokens = { accessToken: "fresh", refreshToken: "refresh-new", accessTokenExpiresAt: 9999999999 };
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

describe("Drive refresh", () => {
  it("serializes two tabs and reuses the first tab's persisted rotation", async () => {
    let saved: Tokens | null = old;
    let queue = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, fn: () => Promise<boolean>) => {
          const result = queue.then(fn);
          queue = result.then(() => {});
          return result;
        },
      },
    });
    let rotations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: RequestInit) => {
        if (url.endsWith("/auth/refresh")) {
          rotations++;
          expect(JSON.parse(String(opts.body)).refreshToken).toBe(old.refreshToken);
          return reply(200, fresh);
        }
        return (opts.headers as Record<string, string>).authorization === "Bearer fresh"
          ? reply(200, { organizations: [] })
          : reply(401, { error: { code: "unauthorized" } });
      }),
    );
    const client = () =>
      new DriveApi({
        tokens: old,
        readTokens: () => saved,
        onTokens: (t) => {
          saved = t;
        },
      });
    const a = client(),
      b = client();
    await Promise.all([a.listOrgs(), b.listOrgs()]);
    expect(rotations).toBe(1);
    expect(a.getTokens()).toEqual(fresh);
    expect(b.getTokens()).toEqual(fresh);
  });

  it.each([429, 500, 503])("preserves tokens after temporary HTTP %s", async (status) => {
    const onTokens = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/auth/refresh") ? reply(status, {}) : reply(401, { error: { code: "unauthorized" } }),
      ),
    );
    const api = new DriveApi({ tokens: old, onTokens });
    await expect(api.listOrgs()).rejects.toThrow();
    expect(api.getTokens()).toEqual(old);
    expect(onTokens).not.toHaveBeenCalled();
  });

  it("clears tokens on definitive refresh rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(401, { error: { code: "unauthorized" } })),
    );
    const api = new DriveApi({ tokens: old });
    await expect(api.listOrgs()).rejects.toThrow();
    expect(api.getTokens()).toBeNull();
  });

  it("does not restore a logged-out session from an in-flight refresh", async () => {
    let api: DriveApi;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/refresh")) {
          api.setTokens(null);
          return reply(200, fresh);
        }
        return reply(401, { error: { code: "unauthorized" } });
      }),
    );
    api = new DriveApi({ tokens: old });
    await expect(api.listOrgs()).rejects.toThrow();
    expect(api.getTokens()).toBeNull();
  });
});
