import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  AnimationMode,
  AspectRatio,
  ControlKey,
  ElevationGrid,
  LabelStyle,
  MaskMode,
  Palette,
  Studio,
  StyleParams,
} from "../../engine/types.ts";
import { presets, defaultStyleParams, applyPreset, type Preset } from "../../presets/stylePresets.ts";
import { stylesByStudio, getStyle } from "../../studios/registry.ts";
import { cacheStats, clearCache, type CacheStats } from "../../data/cache.ts";
import { PalettePicker } from "../PalettePicker.tsx";
import { ThumbGrid, type ThumbGridItem } from "../ThumbGrid.tsx";
import {
  InfoDot,
  ModeSelector,
  Section,
  Slider,
  secondaryButtonClass,
  selectClass,
  textInputClass,
} from "./primitives.tsx";

/*
 * The controls surface, broken into sections. ControlsPanel (desktop rail)
 * and MobileSheet (bottom sheet tabs) compose these; neither duplicates the
 * markup or logic. Props flow is unchanged from the original ControlsPanel —
 * every section receives exactly the state it used to close over.
 */

export type ParamsUpdate = (patch: Partial<StyleParams>) => void;

const MASK_MODE_DESCRIPTIONS: Record<MaskMode, string> = {
  interrupt: "Breaks terrain lines where this feature is present",
  amplify: "Makes terrain displacement larger over this feature",
  flatten: "Damps terrain displacement toward zero over this feature",
  glow: "Highlights terrain lines over this feature in accent color",
  outline: "Traces this feature's boundary with accent strokes",
  invert: "Reverses terrain displacement over this feature",
};

const ANIMATION_MODE_DESCRIPTIONS: Record<AnimationMode, string> = {
  none: "Static artwork",
  drift: "Noise field scrolls over time — organic breathing motion",
  draw: "Lines draw themselves in stroke by stroke, then loop",
  parallax: "Depth layers separate and drift at different speeds",
};

const STUDIOS: Studio[] = ["classic", "experimental"];
const STUDIO_LABELS: Record<Studio, string> = {
  classic: "Classic Studio",
  experimental: "Experimental Lab",
};

