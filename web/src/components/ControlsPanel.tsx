import { useState } from "react";
import type { StyleParams, MaskMode, AspectRatio, Studio, ControlKey } from "../engine/types.ts";
import { presets, type Preset } from "../presets/stylePresets.ts";
import { palettes, paletteNames } from "../presets/palettes.ts";
import { stylesByStudio, getStyle } from "../studios/registry.ts";

type Props = {
  params: StyleParams;
  styleId: string;
  onChange: (params: StyleParams) => void;
  onStyleChange: (styleId: string) => void;
  onApplyPreset: (preset: Preset) => void;
  onGenerate: () => void;
  onExportPng: (size: number) => void;
  onExportSvg: (size: number) => void;
  onFetchFeatures: (isRetry?: boolean) => void;
  onExportJson: () => void;
  onCopyUrl: () => void;
  copiedUrl: boolean;
  isLoading: boolean;
  isFeatureLoading: boolean;
  featureInfo: string | null;
  hasFeatures: boolean;
  osmAreaHint?: string | null;
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-white/80">
      <span className="flex justify-between">
        {label}
        <span className="text-white/50 tabular-nums" aria-live="polite">
          {value.toFixed(2)}
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

function ModeSelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MaskMode;
  onChange: (v: MaskMode) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-white/80">
      {label}
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

export function ControlsPanel({
  params,
  styleId,
  onChange,
  onStyleChange,
  onApplyPreset,
  onGenerate,
  onExportPng,
  onExportSvg,
  onFetchFeatures,
  onExportJson,
  onCopyUrl,
  copiedUrl,
  isLoading,
  isFeatureLoading,
  featureInfo,
  hasFeatures,
  osmAreaHint,
}: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const update = (patch: Partial<StyleParams>) => {
    onChange({ ...params, ...patch });
  };

  const activeStyle = getStyle(styleId);
  const studio: Studio = activeStyle.studio;
  const controls = new Set<ControlKey>(activeStyle.controls ?? [
    "amplitude", "spacing", "lineWidth", "noise", "detail", "compression",
    "occlusion", "grain", "rotation", "label", "aspectRatio", "seed", "palette",
    "buildingInfluence", "roadInfluence", "waterInfluence",
  ]);
  const hasFeatureControls = controls.has("buildingInfluence") || controls.has("roadInfluence") || controls.has("waterInfluence");
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
        } flex-col gap-5 p-5 w-full max-w-xs border-r border-white/10 bg-black/40 h-full overflow-y-auto`}
      >
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

        {hasAnySlider && (
        <div className="flex flex-col gap-4">
          {controls.has("amplitude") && (
            <Slider
              label="Amplitude"
              value={params.amplitude}
              min={0}
              max={120}
              step={1}
              onChange={(v) => update({ amplitude: v })}
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
            />
          )}
        </div>
        )}

        {hasFeatureControls && (
        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-white/40">
            Feature influence
          </span>
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

          <div className="flex flex-col gap-3 pl-2 border-l border-white/10">
            {controls.has("buildingInfluence") && (
              <>
                <Slider
                  label="Building influence"
                  value={params.buildingInfluence}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(v) => update({ buildingInfluence: v })}
                />
                <ModeSelector
                  label="Building mode"
                  value={params.buildingMode}
                  onChange={(v) => update({ buildingMode: v })}
                />
              </>
            )}
            {controls.has("roadInfluence") && (
              <>
                <Slider
                  label="Road influence"
                  value={params.roadInfluence}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(v) => update({ roadInfluence: v })}
                />
                <ModeSelector
                  label="Road mode"
                  value={params.roadMode}
                  onChange={(v) => update({ roadMode: v })}
                />
              </>
            )}
            {controls.has("waterInfluence") && (
              <>
                <Slider
                  label="Water influence"
                  value={params.waterInfluence}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(v) => update({ waterInfluence: v })}
                />
                <ModeSelector
                  label="Water mode"
                  value={params.waterMode}
                  onChange={(v) => update({ waterMode: v })}
                />
              </>
            )}
          </div>
        </div>
        )}

        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-white/40">
            Composition
          </span>

          {controls.has("grain") && (
            <Slider
              label="Grain"
              value={params.grain}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => update({ grain: v })}
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
        </div>

        <div className="flex flex-col gap-3">
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

          <label className="flex flex-col gap-1.5 text-sm text-white/80">
            Palette
            <select
              value={params.palette}
              onChange={(e) => update({ palette: e.target.value })}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-white/30"
            >
              {Object.keys(palettes).map((key) => (
                <option key={key} value={key} className="bg-neutral-900">
                  {paletteNames[key] ?? key}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-col gap-2 mt-auto">
          <button
            type="button"
            onClick={onGenerate}
            disabled={isLoading}
            aria-busy={isLoading}
            className="w-full py-2.5 min-h-[44px] bg-white text-black rounded font-medium text-sm hover:bg-white/90 disabled:opacity-50 transition-colors"
          >
            {isLoading ? "Generating..." : "Generate"}
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onExportJson}
              disabled={isLoading}
              className="flex-1 py-2 min-h-[40px] border border-white/20 rounded text-xs hover:bg-white/10 disabled:opacity-50 transition-colors"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={onCopyUrl}
              disabled={isLoading}
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
