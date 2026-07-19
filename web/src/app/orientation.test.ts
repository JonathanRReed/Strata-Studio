import { describe, expect, test } from "bun:test";
import {
  ORIENTATION_DISMISSED_KEY,
  readOrientationDismissed,
  writeOrientationDismissed,
} from "./orientation.ts";

describe("first-session orientation persistence", () => {
  test("stores only the dismissal flag", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readOrientationDismissed(storage)).toBe(false);
    writeOrientationDismissed(storage);
    expect([...values.entries()]).toEqual([[ORIENTATION_DISMISSED_KEY, "1"]]);
    expect(readOrientationDismissed(storage)).toBe(true);
  });

  test("degrades safely when storage access is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readOrientationDismissed(storage)).toBe(false);
    expect(() => writeOrientationDismissed(storage)).not.toThrow();
  });
});