/** Studio switcher tablist (Classic / Experimental) with arrow-key roving. */
export function StudioSwitcher({
  studio,
  onStyleChange,
  className,
}: {
  studio: Studio;
  onStyleChange: (styleId: string) => void;
  className?: string;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = STUDIOS.indexOf(studio);
    const next =
      (current + (e.key === "ArrowRight" ? 1 : STUDIOS.length - 1)) % STUDIOS.length;
    const target = STUDIOS[next];
    if (target !== studio) onStyleChange(stylesByStudio[target][0].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Studio"
      className={`${className ? `${className} ` : ""}grid grid-cols-2 overflow-hidden rounded-sm border border-hairline`}
    >
      {STUDIOS.map((s, i) => (
        <button
          key={s}
          ref={(el) => {
            tabRefs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={studio === s}
          tabIndex={studio === s ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => {
            if (studio !== s) onStyleChange(stylesByStudio[s][0].id);
          }}
          className={`flex min-h-11 items-center justify-center border-b-2 px-2 text-[13px] transition-colors ${
            studio === s
              ? "border-signal bg-surface-2 text-ink"
              : "border-transparent text-ink-muted hover:text-ink"
          }`}
        >
          {STUDIO_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

export function StyleSection({
  studio,
  styleId,
  onStyleChange,
  terrainGrid,
}: {
  studio: Studio;
  styleId: string;
  onStyleChange: (styleId: string) => void;
  terrainGrid: ElevationGrid | null;
}) {
  const activeStyle = getStyle(styleId);
  const styleItems = useMemo<ThumbGridItem[]>(
    () =>
      stylesByStudio[studio].map((style) => ({
        id: style.id,
        label: style.name,
        styleId: style.id,
        params: { ...defaultStyleParams, ...style.defaultParams },
      })),
    [studio],
  );
  return (
    <Section title="Style" defaultOpen={true}>
      <ThumbGrid
        items={styleItems}
        selectedId={styleId}
        onSelect={onStyleChange}
        grid={terrainGrid ?? undefined}
        columns={3}
      />
      <p className="text-[12px] leading-snug text-ink-faint">{activeStyle.description}</p>
    </Section>
  );
}

export function PresetsSection({
  studio,
  onApplyPreset,
  terrainGrid,
}: {
  studio: Studio;
  onApplyPreset: (preset: Preset) => void;
  terrainGrid: ElevationGrid | null;
}) {
  const studioPresets = useMemo(
    () => presets.filter((p) => getStyle(p.styleId).studio === studio),
    [studio],
  );
  const presetItems = useMemo<ThumbGridItem[]>(
    () =>
      studioPresets.map((preset) => ({
        id: preset.id,
        label: preset.name,
        styleId: preset.styleId,
        params: applyPreset(preset, getStyle(preset.styleId).defaultParams),
      })),
    [studioPresets],
  );

  const handlePresetSelect = useCallback(
    (id: string) => {
      const preset = studioPresets.find((p) => p.id === id);
      if (preset) onApplyPreset(preset);
    },
    [studioPresets, onApplyPreset],
  );

  return (
    <Section title="Presets" defaultOpen={true}>
      <ThumbGrid
        items={presetItems}
        selectedId={null}
        onSelect={handlePresetSelect}
        grid={terrainGrid ?? undefined}
        columns={3}
      />
    </Section>
  );
}

export function TerrainSection({
  params,
  controls,
  update,
}: {
  params: StyleParams;
  controls: Set<ControlKey>;
  update: ParamsUpdate;
}) {
  const hasAnySlider = ["amplitude", "spacing", "lineWidth", "noise", "detail", "compression", "occlusion"].some((k) => controls.has(k as ControlKey));
  if (!hasAnySlider) return null;
  return (
    <Section title="Terrain" defaultOpen={true}>
      {controls.has("amplitude") && (
        <Slider
          label="Amplitude"
          value={params.amplitude}
          min={0}
          max={120}
          step={1}
          onChange={(v) => update({ amplitude: v })}
          tooltip="How far terrain displaces the lines"
        />
      )}
      {controls.has("spacing") && (
        <Slider
          label="Spacing"
          value={params.spacing}
          min={1}
          max={30}
          step={0.5}
          onChange={(v) => update({ spacing: v })}
          tooltip="Distance between terrain lines"
        />
      )}
      {controls.has("lineWidth") && (
        <Slider
          label="Line thickness"
          value={params.lineWidth}
          min={0.5}
          max={5}
          step={0.25}
          onChange={(v) => update({ lineWidth: v })}
        />
      )}
      {controls.has("noise") && (
        <Slider
          label="Noise"
          value={params.noise}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => update({ noise: v })}
          tooltip="Random perturbation strength"
        />
      )}
      {controls.has("detail") && (
        <Slider
          label="Detail"
          value={params.detail}
          min={0.1}
          max={1}
          step={0.05}
          onChange={(v) => update({ detail: v })}
          tooltip="Sampling resolution — higher = more detail"
        />
      )}
      {controls.has("compression") && (
        <Slider
          label="Vertical compression"
          value={params.compression}
          min={0.5}
          max={2}
          step={0.05}
          onChange={(v) => update({ compression: v })}
        />
      )}
      {controls.has("occlusion") && (
        <Slider
          label="Occlusion"
          value={params.occlusion}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => update({ occlusion: v })}
          tooltip="Fills below lines for a solid-layered look"
        />
      )}
    </Section>
  );
}

export function FeaturesSection({
  params,
  controls,
  update,
  onFetchFeatures,
  isFeatureLoading,
  featureInfo,
  featureError,
  hasFeatures,
  osmAreaHint,
}: {
  params: StyleParams;
  controls: Set<ControlKey>;
  update: ParamsUpdate;
  onFetchFeatures: (isRetry?: boolean) => void;
  isFeatureLoading: boolean;
  featureInfo: string | null;
  featureError?: string | null;
  hasFeatures: boolean;
  osmAreaHint?: string | null;
}) {
  const [showPerTypeWater, setShowPerTypeWater] = useState(false);
  const hasFeatureControls =
    controls.has("buildingInfluence") || controls.has("roadInfluence") || controls.has("waterInfluence") ||
    controls.has("oceanInfluence") || controls.has("lakeInfluence") || controls.has("riverInfluence");

  // FEATURES status chip: parse the building count out of the summary line.
  const buildingCount = featureInfo?.match(/Loaded (\d+) buildings/)?.[1];
  const featureChip = isFeatureLoading ? (
    <span className="status-live text-ink-muted">Fetching features</span>
  ) : featureError ? (
    <span className="text-alarm">Feature fetch failed</span>
  ) : osmAreaHint ? (
    <span className="text-ink-faint">Area too large — zoom in</span>
  ) : hasFeatures ? (
    <span className="text-ok">
      Features loaded
      {buildingCount ? ` · ${Number(buildingCount).toLocaleString("en-US")} buildings` : ""}
    </span>
  ) : (
    <span className="text-ink-faint">No features loaded</span>
  );

  return (
    <Section
      title="Features"
      defaultOpen={hasFeatures}
      badge={hasFeatures ? "loaded" : undefined}
    >
      <p role="status" className="instrument-label" title={featureInfo ?? osmAreaHint ?? undefined}>
        {featureChip}
      </p>
      {featureError && !isFeatureLoading && (
        <p className="text-[12px] leading-snug text-alarm/80">{featureError}</p>
      )}
      <button
        type="button"
        onClick={() => onFetchFeatures(!!featureError)}
        disabled={isFeatureLoading}
        className={secondaryButtonClass}
      >
        {isFeatureLoading
          ? "Fetching OSM data…"
          : featureError
            ? "Retry OSM fetch"
            : hasFeatures
              ? "Re-fetch OSM features"
              : "Fetch OSM features (buildings, roads, water)"}
      </button>

      {hasFeatureControls && (
      <div className="flex flex-col gap-3.5 border-l border-hairline pl-2.5">
        {/* Buildings */}
        {controls.has("buildingInfluence") && (
          <>
            <Slider
              label="Building influence"
              value={params.buildingInfluence}
              min={0}
              max={100}
              step={1}
              onChange={(v) => update({ buildingInfluence: v })}
              tooltip="How much building footprints affect the terrain"
            />
            <ModeSelector
              label="Building mode"
              value={params.buildingMode}
              onChange={(v) => update({ buildingMode: v })}
              tooltip={MASK_MODE_DESCRIPTIONS[params.buildingMode]}
            />
          </>
        )}
        {/* Roads */}
        {controls.has("roadInfluence") && (
          <>
            <Slider
              label="Road influence"
              value={params.roadInfluence}
              min={0}
              max={100}
              step={1}
              onChange={(v) => update({ roadInfluence: v })}
              tooltip="How much roads affect the terrain"
            />
            <ModeSelector
              label="Road mode"
              value={params.roadMode}
              onChange={(v) => update({ roadMode: v })}
              tooltip={MASK_MODE_DESCRIPTIONS[params.roadMode]}
            />
          </>
        )}
        {/* Water — combined */}
        {controls.has("waterInfluence") && (
          <>
            <Slider
              label="Water influence (all)"
              value={params.waterInfluence}
              min={0}
              max={100}
              step={1}
              onChange={(v) => update({ waterInfluence: v })}
              tooltip="Affects all water types. Expand below for per-type control."
            />
            <ModeSelector
              label="Water mode"
              value={params.waterMode}
              onChange={(v) => update({ waterMode: v })}
              tooltip={MASK_MODE_DESCRIPTIONS[params.waterMode]}
            />
          </>
        )}
        {/* Per-type water toggle */}
        {(controls.has("oceanInfluence") || controls.has("lakeInfluence") || controls.has("riverInfluence")) && (
          <>
            <button
              type="button"
              onClick={() => setShowPerTypeWater(!showPerTypeWater)}
              aria-expanded={showPerTypeWater}
              className="instrument-label min-h-9 text-left text-ink-faint transition-colors hover:text-ink-muted"
            >
              {showPerTypeWater ? "− Hide per-type water" : "+ Per-type water (ocean / lake / river)"}
            </button>
            {showPerTypeWater && (
              <div className="flex flex-col gap-3.5 border-l border-hairline pl-2.5">
                {controls.has("oceanInfluence") && (
                  <>
                    <Slider
                      label="Ocean influence"
                      value={params.oceanInfluence}
                      min={0}
                      max={100}
                      step={1}
                      onChange={(v) => update({ oceanInfluence: v })}
                      tooltip="Affects coastline / ocean areas only"
                    />
                    <ModeSelector
                      label="Ocean mode"
                      value={params.oceanMode}
                      onChange={(v) => update({ oceanMode: v })}
                      tooltip={MASK_MODE_DESCRIPTIONS[params.oceanMode]}
                    />
                  </>
                )}
                {controls.has("lakeInfluence") && (
                  <>
                    <Slider
                      label="Lake influence"
                      value={params.lakeInfluence}
                      min={0}
                      max={100}
                      step={1}
                      onChange={(v) => update({ lakeInfluence: v })}
                      tooltip="Affects lake areas only"
                    />
                    <ModeSelector
                      label="Lake mode"
                      value={params.lakeMode}
                      onChange={(v) => update({ lakeMode: v })}
                      tooltip={MASK_MODE_DESCRIPTIONS[params.lakeMode]}
                    />
                  </>
                )}
                {controls.has("riverInfluence") && (
                  <>
                    <Slider
                      label="River influence"
                      value={params.riverInfluence}
                      min={0}
                      max={100}
                      step={1}
                      onChange={(v) => update({ riverInfluence: v })}
                      tooltip="Affects river / stream areas only"
                    />
                    <ModeSelector
                      label="River mode"
                      value={params.riverMode}
                      onChange={(v) => update({ riverMode: v })}
                      tooltip={MASK_MODE_DESCRIPTIONS[params.riverMode]}
                    />
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      )}
    </Section>
  );
}

export function AnimationSection({
  params,
  update,
  isAnimating,
  onToggleAnimation,
}: {
  params: StyleParams;
  update: ParamsUpdate;
  isAnimating: boolean;
  onToggleAnimation: () => void;
}) {
  return (
    <Section title="Animation" defaultOpen={params.animationMode !== "none"}>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          Animation style
          <InfoDot text="Add motion to your artwork. Drift breathes, draw reveals lines stroke by stroke, parallax separates depth layers." />
        </span>
        <select
          value={params.animationMode}
          onChange={(e) => update({ animationMode: e.target.value as AnimationMode })}
          className={selectClass}
        >
          <option value="none">None (static)</option>
          <option value="drift">Drift — organic breathing</option>
          <option value="draw">Draw-in — stroke reveal</option>
          <option value="parallax">Parallax — depth layers</option>
        </select>
      </label>
      {params.animationMode !== "none" && (
        <>
          <p className="text-[12px] leading-snug text-ink-faint">
            {ANIMATION_MODE_DESCRIPTIONS[params.animationMode]}
          </p>
          <Slider
            label="Animation speed"
            value={params.animationSpeed}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => update({ animationSpeed: v })}
            tooltip="Loops per second for the live preview"
          />
          <button
            type="button"
            onClick={onToggleAnimation}
            className={
              isAnimating
                ? "flex min-h-11 items-center justify-center rounded-sm border border-signal bg-surface-2 px-3 text-[13px] text-ink transition-colors"
                : secondaryButtonClass
            }
          >
            {isAnimating ? "⏸ Pause preview" : "▶ Play preview"}
          </button>
        </>
      )}
    </Section>
  );
}

export function CompositionSection({
  params,
  controls,
  update,
}: {
  params: StyleParams;
  controls: Set<ControlKey>;
  update: ParamsUpdate;
}) {
  return (
    <Section title="Composition" defaultOpen={false}>
      {controls.has("grain") && (
        <Slider
          label="Grain"
          value={params.grain}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => update({ grain: v })}
          tooltip="Adds a film-grain texture overlay"
        />
      )}
      {controls.has("rotation") && (
        <Slider
          label="Rotation"
          value={params.rotation}
          min={0}
          max={360}
          step={1}
          onChange={(v) => update({ rotation: v })}
        />
      )}
      {controls.has("label") && (
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
          Label
          <input
            type="text"
            value={params.label}
            onChange={(e) => update({ label: e.target.value })}
            placeholder="Optional place name"
            className={textInputClass}
          />
        </label>
      )}
      {controls.has("label") && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="instrument-label flex items-center gap-1.5 text-ink-faint">
            Label style
            <InfoDot text="Poster renders the label as a letterspaced-caps title block with coordinates and elevation range." />
          </legend>
          <div className="grid grid-cols-2 overflow-hidden rounded-sm border border-hairline">
            {(["plain", "poster"] as LabelStyle[]).map((style) => (
              <label key={style}>
                <input
                  type="radio"
                  name="label-style"
                  value={style}
                  checked={params.labelStyle === style}
                  onChange={() => update({ labelStyle: style })}
                  className="peer sr-only"
                />
                <span
                  className={`flex min-h-11 cursor-pointer items-center justify-center border-b-2 px-2 text-[13px] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-signal ${
                    params.labelStyle === style
                      ? "border-signal bg-surface-2 text-ink"
                      : "border-transparent text-ink-muted hover:text-ink"
                  }`}
                >
                  {style === "plain" ? "Plain" : "Poster"}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {controls.has("aspectRatio") && (
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
          Aspect ratio
          <select
            value={params.aspectRatio}
            onChange={(e) => update({ aspectRatio: e.target.value as AspectRatio })}
            className={selectClass}
          >
            <option value="square">Square (1:1)</option>
            <option value="16:9">Wallpaper (16:9)</option>
            <option value="9:16">Phone (9:16)</option>
            <option value="12:18">Poster (12:18)</option>
          </select>
        </label>
      )}
    </Section>
  );
}

export function SeedPaletteSection({
  params,
  update,
  allPalettes,
  allPaletteNames,
  onSavePalette,
  onDeletePalette,
}: {
  params: StyleParams;
  update: ParamsUpdate;
  allPalettes: Record<string, Palette>;
  allPaletteNames: Record<string, string>;
  onSavePalette: (id: string, name: string, palette: Palette) => void;
  onDeletePalette: (id: string) => void;
}) {
  return (
    <Section title="Seed & Palette" defaultOpen={false}>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
        Seed
        <div className="flex gap-2">
          <input
            type="text"
            value={params.seed}
            onChange={(e) => update({ seed: e.target.value })}
            className={`${textInputClass} min-w-0 flex-1 font-mono text-[12px]`}
          />
          <button
            type="button"
            onClick={() => update({ seed: Math.random().toString(36).slice(2, 8) })}
            className="flex min-h-11 w-11 items-center justify-center rounded-sm border border-hairline-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            title="Randomize seed"
            aria-label="Randomize seed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </button>
        </div>
      </label>

      <PalettePicker
        selectedId={params.palette}
        allPalettes={allPalettes}
        allPaletteNames={allPaletteNames}
        onSelect={(palette) => update({ palette })}
        onSavePalette={onSavePalette}
        onDeletePalette={onDeletePalette}
      />
    </Section>
  );
}

function formatCacheSize(stats: CacheStats | null): string {
  if (!stats) return "";
  const mb = stats.approxBytes / (1024 * 1024);
  return mb < 1 ? "<1 MB" : `~${Math.round(mb)} MB`;
}

/** DATA section: one-line credits + the cache footprint / clear control. */
export function DataSection() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    void cacheStats().then((s) => setStats(s ?? null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    await clearCache();
    refresh();
    setClearing(false);
  }, [refresh]);

  const cached = formatCacheSize(stats);

  return (
    <Section title="Data" defaultOpen={true}>
      <p className="text-[12px] leading-relaxed text-ink-faint">
        Basemap ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-hairline-2 underline-offset-2 transition-colors hover:text-ink-muted"
        >
          OpenStreetMap contributors
        </a>{" "}
        · OpenFreeMap. Terrain:{" "}
        <a
          href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-hairline-2 underline-offset-2 transition-colors hover:text-ink-muted"
        >
          Mapzen/AWS Open Data
        </a>{" "}
        — USGS, NASA SRTM.
      </p>
      <button
        type="button"
        onClick={handleClear}
        disabled={clearing}
        className="flex min-h-11 items-center justify-between rounded-sm border border-transparent px-3 text-[13px] text-ink-muted transition-colors hover:border-hairline hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        <span>{clearing ? "Clearing…" : "Clear cached map data"}</span>
        {cached && (
          <span className="font-mono text-[12px] tabular-nums text-ink-faint">
            {cached} cached
          </span>
        )}
      </button>
    </Section>
  );
}
