// A valid vector tile with one irrelevant place-label point. An empty named
// layer is discarded by vector-tile parsers, so it is not a valid substitute
// for testing a completed snapshot with no building/road/water features.
export const EMPTY_MAP_TILE_BYTES = new Uint8Array([
  26,21,10,5,112,108,97,99,101,120,2,40,128,32,18,7,24,1,34,3,9,0,0,
]);
