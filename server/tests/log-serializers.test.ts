import { describe, expect, it } from "vitest";
import { serializeRequestForLog } from "../src/lib/log-serializers.js";

describe("serializeRequestForLog", () => {
  it("retire la query string (jeton du WebSocket collab) de l'URL journalisée", () => {
    const out = serializeRequestForLog({
      method: "GET",
      url: "/api/collab/abc?token=SECRET.JWT.VALUE&x=1",
      host: "h",
      ip: "1.2.3.4",
    });
    expect(out.url).toBe("/api/collab/abc");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.remoteAddress).toBe("1.2.3.4");
  });
  it("tolère une requête sans URL", () => {
    expect(serializeRequestForLog({}).url).toBe("");
  });
});
