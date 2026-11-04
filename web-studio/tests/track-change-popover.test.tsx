// @vitest-environment jsdom
/** TrackChangePopover ne rend jamais un auteur non-chaîne (document non fiable) et ne plante pas. */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import TrackChangePopover from "../src/editor/TrackChangePopover";
import type { TrackChangeRequest } from "../src/editor/TrackChanges";

afterEach(cleanup);
const editor = {} as never;
const req = (over: Record<string, unknown>) =>
  ({ x: 0, y: 0, kind: "insertion", pos: 1, author: "Alice", ts: "", ...over }) as unknown as TrackChangeRequest;

describe("TrackChangePopover", () => {
  it("affiche l'auteur chaîne", () => {
    const { container } = render(<TrackChangePopover editor={editor} request={req({})} onClose={() => {}} />);
    expect(container.querySelector(".trackpop__author")?.textContent).toBe("Alice");
  });
  it("ignore un auteur objet et un type inconnu sans planter", () => {
    const { container } = render(
      <TrackChangePopover editor={editor} request={req({ author: { a: 1 }, kind: "bizarre" })} onClose={() => {}} />,
    );
    expect(container.querySelector(".trackpop__author")).toBeNull();
    expect(container.querySelector(".trackpop__kind")?.textContent).toBe("Modification suivie");
  });
});
