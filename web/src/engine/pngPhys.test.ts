/**
 * Print-grade PNG density: pHYs chunk construction (CRC-checked against
 * independently precomputed values from node:zlib crc32) and byte-splicing
 * into PNG streams — a crafted minimal fixture plus the real in-repo
 * web/public/og.png, chunk-walked after splicing to prove the stream stays
 * well-formed (signature + IHDR first + single pHYs before IDAT + IEND).
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPhysChunk, crc32, dpiToPpm, insertPhysChunk, withPngDpi } from "./export.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Known-good pHYs values, precomputed with node:zlib's crc32 (not our impl). */
const KNOWN_GOOD = [
  { dpi: 300, ppm: 11811, crc: 0x78a53f76 },
  { dpi: 250, ppm: 9843, crc: 0xf36c750a },
  { dpi: 72, ppm: 2835, crc: 0x009a9c18 },
];

type ChunkInfo = { type: string; offset: number; dataLength: number };

/** Walks a PNG's chunk sequence; throws on malformed streams. */
function walkChunks(png: Uint8Array): ChunkInfo[] {
  expect(png.length).toBeGreaterThanOrEqual(8);
  for (let i = 0; i < 8; i++) expect(png[i]).toBe(SIGNATURE[i]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: ChunkInfo[] = [];
  let offset = 8;
  while (offset < png.length) {
    const dataLength = view.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4],
      png[offset + 5],
      png[offset + 6],
      png[offset + 7],
    );
    chunks.push({ type, offset, dataLength });
    offset += 12 + dataLength;
    expect(offset).toBeLessThanOrEqual(png.length);
    if (type === "IEND") break;
  }
  return chunks;
}

/** Builds a chunk with a correct length field (CRC left zeroed — the walker ignores it). */
function fixtureChunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

/** Minimal PNG-shaped fixture: signature + IHDR + IDAT + IEND. */
function minimalPng(extraChunks: number[][] = []): Uint8Array<ArrayBuffer> {
  // IHDR: 1×1, bit depth 8, color type 6 (RGBA)
  const ihdr = fixtureChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = fixtureChunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]);
  const iend = fixtureChunk("IEND", []);
  return new Uint8Array([...SIGNATURE, ...ihdr, ...extraChunks.flat(), ...idat, ...iend]);
}

