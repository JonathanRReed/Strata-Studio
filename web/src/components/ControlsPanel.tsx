import { useState, useEffect } from "react";
import type { Palette, StyleParams, MaskMode, AspectRatio, Studio, ControlKey, AnimationMode } from "../engine/types.ts";
import { presets, type Preset } from "../presets/stylePresets.ts";
import { stylesByStudio, getStyle } from "../studios/registry.ts";
import { PalettePicker } from "./PalettePicker.tsx";

type Props = {
  params: StyleParams;
  styleId: string;
  onChange: (params: StyleParams) => void;
  onStyleChange: (styleId: string) => void;
  onApplyPreset: (preset: Preset) => void;
  onGenerate: () => void;
  onExportPng: (size: number) => void;
  onExportSvg: (size: number) => void;
  onExportAnimation: (format: "gif" | "apng" | "webm") => void;
  onFetchFeatures: (isRetry?: boolean) => void;
  onExportJson: () => void;
  onCopyUrl: () => void;
  copiedUrl: boolean;
  isLoading: boolean;
  isFeatureLoading: boolean;
  isExportingAnimation: boolean;
  animationProgress: { progress: number; status: string } | null;
  featureInfo: string | null;
  hasFeatures: boolean;
  osmAreaHint?: string | null;
  allPalettes: Record<string, Palette>;
  allPaletteNames: Record<string, string>;
  onSavePalette: (id: string, name: string, palette: Palette) => void;
  onDeletePalette: (id: string) => void;
  isAnimating: boolean;
  onToggleAnimation: () => void;
};

const MASK_MODE_DESCRIPTIONS: Record<MaskMode, string> = {
  interrupt: "Breaks terrain lines where this feature is present",
  amplify: "Makes terrain displacement larger over this feature",
  flatten: "Damps terrain displacement toward zero over this feature",
  glow: "Highlights terrain lines over this feature in accent color",
};

const ANIMATION_MODE_DESCRIPTIONS: Record<AnimationMode, string> = {
  none: "Static artwork",
  drift: "Noise field scrolls over time — organic breathing motion",
  draw: "Lines draw themselves in stroke by stroke, then loop",
  parallax: "Depth layers separate and drift at different speeds",
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  tooltip,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  tooltip?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-white/80">
      <span className="flex justify-between items-center">
        <span className="flex items-center gap-1">
          {label}
          {tooltip && <InfoDot text={tooltip} />}
        </span>
        <span className="text-white/50 tabular-nums" aria-live="polite">
          {value.toFixed(step < 1 ? 2 : 0)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-white"
      />
    </label>
  );
}

function InfoDot({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex">
      <span className="w-3.5 h-3.5 rounded-full bg-white/10 text-white/40 text-[9px] flex items-center justify-center cursor-help select-none">
        ?
      </span>
      <span className="absolute left-5 top-0 z-50 hidden group-hover:block bg-black border border-white/20 rounded px-2 py-1.5 text-[10px] text-white/70 leading-snug w-48 shadow-lg">
        {text}
      </span>
    </span>
  );
}

function ModeSelector({
  label,
  value,
  onChange,
  tooltip,
}: {
  label: string;
  value: MaskMode;
  onChange: (v: MaskMode) => void;
  tooltip?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-white/80">
      <span className="flex items-center gap-1">
        {label}
        {tooltip && <InfoDot text={tooltip} />}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as MaskMode)}
        className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
      >
        <option value="interrupt" className="bg-neutral-900">Interrupt</option>
        <option value="amplify" className="bg-neutral-900">Amplify</option>
        <option value="flatten" className="bg-neutral-900">Flatten</option>
        <option value="glow" className="bg-neutral-900">Glow</option>
      </select>
    </label>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Sync with defaultOpen when it changes (e.g., when OSM features load or animation mode changes)
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-white/40 hover:text-white/60 transition-colors"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge && <span className="text-[9px] text-green-400/60 normal-case tracking-normal">{badge}</span>}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

