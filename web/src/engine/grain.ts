// W3C Compositing 1 §10.1.10. Apply soft-light color without source-over
// coverage growth: transparent paper stays transparent, including soft edges.
// https://www.w3.org/TR/compositing-1/#blendingsoftlight
const dark = Float64Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c * (1 - c);
});
const light = Float64Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return (c <= 0.25 ? ((16 * c - 12) * c + 4) * c : Math.sqrt(c)) - c;
});
export function applyAlphaPreservingGrain(
  pixels: Uint8ClampedArray,
  width: number,
  noise: Uint8ClampedArray,
  noiseWidth: number,
  scaleX = 1,
  scaleY = 1,
): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const pixel = i / 4;
    const x = Math.min(
      noiseWidth - 1,
      Math.floor(((((pixel % width) / scaleX) % 96) * noiseWidth) / 96),
    );
    const y = Math.min(
      noiseWidth - 1,
      Math.floor(
        (((Math.floor(pixel / width) / scaleY) % 96) * noiseWidth) / 96,
      ),
    );
    const source = (y * noiseWidth + x) * 4;
    const amount = noise[source + 3] / 255,
      contrast = (2 * noise[source]) / 255 - 1;
    const curve = contrast <= 0 ? dark : light;
    for (let channel = 0; channel < 3; channel++) {
      const value = pixels[i + channel];
      pixels[i + channel] = value + 255 * amount * contrast * curve[value];
    }
  }
}
