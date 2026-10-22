/** Bounded, non-gating comparison. Run with Bun; --stress adds n=256. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { marchingSquares as current } from "../web/src/engine/contours.ts";

const baseline = "bcdd8c0d609b4952ffb179a5d13dbd69b1cf2758";
const directory = await mkdtemp(join(tmpdir(), "strata-contours-"));
try {
  const file = join(directory, "baseline.ts");
  await writeFile(
    file,
    execFileSync("git", ["show", `${baseline}:web/src/engine/contours.ts`]),
  );
  const previous = (await import(pathToFileURL(file).href))
    .marchingSquares as typeof current;
  for (const n of process.argv.includes("--stress") ? [128, 256] : [128]) {
    for (const mode of ["smooth", "noise"] as const) {
      const grid = Float64Array.from({ length: n * n }, (_, i) =>
        mode === "smooth"
          ? Math.sin((i % n) / 19) + Math.cos(Math.floor(i / n) / 23)
          : Math.sin(i * 238.324),
      );
      const run = (fn: typeof current) => {
        const start = performance.now();
        for (let level = 0; level < 12; level++)
          fn((x, y) => grid[y * n + x]!, n, -0.9 + level * 0.15);
        return performance.now() - start;
      };
      for (let warm = 0; warm < 3; warm++) {
        run(previous);
        run(current);
      }
      const old: number[] = [],
        next: number[] = [];
      for (let sample = 0; sample < 6; sample++) {
        if (sample % 2 === 0) {
          old.push(run(previous));
          next.push(run(current));
        } else {
          next.push(run(current));
          old.push(run(previous));
        }
      }
      const median = (values: number[]) => {
        const ordered = [...values].sort((a, b) => a - b);
        return (ordered[2]! + ordered[3]!) / 2;
      };
      console.log(
        JSON.stringify({
          n,
          mode,
          baseline,
          baselineMedianMs: median(old),
          currentMedianMs: median(next),
          baselineSamplesMs: old,
          currentSamplesMs: next,
        }),
      );
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
