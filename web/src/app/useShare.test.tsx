import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create } from "react-test-renderer";
import { useShare, resolveNativeShareMode } from "./useShare.ts";
import { SHARE_LONG_EDGE } from "./shareSpec.ts";
import { buildCapabilityMatrix, type CapabilityProbe } from "./capabilities.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalNavigator = globalThis.navigator;
const originalWindow = globalThis.window;

function capabilities(overrides: Partial<CapabilityProbe> = {}) {
  return buildCapabilityMatrix({
    dialog: true,
    inert: true,
    createImageBitmap: true,
    canvasToBlob: true,
    captureStream: true,
    requestFrame: true,
    mediaRecorder: true,
    supportedMediaRecorderTypes: ["video/webm"],
    nativeShare: true,
    fileShare: true,
    clipboard: true,
    webgl: true,
    ...overrides,
  });
}

type Hook = ReturnType<typeof useShare>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function Probe({
  matrix,
  createSharePng,
  fallback,
  expose,
}: {
  matrix: ReturnType<typeof capabilities>;
  createSharePng: Parameters<typeof useShare>[0]["createSharePng"];
  fallback: () => boolean | Promise<boolean>;
  expose: (hook: Hook) => void;
}) {
  const hook = useShare({
    styleId: "ridge",
    seed: "share",
    label: "Yosemite",
    capabilities: matrix,
    createSharePng,
    onFallbackCopy: fallback,
  });
  expose(hook);
  return null;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://strata.example/?composition=x" } },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("native sharing", () => {
  it("chooses copy, URL, and file modes from the capability matrix", () => {
    expect(resolveNativeShareMode(capabilities({ nativeShare: false }))).toBe("copy");
    expect(resolveNativeShareMode(capabilities({ fileShare: false }))).toBe("url");
    expect(resolveNativeShareMode(capabilities())).toBe("file");
  });

  it("uses URL-only native sharing without rendering when file sharing is unsupported", async () => {
    const shares: ShareData[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { share: async (data: ShareData) => void shares.push(data) },
    });
    let rendered = 0;
    let hook: Hook | null = null;
    await act(async () => {
      create(
        <Probe
          matrix={capabilities({ fileShare: false })}
          createSharePng={async () => {
            rendered++;
            throw new Error("should not render");
          }}
          fallback={() => true}
          expose={(value) => {
            hook = value;
          }}
        />,
      );
    });
    await act(async () => {
      await hook!.share();
    });
    expect(rendered).toBe(0);
    expect(shares).toEqual([
      {
        title: "Strata Studio: Yosemite",
        url: "https://strata.example/?composition=x",
      },
    ]);
  });

  it("shares the standard 1024-long-edge attributed file when supported", async () => {
    const shares: ShareData[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        canShare: ({ files }: ShareData) => Boolean(files?.length),
        share: async (data: ShareData) => void shares.push(data),
      },
    });
    let hook: Hook | null = null;
    await act(async () => {
      create(
        <Probe
          matrix={capabilities()}
          createSharePng={async () => ({
            blob: new Blob(["attributed"], { type: "image/png" }),
            filename: "engine-name.png",
            width: SHARE_LONG_EDGE,
            height: 576,
          })}
          fallback={() => true}
          expose={(value) => {
            hook = value;
          }}
        />,
      );
    });
    await act(async () => {
      await hook!.share();
    });
    const file = shares[0].files?.[0];
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe("strata-ridge-share-1024x576.png");
    expect(Math.max(SHARE_LONG_EDGE, 576)).toBe(1024);
    expect(shares[0].url).toBe("https://strata.example/?composition=x");
  });

  it("ignores a superseded native-share completion", async () => {
    const pending: ReturnType<typeof deferred<void>>[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        share: () => {
          const next = deferred<void>();
          pending.push(next);
          return next.promise;
        },
      },
    });
    let hook: Hook | null = null;
    await act(async () => {
      create(
        <Probe
          matrix={capabilities({ fileShare: false })}
          createSharePng={async () => {
            throw new Error("unused");
          }}
          fallback={() => true}
          expose={(value) => {
            hook = value;
          }}
        />,
      );
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = hook!.share();
      await Promise.resolve();
      second = hook!.share();
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1].resolve();
      await second;
    });
    await act(async () => {
      pending[0].reject(new DOMException("late cancellation", "AbortError"));
      await first;
    });
    expect(hook!.shareStatus.phase).toBe("idle");
  });

  it("cancels immediately while a fallback clipboard write is pending", async () => {
    const copy = deferred<boolean>();
    let hook: Hook | null = null;
    await act(async () => {
      create(
        <Probe
          matrix={capabilities({ nativeShare: false })}
          createSharePng={async () => {
            throw new Error("unused");
          }}
          fallback={() => copy.promise}
          expose={(value) => {
            hook = value;
          }}
        />,
      );
    });

    let sharing!: Promise<void>;
    await act(async () => {
      sharing = hook!.share();
      await Promise.resolve();
    });
    expect(hook!.shareStatus.phase).toBe("sharing");
    act(() => hook!.cancelShare());
    expect(hook!.shareStatus.phase).toBe("cancelled");

    await act(async () => {
      copy.resolve(false);
      await sharing;
    });
    expect(hook!.shareStatus.phase).toBe("cancelled");
  });

  it("copies the URL after non-cancel share failures but not user cancellations", async () => {
    let copies = 0;
    let hook: Hook | null = null;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { share: async () => Promise.reject(new Error("share failed")) },
    });
    await act(async () => {
      create(
        <Probe
          matrix={capabilities({ fileShare: false })}
          createSharePng={async () => {
            throw new Error("unused");
          }}
          fallback={() => {
            copies++;
            return true;
          }}
          expose={(value) => {
            hook = value;
          }}
        />,
      );
    });
    await act(async () => {
      await hook!.share();
    });
    expect(copies).toBe(1);
    expect(hook!.shareStatus.phase).toBe("idle");

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        share: async () => Promise.reject(new DOMException("cancelled", "AbortError")),
      },
    });
    await act(async () => {
      await hook!.share();
    });
    expect(copies).toBe(1);
  });
});