describe("crc32", () => {
  it("matches the classic CRC-32 check value", () => {
    // "123456789" → 0xCBF43926 is the standard CRC-32 verification vector.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("buildPhysChunk", () => {
  it("declares round(dpi / 0.0254) pixels per metre", () => {
    expect(dpiToPpm(300)).toBe(11811);
    expect(dpiToPpm(250)).toBe(9843);
    expect(dpiToPpm(72)).toBe(2835);
  });

  for (const { dpi, ppm, crc } of KNOWN_GOOD) {
    it(`builds a spec-correct chunk with a known-good CRC (dpi ${dpi})`, () => {
      const chunk = buildPhysChunk(dpi);
      const view = new DataView(chunk.buffer);
      expect(chunk.length).toBe(21); // 4 length + 4 type + 9 data + 4 CRC
      expect(view.getUint32(0)).toBe(9); // data length
      expect(String.fromCharCode(chunk[4], chunk[5], chunk[6], chunk[7])).toBe("pHYs");
      expect(view.getUint32(8)).toBe(ppm); // x pixels per metre
      expect(view.getUint32(12)).toBe(ppm); // y pixels per metre
      expect(chunk[16]).toBe(1); // unit specifier: metre
      expect(view.getUint32(17)).toBe(crc); // CRC over type + data
    });
  }
});

describe("insertPhysChunk", () => {
  it("splices pHYs immediately before the first IDAT", () => {
    const png = minimalPng();
    const out = insertPhysChunk(png, 300);
    const types = walkChunks(out).map((c) => c.type);
    expect(types).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
    // Only the pHYs chunk was added; everything else is byte-identical.
    expect(out.length).toBe(png.length + 21);
    const physOffset = walkChunks(out)[1].offset;
    expect([...out.subarray(physOffset, physOffset + 21)]).toEqual([...buildPhysChunk(300)]);
    expect([...out.subarray(0, physOffset)]).toEqual([...png.subarray(0, physOffset)]);
    expect([...out.subarray(physOffset + 21)]).toEqual([...png.subarray(physOffset)]);
  });

  it("replaces an existing pHYs instead of stacking a second one", () => {
    const once = insertPhysChunk(minimalPng(), 72);
    const twice = insertPhysChunk(once, 300);
    const phys = walkChunks(twice).filter((c) => c.type === "pHYs");
    expect(phys.length).toBe(1);
    const view = new DataView(twice.buffer, twice.byteOffset + phys[0].offset);
    expect(view.getUint32(8)).toBe(dpiToPpm(300));
    expect(twice.length).toBe(once.length);
  });

  it("also replaces a pHYs that precedes our insertion point", () => {
    const withPhys = minimalPng([fixtureChunk("pHYs", [0, 0, 0, 1, 0, 0, 0, 1, 0])]);
    const out = insertPhysChunk(withPhys, 250);
    const types = walkChunks(out).map((c) => c.type);
    expect(types).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
    expect(types.filter((t) => t === "pHYs").length).toBe(1);
  });

  it("returns non-PNG and truncated inputs untouched", () => {
    const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(insertPhysChunk(notPng, 300)).toBe(notPng);
    const truncated = minimalPng().subarray(0, 20); // cuts IHDR mid-chunk
    expect(insertPhysChunk(truncated, 300)).toBe(truncated);
    const empty = new Uint8Array(0);
    expect(insertPhysChunk(empty, 300)).toBe(empty);
  });
});

describe("withPngDpi", () => {
  it("round-trips a PNG blob with the density spliced in", async () => {
    const blob = new Blob([minimalPng()], { type: "image/png" });
    const out = await withPngDpi(blob, 300);
    expect(out.type).toBe("image/png");
    const bytes = new Uint8Array(await out.arrayBuffer());
    const chunks = walkChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });

  it("returns the original blob for non-PNG input", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    expect(await withPngDpi(blob, 300)).toBe(blob);
  });
});

describe("real PNG fixture (web/public/og.png)", () => {
  const ogPath = fileURLToPath(new URL("../../public/og.png", import.meta.url));

  it("splices a print density into a real encoder's output and stays well-formed", () => {
    const original = new Uint8Array(readFileSync(ogPath));
    const originalChunks = walkChunks(original);
    expect(originalChunks[0].type).toBe("IHDR");
    expect(originalChunks[originalChunks.length - 1].type).toBe("IEND");

    const out = insertPhysChunk(original, 250);
    const chunks = walkChunks(out);

    // Signature + IHDR first + IEND last survive the splice.
    expect(chunks[0].type).toBe("IHDR");
    expect(chunks[chunks.length - 1].type).toBe("IEND");

    // Exactly one pHYs, placed before the first IDAT.
    const physIndexes = chunks.flatMap((c, i) => (c.type === "pHYs" ? [i] : []));
    expect(physIndexes.length).toBe(1);
    const firstIdat = chunks.findIndex((c) => c.type === "IDAT");
    expect(firstIdat).toBeGreaterThan(0);
    expect(physIndexes[0]).toBeLessThan(firstIdat);

    // Declared density and CRC are the known-good 250 DPI values.
    const view = new DataView(out.buffer, out.byteOffset + chunks[physIndexes[0]].offset);
    expect(view.getUint32(0)).toBe(9);
    expect(view.getUint32(8)).toBe(9843);
    expect(view.getUint32(12)).toBe(9843);
    expect(view.getUint32(17)).toBe(0xf36c750a);

    // Chunk walk consumed the whole buffer: nothing dangling after IEND.
    const last = chunks[chunks.length - 1];
    expect(last.offset + 12 + last.dataLength).toBe(out.length);

    // The non-pHYs chunk sequence is unchanged from the original.
    const originalTypes = originalChunks.map((c) => c.type).filter((t) => t !== "pHYs");
    const splicedTypes = chunks.map((c) => c.type).filter((t) => t !== "pHYs");
    expect(splicedTypes).toEqual(originalTypes);
  });
});
