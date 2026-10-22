import { expect, test } from 'bun:test';
import { overpassToGeoJSON } from './osmOverpass.ts';
test('recursive untagged ways do not become invented buildings', () => {
  const result = overpassToGeoJSON({ elements: [
    { type: 'node', id: 1, lat: 40, lon: -74 },
    { type: 'node', id: 2, lat: 40.001, lon: -74 },
    { type: 'way', id: 3, nodes: [1, 2] },
  ] });
  expect(result.features).toEqual([]);
});
