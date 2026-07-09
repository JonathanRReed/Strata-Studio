import { forwardRef, useEffect, useRef } from "react";
import type { AspectRatio } from "../engine/types.ts";

type Props = {
  size?: number;
  aspectRatio?: AspectRatio;
};

const RATIO_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  "square": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
  "9:16": { w: 9, h: 16 },
  "12:18": { w: 12, h: 18 },
};

export const Artboard = forwardRef<HTMLCanvasElement, Props>(
  function Artboard({ size = 512, aspectRatio = "square" }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ratio = RATIO_DIMS[aspectRatio];
    const canvasW = aspectRatio === "square" ? size : Math.round(size * ratio.w / Math.max(ratio.w, ratio.h));
    const canvasH = aspectRatio === "square" ? size : Math.round(size * ratio.h / Math.max(ratio.w, ratio.h));

    useEffect(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const dpr = window.devicePixelRatio || 1;
      const containerW = container.clientWidth - 32;
      const containerH = container.clientHeight - 32;
      const fitW = containerW;
      const fitH = containerH;
      const scale = Math.min(fitW / canvasW, fitH / canvasH, 1);
      const displayW = Math.round(canvasW * scale);
      const displayH = Math.round(canvasH * scale);
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;
      canvas.width = canvasW * dpr;
      canvas.height = canvasH * dpr;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) ctx.scale(dpr, dpr);
    }, [size, aspectRatio, canvasW, canvasH]);

    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center p-2 sm:p-4 lg:p-6 bg-black w-full h-full"
      >
        <canvas
          ref={(node) => {
            canvasRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          width={canvasW}
          height={canvasH}
          className="max-w-full max-h-full rounded border border-white/10 shadow-2xl"
        />
      </div>
    );
  },
);
