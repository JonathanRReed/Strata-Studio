import type { Palette, StyleParams, ElevationGrid } from "../engine/types.ts";
import type { Preset } from "../presets/stylePresets.ts";
import { getStyle } from "../studios/registry.ts";
import { primaryButtonClass, secondaryButtonClass } from "./controls/primitives.tsx";
import {
  AnimationSection,
  CompositionSection,
  DataSection,
  FeaturesSection,
  PresetsSection,
  SeedPaletteSection,
  StudioSwitcher,
  StyleSection,
  TerrainSection,
} from "./controls/sections.tsx";
import { buildControlSet } from "./controls/controlSet.ts";

export type ControlsPanelProps = {
  params: StyleParams;
  styleId: string;
  onChange: (params: StyleParams) => void;
  onStyleChange: (styleId: string) => void;
  onApplyPreset: (preset: Preset) => void;
  onGenerate: () => void;
  onOpenExport: () => void;
  onFetchFeatures: (isRetry?: boolean) => void;
  isLoading: boolean;
  isExporting: boolean;
  isExportingAnimation: boolean;
  isFeatureLoading: boolean;
  featureInfo: string | null;
  hasFeatures: boolean;
  osmAreaHint?: string | null;
  /** Real elevation grid (when generated) so thumbnails render the user's terrain. */
  terrainGrid: ElevationGrid | null;
  allPalettes: Record<string, Palette>;
  allPaletteNames: Record<string, string>;
  onSavePalette: (id: string, name: string, palette: Palette) => void;
  onDeletePalette: (id: string) => void;
  isAnimating: boolean;
  onToggleAnimation: () => void;
};

/**
 * Desktop instrument rail: composes the shared control sections (see
 * ./controls/sections.tsx) into the fixed 340px left column. The mobile
 * bottom sheet (MobileSheet) renders the same section components in tabs.
 */
export function ControlsPanel({
  params,
  styleId,
  onChange,
  onStyleChange,
  onApplyPreset,
  onGenerate,
  onOpenExport,
  onFetchFeatures,
  isLoading,
  isExporting,
  isExportingAnimation,
  isFeatureLoading,
  featureInfo,
  hasFeatures,
  osmAreaHint,
  terrainGrid,
  allPalettes,
  allPaletteNames,
  onSavePalette,
  onDeletePalette,
  isAnimating,
  onToggleAnimation,
}: ControlsPanelProps) {
  const update = (patch: Partial<StyleParams>) => {
    onChange({ ...params, ...patch });
  };

  const activeStyle = getStyle(styleId);
  const studio = activeStyle.studio;
  const controls = buildControlSet(activeStyle.controls);

  return (
    <aside
      id="controls-panel"
      className="flex w-full flex-col border-b border-hairline bg-surface lg:h-full lg:w-[340px] lg:shrink-0 lg:border-b-0 lg:border-r"
    >
      {/* Header block: wordmark + studio switcher */}
      <header className="shrink-0 border-b border-hairline px-5 pb-4 pt-5">
        <h1 className="display text-[15px] tracking-[0.06em] text-ink">Strata Studio</h1>
        <StudioSwitcher className="mt-3" studio={studio} onStyleChange={onStyleChange} />
      </header>

      {/* Scrollable body */}
      <div className="px-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <StyleSection
          studio={studio}
          styleId={styleId}
          onStyleChange={onStyleChange}
          terrainGrid={terrainGrid}
        />
        <PresetsSection studio={studio} onApplyPreset={onApplyPreset} terrainGrid={terrainGrid} />
        <TerrainSection params={params} controls={controls} update={update} />
        <FeaturesSection
          params={params}
          controls={controls}
          update={update}
          onFetchFeatures={onFetchFeatures}
          isFeatureLoading={isFeatureLoading}
          featureInfo={featureInfo}
          hasFeatures={hasFeatures}
          osmAreaHint={osmAreaHint}
        />
        <AnimationSection
          params={params}
          update={update}
          isAnimating={isAnimating}
          onToggleAnimation={onToggleAnimation}
        />
        <CompositionSection params={params} controls={controls} update={update} />
        <SeedPaletteSection
          params={params}
          update={update}
          allPalettes={allPalettes}
          allPaletteNames={allPaletteNames}
          onSavePalette={onSavePalette}
          onDeletePalette={onDeletePalette}
        />
        <DataSection />
      </div>

      {/* Sticky footer: the panel's one signal primary + Export */}
      <div className="sticky bottom-0 z-10 flex shrink-0 flex-col gap-2 border-t border-hairline bg-surface p-4">
        <button
          type="button"
          onClick={onGenerate}
          disabled={isLoading || isExporting || isExportingAnimation}
          aria-busy={isLoading}
          className={primaryButtonClass}
        >
          {isLoading ? <span className="status-live">Generating</span> : "Generate"}
        </button>
        <button type="button" onClick={onOpenExport} className={secondaryButtonClass}>
          Export…
        </button>
      </div>
    </aside>
  );
}
