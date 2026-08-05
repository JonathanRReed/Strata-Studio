import { useEffect, useRef, useState } from "react";
import { renderStyleCanvas } from "../studios/registry.ts";
import { buildArtworkInput } from "../app/renderPipeline.ts";
import { getExportDimensions } from "../app/aspect.ts";
import { dealSeeds, VARIATION_COUNT, VARIATION_SIZE } from "../app/variations.ts";
import type {
  ElevationGrid,
  GeoFeatureCollection,
  Palette,
  StyleParams,
} from "../engine/types.ts";
import { ModalSurface } from "./ModalSurface.tsx";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Loaded terrain grid — variations render it with fresh seeds, no network. */
  grid: ElevationGrid | null;
  features?: GeoFeatureCollection;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
  supportsNativeDialog: boolean;
  /** Adopt a variant's seed: params update, main artwork re-renders, overlay closes. */
  onAdopt: (seed: string) => void;
};

/**
 * The variations overlay: a 2×2 grid of the current place/style/params
 * rendered under four fresh random seeds through the existing render
 * pipeline (one buildArtworkInput, four style renders — masks and crop are
 * seed-independent, so they're built once). Native <dialog> supplies the
 * Esc / backdrop / focus-trap semantics, matching ExportDialog.
 */
export function VariationsDialog({
  open,
  onClose,
  grid,
  features,
  params,
  styleId,
  allPalettes,
  supportsNativeDialog,
  onAdopt,
}: Props) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [seeds, setSeeds] = useState<string[]>([]);

  const { width, height } = getExportDimensions(params.aspectRatio, VARIATION_SIZE);

  // Deal a fresh hand every time the overlay opens.
  useEffect(() => {
    if (open) setSeeds(dealSeeds(VARIATION_COUNT, params.seed));
    // params.seed is read at open time only — reshuffle owns re-deals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Paint one variation per animation frame so four full-pipeline renders
  // never block a whole frame budget at once.
  useEffect(() => {
    if (!open || !grid || seeds.length === 0) return;
    const input = buildArtworkInput({ grid, features, params, width, height });
    let raf = 0;
    let index = 0;
    const renderNext = () => {
      if (index >= seeds.length) return;
      const seed = seeds[index];
      const canvas = canvasRefs.current[index];
      index++;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        renderStyleCanvas(
          styleId,
          ctx,
          { ...input, seed },
          { ...params, seed },
          allPalettes,
        );
      }
      raf = requestAnimationFrame(renderNext);
    };
    raf = requestAnimationFrame(renderNext);
    return () => cancelAnimationFrame(raf);
  }, [open, grid, features, seeds, params, styleId, allPalettes, width, height]);

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      supportsNativeDialog={supportsNativeDialog}
      ariaLabel="Variations"
      className="m-auto max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[520px] overflow-y-auto rounded-sm border border-hairline-2 bg-surface p-0 text-ink shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop:bg-ground/80"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="display text-[15px] tracking-[0.06em] text-ink">Variations</h2>
            <p className="instrument-label text-ink-faint">
              Same place and style, new seeds
            </p>
          </div>
          <button
            type="button"
            data-modal-initial-focus
            onClick={onClose}
            aria-label="Close variations"
            className="-m-2 flex h-11 w-11 items-center justify-center text-ink-muted press hover:text-ink"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {grid ? (
          <div className="grid grid-cols-2 gap-2">
            {seeds.map((seed, i) => (
              <button
                key={seed}
                type="button"
                onClick={() => onAdopt(seed)}
                title={`Use seed ${seed}`}
                className="group flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface p-1.5 text-left press press-tile hover:border-signal hover:bg-surface-2"
              >
                <canvas
                  ref={(el) => {
                    canvasRefs.current[i] = el;
                  }}
                  width={width}
                  height={height}
                  role="img"
                  aria-label={`Variation seed ${seed}`}
                  className="block w-full bg-ground"
                  style={{ aspectRatio: `${width} / ${height}` }}
                />
                <span className="instrument-label text-ink-muted transition-colors group-hover:text-ink">
                  Seed {seed}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-snug text-ink-faint">
            Generate an artwork first. Variations reuse its terrain.
          </p>
        )}

        <button
          type="button"
          onClick={() => setSeeds(dealSeeds(VARIATION_COUNT, params.seed))}
          disabled={!grid}
          className="flex min-h-11 items-center justify-center gap-2 rounded-sm border border-hairline-2 px-3 text-[13px] text-ink press hover:bg-surface-2 disabled:opacity-50"
        >
          <span aria-hidden="true">⟳</span>
          Deal {VARIATION_COUNT} new seeds
        </button>
      </div>
    </ModalSurface>
  );
}
