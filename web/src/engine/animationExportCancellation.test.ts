import { describe, expect, it } from "bun:test";
import { exportAnimation } from "./animationExport.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { palettes } from "../presets/palettes.ts";
import type { ArtworkInput } from "./types.ts";

const input: ArtworkInput = {
  bounds: { west: 0, south: 0, east: 1, north: 1 },
  elevationGrid: {
    width: 1,
    height: 1,
    bounds: { west: 0, south: 0, east: 1, north: 1 },
    data: new Float32Array([0]),
  },
  width: 1,
  height: 1,
  seed: "cancel",
};

describe("animation cancellation", () => {
  it("rejects a cancelled export before rendering or loading an encoder", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportAnimation("ridge", input, defaultStyleParams, palettes, "gif", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("contains cancellation checkpoints in frame capture and both encoder loops", async () => {
    const source = await Bun.file(new URL("./animationExport.ts", import.meta.url)).text();
    expect(source.match(/throwIfExportAborted\(signal\)/g)?.length ?? 0).toBeGreaterThan(8);
    expect(source).toContain("Encoding GIF frame");
    expect(source).toContain("await waitWithAbort(0, signal)");
  });
});

it('rejects unbounded and non-finite animation requests before allocating frames', async()=>{
  for(const options of [{frames:Infinity},{frames:1.5},{frames:241},{fps:NaN},{fps:0},{fps:61}]) {
    await expect(exportAnimation('ridge',input,defaultStyleParams,palettes,'gif',options)).rejects.toThrow('Animation requires');
  }
  await expect(exportAnimation('ridge',{...input,width:4096,height:4096},defaultStyleParams,palettes,'gif')).rejects.toThrow('128 MiB');
});
