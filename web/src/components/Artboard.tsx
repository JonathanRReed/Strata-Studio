import { forwardRef, useEffect, useRef } from "react";
import type { AspectRatio } from "../engine/types.ts";
import { ASPECT_RATIOS } from "../app/aspect.ts";

/** Backing-store cap per axis; keeps huge stages from allocating absurd bitmaps. */
const MAX_BACKING_PX = 4096;
/** Settle time before the backing store is re-cut and the artwork re-rendered. */
const RESIZE_DEBOUNCE_MS = 100;
/** Frame chrome around the canvas: 10px mat padding + 1px border per side. */
const FRAME_INSET = 2 * (10 + 1);

type Props = {
  aspectRatio?: AspectRatio;
  /** Hide the frame visually (first-run empty state) while keeping layout for sizing. */
  visible?: boolean;
  /** Accessible description of the artwork (style + place). */
  ariaLabel: string;
  /** Called after the canvas backing store changes size (already debounced). */
  onCanvasResized?: () => void;
};

/**
 * The museum frame: a mat-and-border around the artwork canvas. The canvas
 * display size fits the surrounding container (via ResizeObserver, no fixed
 * cap), and the backing store renders at display-size × devicePixelRatio.
 * The render pipeline generates scenes at a logical 512 and scales via the
 * canvas transform, so a large canvas stays crisp and WYSIWYG.
 *
 * During a live resize the existing bitmap is CSS-scaled (style size updates
 * immediately); the backing store is re-cut only after RESIZE_DEBOUNCE_MS so
 * the artwork never flashes blank mid-drag.
 */
export const Artboard = forwardRef<HTMLCanvasElement, Props>(function Artboard(
  { aspectRatio = "square", visible = true, ariaLabel, onCanvasResized },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onResizedRef = useRef(onCanvasResized);
  onResizedRef.current = onCanvasResized;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    // Context options are fixed by the first getContext call; request the
    // read-friendly context up front so later callers share it.
    canvas.getContext("2d", { willReadFrequently: true });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const displaySize = (): { w: number; h: number } => {
      const availW = Math.max(1, container.clientWidth - FRAME_INSET);
      const availH = Math.max(1, container.clientHeight - FRAME_INSET);
      const ratio = ASPECT_RATIOS[aspectRatio];
      const scale = Math.min(availW / ratio.w, availH / ratio.h);
      return {
        w: Math.max(1, Math.floor(ratio.w * scale)),
        h: Math.max(1, Math.floor(ratio.h * scale)),
      };
    };

    const applyDisplaySize = () => {
      const { w, h } = displaySize();
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };

    const applyBackingStore = () => {
      const { w, h } = displaySize();
      const dpr = window.devicePixelRatio || 1;
      let backingW = Math.round(w * dpr);
      let backingH = Math.round(h * dpr);
      const cap = MAX_BACKING_PX / Math.max(backingW, backingH);
      if (cap < 1) {
        backingW = Math.floor(backingW * cap);
        backingH = Math.floor(backingH * cap);
      }
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
        onResizedRef.current?.();
      }
    };

    // Initial pass runs synchronously so the first render paints crisp.
    applyDisplaySize();
    applyBackingStore();

    const observer = new ResizeObserver(() => {
      applyDisplaySize();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyBackingStore, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [aspectRatio]);

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 w-full flex-1 items-center justify-center"
    >
      <div
        className={`rounded-none border border-hairline-2 bg-surface-2 p-[10px] shadow-[0_24px_80px_rgba(0,0,0,0.55)] ${
          visible ? "" : "invisible"
        }`}
      >
        <canvas
          ref={(node) => {
            canvasRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          role="img"
          aria-label={ariaLabel}
          className="block"
        />
      </div>
    </div>
  );
});
