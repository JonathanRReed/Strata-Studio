// @ts-expect-error upng-js does not publish TypeScript declarations.
import UPNG from "upng-js";
import type { ApngRequest, ApngResponse } from "./apngWorker.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ApngRequest>) => void) | null;
  postMessage: (message: ApngResponse, transfer: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const png: ArrayBuffer = UPNG.encode(
      data.frames,
      data.width,
      data.height,
      0,
      data.delays,
    );
    scope.postMessage({ ok: true, png }, [png]);
  } catch (error) {
    scope.postMessage(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      [],
    );
  }
};
