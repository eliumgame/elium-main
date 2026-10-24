import { describe, expect, it, vi } from "vitest";
import { DiskWriteError, friendlyDiskError, tryWriteToHandle, writeToHandle } from "./fs-access";
import type { FsFileHandle } from "../pdf/core/destination";

const refusing = (name: string, message: string): FsFileHandle =>
  ({
    kind: "file",
    name: "doc.elium",
    createWritable: vi.fn().mockRejectedValue(new DOMException(message, name)),
  }) as unknown as FsFileHandle;

describe("écriture sur disque : jamais d'erreur brute", () => {
  it("traduit createWritable refusé en message français", async () => {
    const h = refusing(
      "NotAllowedError",
      "Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed",
    );
    const r = await tryWriteToHandle(h, new Uint8Array([1]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/n'autorise pas/);
      expect(r.message).not.toMatch(/createWritable|Failed to execute/);
    }
  });

  it("writeToHandle lève une DiskWriteError au message lisible", async () => {
    await expect(writeToHandle(refusing("NotFoundError", "gone"), new Uint8Array())).rejects.toBeInstanceOf(
      DiskWriteError,
    );
  });

  it("annule le flux et signale l'échec si l'écriture casse en route", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const h = {
      kind: "file",
      name: "x",
      createWritable: async () => ({
        write: async () => Promise.reject(new DOMException("q", "QuotaExceededError")),
        close: vi.fn(),
        abort,
      }),
    } as unknown as FsFileHandle;
    const r = await tryWriteToHandle(h, new Uint8Array([1]));
    expect(r).toEqual({ ok: false, message: "Espace disque insuffisant pour écrire le fichier." });
    expect(abort).toHaveBeenCalled();
  });

  it("réussit normalement", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const h = { kind: "file", name: "x", createWritable: async () => ({ write, close }) } as unknown as FsFileHandle;
    expect(await tryWriteToHandle(h, new Uint8Array([1]))).toEqual({ ok: true });
    expect(close).toHaveBeenCalled();
  });

  it("message générique pour une erreur inconnue", () => {
    expect(friendlyDiskError(new Error("boom"))).toBe("L'écriture sur le disque a échoué.");
  });
});
