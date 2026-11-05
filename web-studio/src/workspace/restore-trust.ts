import { fromHex, sha256Hex } from "../format/canonical";

const array = (raw: string | null): Record<string, unknown>[] => {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) : [];
  } catch {
    return [];
  }
};
const key = (v: unknown): v is string => typeof v === "string" && /^(?:[0-9a-f]{64}|04[0-9a-f]{128})$/i.test(v);

/** Imported contacts are hints, never attestations. Existing local decisions always win. */
export async function mergeImportedContacts(local: string | null, imported: string): Promise<string> {
  const contacts = array(local).filter((v) => key(v.publicKeyHex) && typeof v.name === "string");
  const seen = new Set(contacts.map((v) => (v.publicKeyHex as string).toLowerCase()));
  for (const c of array(imported)) {
    if (!key(c.publicKeyHex) || typeof c.name !== "string") continue;
    const publicKeyHex = c.publicKeyHex.toLowerCase();
    if (seen.has(publicKeyHex)) continue;
    contacts.push({
      name: c.name,
      publicKeyHex,
      fingerprint: await sha256Hex(fromHex(publicKeyHex)),
      kind: publicKeyHex.length === 64 ? "signer" : "recipient",
      level: "unverified",
      addedAt: new Date().toISOString(),
      ...(typeof c.notes === "string" ? { notes: c.notes } : {}),
      ...(typeof c.expiresAt === "string" && Number.isFinite(Date.parse(c.expiresAt))
        ? { expiresAt: c.expiresAt }
        : {}),
    });
    seen.add(publicKeyHex);
  }
  return JSON.stringify(contacts);
}

export function mergeImportedRevocations(local: string | null, imported: string): string {
  const valid = (c: Record<string, unknown>) =>
    key(c.publicKeyHex) &&
    typeof c.revokedAt === "string" &&
    Number.isFinite(Date.parse(c.revokedAt)) &&
    ["compromised", "superseded", "other"].includes(c.reason as string);
  const existing = array(local).filter(valid);
  const seen = new Set(existing.map((v) => (v.publicKeyHex as string).toLowerCase()));
  for (const c of array(imported).filter(valid)) {
    const publicKeyHex = (c.publicKeyHex as string).toLowerCase();
    if (!seen.has(publicKeyHex)) {
      existing.push({
        publicKeyHex,
        revokedAt: c.revokedAt,
        reason: c.reason,
        ...(typeof c.note === "string" ? { note: c.note } : {}),
        ...(key(c.successorKeyHex) ? { successorKeyHex: c.successorKeyHex.toLowerCase() } : {}),
      });
      seen.add(publicKeyHex);
    }
  }
  return JSON.stringify(existing);
}
