/** Ordered destination-out compositing for standalone vector SVG exports. */
export type SvgBounds = { x: number; y: number; width: number; height: number };
export type SvgPaint = { xml: string; bounds: SvgBounds; erase?: boolean };
const intersects = (a: SvgBounds, b: SvgBounds) =>
  a.x <= b.x + b.width &&
  b.x <= a.x + a.width &&
  a.y <= b.y + b.height &&
  b.y <= a.y + a.height;
const union = (a: SvgBounds, b: SvgBounds): SvgBounds => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
});

/**
 * Erase the composed prefix, not individual earlier paint batches. Masking
 * earlier batches independently would reveal hidden ink through later cuts.
 * Consecutive erasers share one mask. Tight bounds and explicit budgets keep
 * pathological transparent vectors from creating unbounded offscreen layers.
 */
export function composeSvgPaints(
  paints: SvgPaint[],
  pixelScaleX = 1,
  pixelScaleY = 1,
): { content: string; defs: string[] } {
  let content = "",
    bounds: SvgBounds | undefined,
    pixels = 0;
  const defs: string[] = [];
  for (let index = 0; index < paints.length; index++) {
    const paint = paints[index];
    if (!paint.erase) {
      content += paint.xml + "\n";
      bounds = bounds ? union(bounds, paint.bounds) : paint.bounds;
      continue;
    }
    const erasers: string[] = [];
    do {
      const erase = paints[index];
      if (bounds && intersects(bounds, erase.bounds)) erasers.push(erase.xml);
      index++;
    } while (index < paints.length && paints[index].erase);
    index--;
    if (!bounds || erasers.length === 0) continue;
    pixels += bounds.width * bounds.height * pixelScaleX * pixelScaleY;
    if (defs.length >= 128 || pixels > 128 * 1024 * 1024) {
      throw new Error(
        "Transparent SVG is too complex; use PNG or reduce detail/export size",
      );
    }
    const id = `knockout-${defs.length}`;
    const region = `x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}"`;
    defs.push(
      `<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance" color-interpolation="sRGB" ${region}><rect ${region} fill="white"/>${erasers.join("")}</mask>`,
    );
    content = `<g mask="url(#${id})">${content}</g>`;
  }
  return { content, defs };
}
