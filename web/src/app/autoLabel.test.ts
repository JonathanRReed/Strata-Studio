/**
 * Auto-label overwrite rules: an auto-resolved place name may only land on
 * an empty label or on the previous auto-fill — never on user-typed text —
 * and clearing the field re-arms auto-fill.
 */

import { describe, expect, it } from "bun:test";
import { boundsCenter, centerCacheKey, shouldAutoFill } from "./autoLabel.ts";

describe("shouldAutoFill", () => {
  it("fills an empty label (first generate, nothing typed)", () => {
    expect(shouldAutoFill("", null)).toBe(true);
  });

  it("fills a whitespace-only label", () => {
    expect(shouldAutoFill("   ", null)).toBe(true);
    expect(shouldAutoFill("\t", "Amsterdam")).toBe(true);
  });

  it("replaces the previous auto-fill when the user hasn't touched it", () => {
    expect(shouldAutoFill("Amsterdam", "Amsterdam")).toBe(true);
  });

  it("never overwrites a user-typed label", () => {
    expect(shouldAutoFill("My Honeymoon", null)).toBe(false);
    expect(shouldAutoFill("My Honeymoon", "Amsterdam")).toBe(false);
  });

  it("treats an edited auto-fill as user-typed", () => {
    expect(shouldAutoFill("Amsterdam!", "Amsterdam")).toBe(false);
  });

  it("clearing the field re-enables auto-fill on the next generate", () => {
    // Sequence: auto-filled "Zermatt" → user typed "Alps Trip" (blocked) →
    // user cleared the field → next resolve fills again.
    expect(shouldAutoFill("Zermatt", "Zermatt")).toBe(true);
    expect(shouldAutoFill("Alps Trip", "Zermatt")).toBe(false);
    expect(shouldAutoFill("", "Zermatt")).toBe(true);
  });

  it("a stale lastAutoLabel does not match different user text", () => {
    expect(shouldAutoFill("Venice", "Amsterdam")).toBe(false);
  });
});

describe("boundsCenter / centerCacheKey", () => {
  it("computes the geographic center of bounds", () => {
    expect(boundsCenter({ north: 10, south: 0, east: 30, west: 10 })).toEqual({
      lat: 5,
      lng: 20,
    });
  });

  it("buckets nearby centers onto the same cache key", () => {
    expect(centerCacheKey(52.3701, 4.9002)).toBe(centerCacheKey(52.3699, 4.8998));
  });

  it("separates distinct places", () => {
    expect(centerCacheKey(52.37, 4.9)).not.toBe(centerCacheKey(48.85, 2.35));
  });
});
