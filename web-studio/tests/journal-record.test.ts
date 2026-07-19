import { describe, it, expect } from "vitest";
import { createEliumFile, recordSave, recordModification, tracksJournal, type PendingJournalEvent } from "../src/format/document";
import { verifyJournal } from "../src/format/journal";
import { writeEliumPackage, readEliumPackage } from "../src/format/elium-package";
import { verifySeal } from "../src/sign/seal";
import { generateIdentity } from "../src/sign/keys";

describe("Journal — recordSave / recordModification (tracking gate)", () => {
  it("does nothing when tracking is off and no journal exists (standard profile)", async () => {
    const f = await createEliumFile({ title: "Doc", profile: "standard" });
    expect(tracksJournal(f)).toBe(false);
    const after = await recordSave(f, [{ type: "export", at: "2026-07-19T10:00:00Z" }]);
    expect(after.journal.events).toHaveLength(0);
    expect(after).toBe(f); // untouched
  });

  it("flushes queued session events then one document.modified, in order, at save", async () => {
    const f = await createEliumFile({ title: "Rapport", profile: "tracked" });
    expect(tracksJournal(f)).toBe(true);
    const created = f.journal.events.length; // document.created (tracked)
    expect(f.journal.events.at(-1)?.type).toBe("document.created");

    const pending: PendingJournalEvent[] = [
      { type: "document.opened", at: "2026-07-19T09:00:00Z" },
      { type: "export", at: "2026-07-19T09:05:00Z", data: { format: "pdf" } },
      { type: "signature.validated", at: "2026-07-19T09:06:00Z", data: { id: "sig-1" } },
    ];
    const saved = await recordSave(f, pending);
    const types = saved.journal.events.slice(created).map((e) => e.type);
    expect(types).toEqual(["document.opened", "export", "signature.validated", "document.modified"]);
    // Timestamps and data preserved for queued events.
    const exportEv = saved.journal.events.find((e) => e.type === "export");
    expect(exportEv?.at).toBe("2026-07-19T09:05:00Z");
    expect(exportEv?.data).toEqual({ format: "pdf" });
  });

  it("keeps the hash chain valid after a save flush", async () => {
    const f = await createEliumFile({ title: "Doc", profile: "tracked" });
    const saved = await recordSave(f, [{ type: "document.opened", at: "2026-07-19T09:00:00Z" }]);
    const verdict = await verifyJournal(saved.journal);
    expect(verdict.valid).toBe(true);
    expect(verdict.brokenAt).toBeNull();
  });

  it("appends document.modified even with no pending events (one entry per save)", async () => {
    const f = await createEliumFile({ title: "Doc", profile: "tracked" });
    const before = f.journal.events.length;
    const saved = await recordSave(f, []);
    expect(saved.journal.events).toHaveLength(before + 1);
    expect(saved.journal.events.at(-1)?.type).toBe("document.modified");
  });

  it("records into a standard doc that already carries a journal (gate: events.length)", async () => {
    // Simulate a doc whose journal was started elsewhere but whose profile is standard.
    const base = await createEliumFile({ title: "Doc", profile: "tracked" });
    const legacy = { ...base, manifest: { ...base.manifest, profile: "standard" as const } };
    expect(tracksJournal(legacy)).toBe(true); // journal already present → still tracks
    const saved = await recordModification(legacy);
    expect(saved.journal.events.at(-1)?.type).toBe("document.modified");
  });
});

describe("Journal — save flush is covered by the seal (write → read round-trip)", () => {
  it("the seal is valid over the journal AFTER flushing queued events at save", async () => {
    const id = await generateIdentity();
    const f = await createEliumFile({ title: "Contrat", profile: "tracked" });

    // Simulate a session: opened + exported, then save (which appends document.modified).
    const f2 = await recordSave(f, [
      { type: "document.opened", at: "2026-07-19T09:00:00Z" },
      { type: "export", at: "2026-07-19T09:05:00Z", data: { format: "pdf" } },
    ]);

    const bytes = await writeEliumPackage(f2, { sealPrivateKeyHex: id.privateKeyHex! });
    const { file: read } = await readEliumPackage(bytes, {});

    // The persisted journal carries the flushed events…
    expect(read.journal.events.map((e) => e.type)).toEqual([
      "document.created", "document.opened", "export", "document.modified",
    ]);
    // …and the seal verifies over that exact journal (flush happened before sealing).
    const verdict = await verifySeal(read.manifest, read.signatures, read.journal, id.publicKeyHex);
    expect(verdict).toBe("valid");
    expect((await verifyJournal(read.journal)).valid).toBe(true);
  });

  it("tampering with a flushed journal event breaks the seal", async () => {
    const id = await generateIdentity();
    const f = await createEliumFile({ title: "Doc", profile: "tracked" });
    const f2 = await recordSave(f, [{ type: "export", at: "2026-07-19T09:05:00Z", data: { format: "html" } }]);
    const bytes = await writeEliumPackage(f2, { sealPrivateKeyHex: id.privateKeyHex! });
    const { file: read } = await readEliumPackage(bytes, {});

    // Forge the export event's payload after sealing.
    const forged = { ...read, journal: { ...read.journal, events: read.journal.events.map((e) => e.type === "export" ? { ...e, data: { format: "docx" } } : e) } };
    expect(await verifySeal(forged.manifest, forged.signatures, forged.journal, id.publicKeyHex)).toBe("broken");
  });
});
