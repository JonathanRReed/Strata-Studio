import { useEffect, useRef } from "react";
import { renderThumbnail, THUMBNAIL_SIZE, thumbnailKey } from "../app/thumbnails.ts";
import type { ElevationGrid, StyleParams } from "../engine/types.ts";

/** One selectable thumbnail: a style or a preset resolved to full params. */
export type ThumbGridItem = {
  id: string;
  label: string;
  styleId: string;
  params: StyleParams;
};

type Props = {
  items: ThumbGridItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Re-render thumbnails from the user's real terrain instead of the sample. */
  grid?: ElevationGrid;
  /** Number of grid columns; the consumer owns the surrounding layout. */
  columns?: number;
};

/*
 * Idle render queue: thumbnail paints are staggered one per idle slice so a
 * grid of 16 styles doesn't jank the main thread on mount. Each Thumb
 * enqueues a job; the pump runs exactly one job per requestIdleCallback
 * (setTimeout fallback), then reschedules itself while work remains.
 * Unmounted thumbs cancel by removing their job from the queue.
 */
type IdleJob = () => void;
const jobQueue: IdleJob[] = [];
let pumpScheduled = false;

function scheduleIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 300 });
  } else {
    setTimeout(run, 16);
  }
}

function pumpQueue(): void {
  pumpScheduled = false;
  const job = jobQueue.shift();
  if (job) job();
  if (jobQueue.length > 0 && !pumpScheduled) {
    pumpScheduled = true;
    scheduleIdle(pumpQueue);
  }
}

function enqueueThumbnailJob(job: IdleJob): () => void {
  jobQueue.push(job);
  if (!pumpScheduled) {
    pumpScheduled = true;
    scheduleIdle(pumpQueue);
  }
  return () => {
    const index = jobQueue.indexOf(job);
    if (index !== -1) jobQueue.splice(index, 1);
  };
}

function Thumb({
  styleId,
  params,
  grid,
}: {
  styleId: string;
  params: StyleParams;
  grid?: ElevationGrid;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Content key: params object identity may change every parent render;
  // only re-paint when the rendered output would actually differ.
  const key = thumbnailKey(styleId, params);

  useEffect(() => {
    return enqueueThumbnailJob(() => {
      const source = renderThumbnail(styleId, params, THUMBNAIL_SIZE, grid);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!source || !canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    });
    // styleId and params are folded into `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, grid]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMBNAIL_SIZE}
      height={THUMBNAIL_SIZE}
      className="block aspect-square w-full bg-ground"
      aria-hidden="true"
    />
  );
}

export function ThumbGrid({
  items,
  selectedId,
  onSelect,
  grid,
  columns = 3,
}: Props) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const isSelected = item.id === selectedId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-pressed={isSelected}
            title={item.label}
            className={`press press-tile flex min-h-11 w-full flex-col gap-1.5 rounded-sm border p-1.5 text-left ${
              isSelected
                ? "border-signal bg-surface-2"
                : "border-hairline bg-surface hover:border-hairline-2 hover:bg-surface-2"
            }`}
          >
            <Thumb styleId={item.styleId} params={item.params} grid={grid} />
            <span
              className={`instrument-label block truncate ${
                isSelected ? "text-ink" : "text-ink-muted"
              }`}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