export function ControlsPanel({
  params,
  styleId,
  onChange,
  onStyleChange,
  onApplyPreset,
  onGenerate,
  onExportPng,
  onExportSvg,
  onExportAnimation,
  onFetchFeatures,
  onExportJson,
  onCopyUrl,
  copiedUrl,
  isLoading,
  isFeatureLoading,
  isExportingAnimation,
  animationProgress,
  featureInfo,
  hasFeatures,
  osmAreaHint,
  allPalettes,
  allPaletteNames,
  onSavePalette,
  onDeletePalette,
  isAnimating,
  onToggleAnimation,
}: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showPerTypeWater, setShowPerTypeWater] = useState(false);
  const update = (patch: Partial<StyleParams>) => {
    onChange({ ...params, ...patch });
  };

  const activeStyle = getStyle(styleId);
  const studio: Studio = activeStyle.studio;
  const controls = new Set<ControlKey>(activeStyle.controls ?? [
    "amplitude", "spacing", "lineWidth", "noise", "detail", "compression",
    "occlusion", "grain", "rotation", "label", "aspectRatio", "seed", "palette",
    "buildingInfluence", "roadInfluence", "waterInfluence",
    "oceanInfluence", "lakeInfluence", "riverInfluence",
  ]);
  const hasFeatureControls =
    controls.has("buildingInfluence") || controls.has("roadInfluence") || controls.has("waterInfluence") ||
    controls.has("oceanInfluence") || controls.has("lakeInfluence") || controls.has("riverInfluence");
  const hasAnySlider = ["amplitude", "spacing", "lineWidth", "noise", "detail", "compression", "occlusion"].some((k) => controls.has(k as ControlKey));

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-expanded={mobileOpen}
        aria-controls="controls-panel"
        aria-label="Toggle controls panel"
        className="lg:hidden fixed top-3 right-3 z-50 px-4 py-2.5 min-h-[44px] bg-white text-black rounded text-xs font-medium"
      >
        {mobileOpen ? "Close" : "Controls"}
      </button>

      <div
        id="controls-panel"
        className={`${
          mobileOpen ? "flex" : "hidden lg:flex"
        } flex-col gap-4 p-5 w-full max-w-xs border-r border-white/10 bg-black/40 h-full overflow-y-auto`}
      >
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Strata Studio</h1>
          <p className="text-xs text-white/50 mt-1">
            {studio === "classic" ? "Classic Studio" : "Experimental Lab"} / {activeStyle.name}
          </p>
          <p className="text-[11px] text-white/30 mt-1.5 leading-snug">
            {studio === "classic"
              ? "Polished cartographic poster styles for printing and sharing."
              : "Terrain-driven waveform and noise art. A visual synth for places."}
          </p>
        </div>

        {/* Style & Presets */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-1 p-1 bg-white/5 rounded-lg" role="tablist" aria-label="Studio">
            {(["classic", "experimental"] as Studio[]).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={studio === s}
                onClick={() => {
                  if (studio !== s) onStyleChange(stylesByStudio[s][0].id);
                }}
                className={`py-1.5 text-xs rounded-md transition-colors ${
                  studio === s
                    ? "bg-white text-black font-medium"
                    : "text-white/60 hover:text-white"
                }`}
              >
                {s === "classic" ? "Classic Studio" : "Experimental Lab"}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {stylesByStudio[studio].map((style) => (
              <button
                key={style.id}
                type="button"
                onClick={() => onStyleChange(style.id)}
                title={style.description}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  style.id === styleId
                    ? "border-white bg-white text-black font-medium"
                    : "border-white/20 hover:bg-white/10"
                }`}
              >
                {style.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/40 leading-snug">{activeStyle.description}</p>
        </div>

        {/* Presets */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-white/40">
            Presets
          </span>
          <div className="flex flex-wrap gap-2">
            {presets
              .filter((p) => getStyle(p.styleId).studio === studio)
              .map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onApplyPreset(preset)}
                  className="px-2.5 py-1 text-xs rounded-full border border-white/20 hover:bg-white/10 transition-colors"
                >
                  {preset.name}
                </button>
              ))}
          </div>
        </div>

        {/* Terrain sliders */}
        {hasAnySlider && (
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
        )}

        {/* Map Features / Feature Influence */}
        <Section
          title={hasFeatureControls ? "Feature influence" : "Map features"}
          defaultOpen={hasFeatures}
          badge={hasFeatures ? "OSM loaded" : undefined}
        >
          <button
            type="button"
            onClick={() => onFetchFeatures(false)}
            disabled={isFeatureLoading}
            className="px-3 py-2 text-xs rounded border border-white/20 hover:bg-white/10 disabled:opacity-50 transition-colors"
          >
            {isFeatureLoading
              ? "Fetching OSM data..."
              : hasFeatures
                ? "Re-fetch OSM features"
                : "Fetch OSM features (buildings, roads, water)"}
          </button>
          {featureInfo && (
            <p role="status" className="text-xs text-green-400/80">{featureInfo}</p>
          )}
          {osmAreaHint && !featureInfo && (
            <p className="text-xs text-yellow-400/60">{osmAreaHint}</p>
          )}

          {hasFeatureControls && (
          <div className="flex flex-col gap-3 pl-2 border-l border-white/10">
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
                  className="text-[10px] text-white/40 hover:text-white/60 transition-colors text-left"
                >
                  {showPerTypeWater ? "− Hide per-type water" : "+ Per-type water (ocean / lake / river)"}
                </button>
                {showPerTypeWater && (
                  <div className="flex flex-col gap-3 pl-2 border-l border-white/10">
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

        {/* Animation */}
        <Section title="Animation" defaultOpen={params.animationMode !== "none"}>
          <label className="flex flex-col gap-1.5 text-sm text-white/80">
            <span className="flex items-center gap-1">
              Animation style
              <InfoDot text="Add motion to your artwork. Drift breathes, draw reveals lines stroke by stroke, parallax separates depth layers." />
            </span>
            <select
              value={params.animationMode}
              onChange={(e) => update({ animationMode: e.target.value as AnimationMode })}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
            >
              <option value="none" className="bg-neutral-900">None (static)</option>
              <option value="drift" className="bg-neutral-900">Drift — organic breathing</option>
              <option value="draw" className="bg-neutral-900">Draw-in — stroke reveal</option>
              <option value="parallax" className="bg-neutral-900">Parallax — depth layers</option>
            </select>
          </label>
          {params.animationMode !== "none" && (
            <>
              <p className="text-[10px] text-white/40 leading-snug">
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
                className={`px-3 py-2 text-xs rounded font-medium transition-colors ${
                  isAnimating
                    ? "bg-white/20 text-white border border-white/30"
                    : "bg-white text-black hover:bg-white/90"
                }`}
              >
                {isAnimating ? "⏸ Pause preview" : "▶ Play preview"}
              </button>
            </>
          )}
        </Section>

        {/* Composition */}
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
            <label className="flex flex-col gap-1.5 text-sm text-white/80">
              Label
              <input
                type="text"
                value={params.label}
                onChange={(e) => update({ label: e.target.value })}
                placeholder="Optional place name"
                className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
              />
            </label>
          )}
          {controls.has("aspectRatio") && (
            <label className="flex flex-col gap-1.5 text-sm text-white/80">
              Aspect ratio
              <select
                value={params.aspectRatio}
                onChange={(e) => update({ aspectRatio: e.target.value as AspectRatio })}
                className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
              >
                <option value="square" className="bg-neutral-900">Square (1:1)</option>
                <option value="16:9" className="bg-neutral-900">Wallpaper (16:9)</option>
                <option value="9:16" className="bg-neutral-900">Phone (9:16)</option>
                <option value="12:18" className="bg-neutral-900">Poster (12:18)</option>
              </select>
            </label>
          )}
        </Section>

        {/* Seed & Palette */}
        <Section title="Seed & Palette" defaultOpen={false}>
          <label className="flex flex-col gap-1.5 text-sm text-white/80">
            Seed
            <div className="flex gap-2">
              <input
                type="text"
                value={params.seed}
                onChange={(e) => update({ seed: e.target.value })}
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
              />
              <button
                type="button"
                onClick={() => update({ seed: Math.random().toString(36).slice(2, 8) })}
                className="px-3 py-1.5 text-xs rounded border border-white/20 hover:bg-white/10 transition-colors"
                title="Randomize seed"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

        {/* Export */}
        <div className="flex flex-col gap-2 mt-auto">
          <button
            type="button"
            onClick={onGenerate}
            disabled={isLoading || isExportingAnimation}
            aria-busy={isLoading}
            className="w-full py-2.5 min-h-[44px] bg-white text-black rounded font-medium text-sm hover:bg-white/90 disabled:opacity-50 transition-colors"
          >
            {isLoading ? "Generating..." : "Generate"}
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onExportJson}
              disabled={isExportingAnimation}
              className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={onCopyUrl}
              disabled={isExportingAnimation}
              className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
            >
              {copiedUrl ? "Copied!" : "Copy URL"}
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-white/40">Export PNG</span>
            <div className="flex gap-2">
              {[1024, 2048, 3000].map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => onExportPng(size)}
                  disabled={isLoading}
                  className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  {size}²
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-white/40">Export SVG</span>
            <div className="flex gap-2">
              {[1024, 2048, 3000].map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => onExportSvg(size)}
                  disabled={isLoading}
                  className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  {size}²
                </button>
              ))}
            </div>
          </div>

          {/* Animation export */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-white/40 flex items-center gap-1">
              Export animation
              <InfoDot text="Renders all frames and encodes a looping animation. GIF is universal, APNG has better quality + transparency, WebM is smallest for video." />
            </span>
            {isExportingAnimation && animationProgress && (
              <div className="flex flex-col gap-1">
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-all"
                    style={{ width: `${Math.round(animationProgress.progress * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-white/50">{animationProgress.status}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onExportAnimation("gif")}
                disabled={isLoading || isExportingAnimation || params.animationMode === "none"}
                className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
              >
                GIF
              </button>
              <button
                type="button"
                onClick={() => onExportAnimation("apng")}
                disabled={isLoading || isExportingAnimation || params.animationMode === "none"}
                className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
              >
                APNG
              </button>
              <button
                type="button"
                onClick={() => onExportAnimation("webm")}
                disabled={isLoading || isExportingAnimation || params.animationMode === "none"}
                className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
              >
                WebM
              </button>
            </div>
          </div>
        </div>

        <details className="text-xs text-white/40">
          <summary className="cursor-pointer hover:text-white/60 transition-colors">
            Credits
          </summary>
          <p className="mt-2">
            Map data &copy;{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/60"
            >
              OpenStreetMap contributors
            </a>
            . Terrain tiles from Mapzen / AWS Open Data; see{" "}
            <a
              href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/60"
            >
              attribution
            </a>{" "}
            for data sources.
          </p>
        </details>
      </div>
    </>
  );
}
