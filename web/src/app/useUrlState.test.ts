import { afterEach, describe, expect, it } from "bun:test";
import { copyText } from "./useUrlState.ts";

const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
});

describe("copyText", () => {
  it("uses the async clipboard API when available", async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
    });
    expect(await copyText("https://strata.example/share")).toBe(true);
    expect(copied).toEqual(["https://strata.example/share"]);
  });

  it("falls back to a user-gesture selection copy after clipboard denial", async () => {
    let command = "";
    let removed = false;
    const textarea = {
      value: "",
      readOnly: false,
      style: {},
      setAttribute: () => undefined,
      focus: () => undefined,
      select: () => undefined,
      setSelectionRange: () => undefined,
      remove: () => {
        removed = true;
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        activeElement: null,
        createElement: () => textarea,
        body: { appendChild: () => undefined },
        execCommand: (next: string) => {
          command = next;
          return true;
        },
      },
    });

    expect(await copyText("fallback")).toBe(true);
    expect(textarea.value).toBe("fallback");
    expect(command).toBe("copy");
    expect(removed).toBe(true);
  });

  it("returns false when neither copy mechanism exists", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });
    expect(await copyText("unavailable")).toBe(false);
  });
});
