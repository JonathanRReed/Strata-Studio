import { expect, test, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAnimationLoop } from "./useAnimationLoop.ts";
import { getStyle } from "../studios/registry.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { palettes } from "../presets/palettes.ts";
import type { ArtworkInput } from "../engine/types.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

for (const mode of ["draw", "parallax", "drift"] as const)
  test(`${mode} preview schedules only necessary work and cleans up`, async () => {
    const oldRaf = globalThis.requestAnimationFrame,
      oldCancel = globalThis.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    let id = 0,
      paints = 0;
    globalThis.requestAnimationFrame = (callback) => {
      pending.set(++id, callback);
      return id;
    };
    globalThis.cancelAnimationFrame = (handle) => {
      pending.delete(handle);
    };
    const clock = spyOn(performance, "now").mockReturnValue(1000);
    const generation = spyOn(getStyle("ridge"), "generate").mockReturnValue({
      strokes: [],
    });
    const canvas = { width: 100, height: 100, getContext: () => ctx };
    const ctx = {
      canvas,
      save() {},
      restore() {},
      setTransform() {},
      scale() {},
      fillRect() {
        paints++;
      },
    };
    const bounds = { west: 0, east: 1, north: 1, south: 0 };
    const input: ArtworkInput = {
      bounds,
      elevationGrid: {
        bounds,
        width: 1,
        height: 1,
        data: new Float32Array([0]),
      },
      width: 100,
      height: 100,
      seed: "frames",
    };
    const props = {
      canvasRef: { current: canvas as unknown as HTMLCanvasElement },
      isAnimating: true,
      input,
      params: {
        ...defaultStyleParams,
        animationMode: mode,
        animationSpeed: 1,
        grain: 0,
        label: "",
      },
      styleId: "ridge",
      allPalettes: palettes,
    };
    function Probe() {
      useAnimationLoop(props);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    const tick = async (time: number) => {
      const [handle, callback] = pending.entries().next().value!;
      pending.delete(handle);
      await act(async () => callback(time));
    };
    try {
      await act(async () => {
        renderer = create(<Probe />);
      });
      await tick(1001);
      await tick(1002);
      await tick(1100);
      expect(paints).toBe(mode === "drift" ? 3 : 2);
      expect(generation).toHaveBeenCalledTimes(mode === "drift" ? 3 : 1);
      expect(pending.size).toBe(1);
      await act(async () => renderer!.unmount());
      renderer = undefined;
      expect(pending.size).toBe(0);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      generation.mockRestore();
      clock.mockRestore();
      globalThis.requestAnimationFrame = oldRaf;
      globalThis.cancelAnimationFrame = oldCancel;
    }
  });
