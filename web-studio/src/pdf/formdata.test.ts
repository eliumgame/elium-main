import { expect, it } from "vitest";
import { toCsv } from "./ops/formdata";

it("neutralise les formules dans les noms et valeurs exportés en CSV", () => {
  const csv = toCsv([{ name: "=HYPERLINK(\"https://example.test\")", type: "text", value: "+cmd" }]);
  expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")";\'+cmd');
});
