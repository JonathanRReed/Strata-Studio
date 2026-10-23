import { describe, expect, it } from "bun:test";
import { resolveMapMoveCause } from "./mapSelectionCause.ts";

describe("map movement provenance", () => {
  it("keeps both nested fitBounds and outer resize moveends programmatic", () => {
    expect(resolveMapMoveCause("restore")).toBe("restore");
    // The inner event consumes the pending token before resize emits again.
    expect(resolveMapMoveCause(null)).toBe("restore");
  });
  it("preserves explicit navigation causes without a user event", () => {
    for (const cause of ["search", "curated", "restore", "aspect"] as const)
      expect(resolveMapMoveCause(cause)).toBe(cause);
  });
  it("real gestures are manual even after an unconsumed programmatic token", () => {
    for (const pending of [null, "curated", "restore"] as const)
      expect(resolveMapMoveCause(pending, { type: "keydown" })).toBe("manual");
  });
});
