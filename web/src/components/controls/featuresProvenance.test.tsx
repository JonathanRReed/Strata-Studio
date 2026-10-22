import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FeaturesSection } from "./sections.tsx";
import { defaultStyleParams } from "../../presets/stylePresets.ts";

const summary = "Tile fallback: 2 building shapes. Generalized map geometry; snapshot 2026-10-18.";
function render(featureError?: string) {
  return renderToStaticMarkup(<FeaturesSection params={defaultStyleParams} controls={new Set()} update={() => {}} onFetchFeatures={() => {}} isFeatureLoading={false} featureInfo={summary} featureError={featureError} hasFeatures={true} />).replace(/<[^>]*>/g, "");
}
test("generalized geometry provenance is visible text, not only a hover tooltip", () => {
  expect(render()).toContain(summary);
});
test("an active feature error does not present a stale snapshot as current", () => {
  expect(render("Fetch failed")).not.toContain(summary);
});
test('missing map data disables feature controls and explains the terrain-only preview',()=>{
 const html=renderToStaticMarkup(<FeaturesSection params={defaultStyleParams} controls={new Set(['buildingInfluence'])} update={()=>{}} onFetchFeatures={()=>{}} isFeatureLoading={false} featureInfo={null} featureError="Download failed" hasFeatures={false}/>);
 expect(html).toContain('Terrain-only preview');
 expect(html).toMatch(/<fieldset[^>]*aria-label="Map feature effects"[^>]*disabled/);
});
