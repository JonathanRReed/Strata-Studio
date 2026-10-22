import { expect, test } from "bun:test";
import { composeSvgPaints } from "./svgCompositing.ts";
const bounds = { x: 0, y: 0, width: 100, height: 100 };
test("knockouts affect earlier ink but never later ink", () => {
  const result = composeSvgPaints([
    { xml: "FIRST", bounds },
    { xml: "ERASE", bounds, erase: true },
    { xml: "LAST", bounds },
  ]);
  expect(result.content).toBe('<g mask="url(#knockout-0)"><g filter="url(#knockout-0-isolate)">FIRST\n</g></g>LAST\n');
  expect(result.defs.join("")).toContain("ERASE");
});
test("disjoint erasers do not allocate a mask for an unaffected paint batch", () => {
  const result = composeSvgPaints([
    { xml: "INK", bounds },
    {
      xml: "ERASE",
      bounds: { x: 200, y: 200, width: 20, height: 20 },
      erase: true,
    },
  ]);
  expect(result.content).toBe("INK\n");
  expect(result.defs.some((def) => def.startsWith("<mask"))).toBe(false);
});
test("consecutive erasers share one mask rather than nesting paint groups", () => {
  const result = composeSvgPaints([
    { xml: "INK", bounds },
    ...Array.from({ length: 100 }, () => ({
      xml: "ERASE",
      bounds,
      erase: true,
    })),
  ]);
  expect(result.content.match(/mask=/g)).toHaveLength(1);
  expect(result.defs).toHaveLength(1);
  expect(result.defs[0]!.match(/ERASE/g)).toHaveLength(100);
});
test("a later cut masks the entire composed prefix, not separate earlier layers", () => {
  const result = composeSvgPaints([
    { xml: "FIRST", bounds },
    { xml: "CUT1", bounds, erase: true },
    { xml: "SECOND", bounds },
    { xml: "CUT2", bounds, erase: true },
  ]);
  expect(result.content).toBe(
    '<g mask="url(#knockout-1)"><g filter="url(#knockout-1-isolate)"><g mask="url(#knockout-0)"><g filter="url(#knockout-0-isolate)">FIRST\n</g></g>SECOND\n</g></g>',
  );
});
test("pathological layer depth fails explicitly rather than hanging a viewer", () => {
  const paints = Array.from({ length: 129 }, () => [
    { xml: "INK", bounds },
    { xml: "CUT", bounds, erase: true },
  ]).flat();
  expect(() => composeSvgPaints(paints)).toThrow(
    "Transparent SVG is too complex",
  );
});


test("mask budgets include the prefix-isolation filter surface", () => {
  expect(() => composeSvgPaints([{xml:"INK",bounds},{xml:"CUT",bounds,erase:true}],100,100)).toThrow("too complex");
  const result=composeSvgPaints([{xml:"INK",bounds},{xml:"CUT",bounds,erase:true}]);
  expect(result.defs[0]).toContain('filterUnits="userSpaceOnUse"');
  expect(result.defs[0]).toContain('color-interpolation-filters="sRGB"');
  expect(result.defs[0]).toContain('<feColorMatrix');
});
