import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GeoBounds } from "../engine/types.ts";
import { getStyle } from "../studios/registry.ts";
import { bboxAreaKm2, isBboxSmallEnough } from "../data/osmOverpass.ts";
import { CURATED_PLACES, surprisePlace, type CuratedPlace } from "../data/places.ts";
import type { ControlsPanelProps } from "./ControlsPanel.tsx";
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

type SheetSnap = "collapsed" | "half" | "full";
type SheetTab = "place" | "style" | "export";

const TABS: { id: SheetTab; label: string }[] = [
  { id: "place", label: "Place" },
  { id: "style", label: "Style" },
  { id: "export", label: "Export" },
];

/** Fast-flick threshold (px/ms) that skips the nearest snap in the flick direction. */
const FLICK_VELOCITY = 0.5;
/** Pointer travel (px) before a handle press counts as a drag instead of a tap. */
const DRAG_SLOP = 4;

/** Instrument readout formatting: real minus sign, fixed decimals. */
function fmtDeg(value: number): string {
  return value.toFixed(4).replace(/-/g, "−");
}

type DragState = {
  pointerId: number;
  startY: number;
  startTranslate: number;
  sheetH: number;
  maxTranslate: number;
  moved: boolean;
  lastY: number;
  lastT: number;
  velocity: number;
};

type Props = ControlsPanelProps & {
  /** Current selection, for the PLACE tab readout. */
  bounds: GeoBounds;
  mapZoom: number;
  activePlaceId: string | null;
  /** Place chosen from the sheet — the parent flies the map + applies the preset. */
  onSelectPlace: (place: CuratedPlace) => void;
  /** Opens the fullscreen map viewfinder overlay (search + places live there too). */
  onOpenMap: (opener?: HTMLElement) => void;
  onCopyUrl: () => void;
  copiedUrl: boolean;
  /** While the map overlay is open it owns the Escape key. */
  mapExpanded: boolean;
  /** Opens the variations overlay (STYLE tab); disabled until terrain exists. */
  onOpenVariations: () => void;
  variationsReady: boolean;
  /** Native share (EXPORT tab); the button is hidden where unsupported. */
  onShare: () => void;
  shareSupported: boolean;
  /** Incremented by the orientation CTA to open and focus the Style tab. */
  customizeRequest: number;
  /** Lets the stage become inert while the full-height sheet is modal. */
  onModalStateChange: (modal: boolean) => void;
};

/**
 * Mobile bottom sheet (below lg): the artwork owns the screen; controls live
 * here in three tabs — PLACE / STYLE / EXPORT — with three snap states:
 * collapsed (grab handle + tab bar + sticky Generate, ≈130px), half (45svh,
 * artwork still visible), full (90svh, deep parameter work, dialog + backdrop).
 * Renders the same section components as the desktop ControlsPanel rail.
 */
export function MobileSheet({
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
  featureError,
  hasFeatures,
  osmAreaHint,
  terrainGrid,
  allPalettes,
  allPaletteNames,
  onSavePalette,
  onDeletePalette,
  isAnimating,
  onToggleAnimation,
  bounds,
  mapZoom,
  activePlaceId,
  onSelectPlace,
  onOpenMap,
  onCopyUrl,
  copiedUrl,
  mapExpanded,
  onOpenVariations,
  variationsReady,
  onShare,
  shareSupported,
  customizeRequest,
  onModalStateChange,
}: Props) {
  const [snap, setSnap] = useState<SheetSnap>("collapsed");
  const [tab, setTab] = useState<SheetTab>("style");
  /** Live translateY (px) while dragging; null = resting on a snap point. */
  const [dragY, setDragY] = useState<number | null>(null);

  const sheetRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);
  /** Survives until the click event that follows a drag so it isn't a toggle. */
  const dragConsumedClickRef = useRef(false);

  useEffect(() => {
    if (customizeRequest === 0) return;
    setTab("style");
    setSnap("half");
    window.requestAnimationFrame(() => tabRefs.current[1]?.focus());
  }, [customizeRequest]);

  useEffect(() => {
    onModalStateChange(snap === "full");
  }, [onModalStateChange, snap]);
  useEffect(() => () => onModalStateChange(false), [onModalStateChange]);

  const update = (patch: Partial<typeof params>) => {
    onChange({ ...params, ...patch });
  };
  const activeStyle = getStyle(styleId);
  const studio = activeStyle.studio;
  const controls = buildControlSet(activeStyle.controls);

  // ——— Sheet position ———
  const transform =
    dragY !== null
      ? `translate3d(0, ${dragY}px, 0)`
      : snap === "full"
        ? "translate3d(0, 0, 0)"
        : snap === "half"
          ? "translate3d(0, 45svh, 0)"
          : "translate3d(0, calc(90svh - var(--sheet-peek)), 0)";

  // ——— Drag on the grab handle (pointer events; snap with velocity bias) ———
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const sheet = sheetRef.current;
    const chrome = chromeRef.current;
    if (!sheet || !chrome) return;
    const sheetH = sheet.offsetHeight;
    const peek = chrome.offsetHeight + 1; // + the sheet's top border
    const baseTop = window.innerHeight - sheetH;
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startTranslate: sheet.getBoundingClientRect().top - baseTop,
      sheetH,
      maxTranslate: Math.max(0, sheetH - peek),
      moved: false,
      lastY: e.clientY,
      lastT: e.timeStamp,
      velocity: 0,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone (or synthetic) — the drag still tracks via bubbling.
    }
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) <= DRAG_SLOP) return;
    d.moved = true;
    dragConsumedClickRef.current = true;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    setDragY(Math.min(Math.max(d.startTranslate + dy, 0), d.maxTranslate));
  };

  const onHandlePointerEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (!d.moved) return; // plain tap → the click handler toggles
    const translate = Math.min(
      Math.max(d.startTranslate + (e.clientY - d.startY), 0),
      d.maxTranslate,
    );
    const snaps: [SheetSnap, number][] = [
      ["full", 0],
      ["half", Math.max(0, d.sheetH - window.innerHeight * 0.45)],
      ["collapsed", d.maxTranslate],
    ];
    let next: SheetSnap;
    if (d.velocity > FLICK_VELOCITY) {
      // Fast flick down → nearest snap below the release point.
      const below = snaps.filter(([, t]) => t > translate + 1).sort((a, b) => a[1] - b[1]);
      next = below[0]?.[0] ?? "collapsed";
    } else if (d.velocity < -FLICK_VELOCITY) {
      const above = snaps.filter(([, t]) => t < translate - 1).sort((a, b) => b[1] - a[1]);
      next = above[0]?.[0] ?? "full";
    } else {
      next = snaps.sort(
        (a, b) => Math.abs(a[1] - translate) - Math.abs(b[1] - translate),
      )[0][0];
    }
    setSnap(next);
    setDragY(null);
  };

  const onHandleClick = () => {
    if (dragConsumedClickRef.current) {
      dragConsumedClickRef.current = false;
      return;
    }
    setSnap((s) => (s === "collapsed" ? "half" : s === "full" ? "half" : "collapsed"));
  };

  // ——— Tabs: proper tablist with arrow keys (studio-switcher pattern) ———
  const selectTab = (next: SheetTab) => {
    setTab(next);
    setSnap((s) => (s === "collapsed" ? "half" : s));
  };

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = TABS.findIndex((t) => t.id === tab);
    const next = (current + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    selectTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  // ——— Esc collapses full → half (unless the map overlay or a dialog owns it) ———
  useEffect(() => {
    if (snap !== "full" || mapExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest("dialog")) return;
      setSnap("half");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, mapExpanded]);

  // ——— Focus trap only at full (the sheet is a dialog there) ———
  useEffect(() => {
    if (snap !== "full") return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    sheet.addEventListener("keydown", onKey);
    return () => sheet.removeEventListener("keydown", onKey);
  }, [snap]);

  const handleOpenMap = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // Drop to collapsed so the artwork + map are what's on screen when the
    // fullscreen viewfinder closes again. Restore focus to the still-visible
    // handle rather than the clicked control inside the now-inert sheet body.
    setSnap("collapsed");
    onModalStateChange(false);
    onOpenMap(handleRef.current ?? event.currentTarget);
  };

  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const areaKm2 = bboxAreaKm2(bounds);
  const osmEligible = isBboxSmallEnough(bounds);
  const isFull = snap === "full";

  return (
    <>
      {/* Backdrop — full only; tap returns to half. */}
      {isFull && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-ground/60"
          onClick={() => setSnap("half")}
        />
      )}
      <section
        ref={sheetRef}
        inert={mapExpanded ? true : undefined}
        role={isFull ? "dialog" : undefined}
        aria-modal={isFull || undefined}
        aria-label="Artwork controls"
        className="fixed inset-x-0 bottom-0 z-30 flex h-[90svh] flex-col rounded-t-md border-t border-hairline bg-surface shadow-[0_-12px_48px_rgba(0,0,0,0.55)] transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none"
        style={{
          transform,
          ...(dragY !== null ? { transitionProperty: "none" } : {}),
        }}
      >
        {/* Sheet chrome: grab handle + tab bar + sticky Generate. Always visible. */}
        <div ref={chromeRef} className="shrink-0">
          <button
            ref={handleRef}
            type="button"
            aria-expanded={snap !== "collapsed"}
            aria-controls="mobile-sheet-body"
            aria-label={snap === "collapsed" ? "Open controls" : "Collapse controls"}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerEnd}
            onPointerCancel={onHandlePointerEnd}
            onClick={onHandleClick}
            className="flex h-6 w-full touch-none items-center justify-center"
          >
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-hairline-2" />
          </button>
          <div role="tablist" aria-label="Controls" className="grid grid-cols-3 border-b border-hairline">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`sheet-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`sheet-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onKeyDown={onTabKeyDown}
                onClick={() => selectTab(t.id)}
                className={`instrument-label flex h-11 items-center justify-center border-b-2 transition-colors ${
                  tab === t.id
                    ? "border-signal bg-surface-2 text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="px-4 py-2">
            <button
              type="button"
              onClick={onGenerate}
              disabled={isLoading || isExporting || isExportingAnimation}
              aria-busy={isLoading}
              className={primaryButtonClass}
            >
              {isLoading ? <span className="status-live">Regenerating…</span> : "Regenerate now"}
            </button>
          </div>
          <div aria-hidden="true" className="h-[env(safe-area-inset-bottom,0px)]" />
        </div>

        {/* Scrollable tab panels (inert while collapsed — offscreen). */}
        <div
          id="mobile-sheet-body"
          inert={snap === "collapsed" ? true : undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-10"
        >
          {tab === "place" && (
            <div
              role="tabpanel"
              id="sheet-panel-place"
              aria-labelledby="sheet-tab-place"
              className="flex flex-col gap-3 pt-3"
            >
              <p className="instrument-label text-ink-muted">
                {fmtDeg(centerLat)} {fmtDeg(centerLng)} · Z{Math.round(mapZoom)} ·{" "}
                <span className={osmEligible ? "text-ok" : "text-ink-faint"}>
                  {areaKm2.toFixed(1)} KM²
                </span>
              </p>
              <button type="button" onClick={handleOpenMap} className={secondaryButtonClass}>
                Choose area on map — search & pan
              </button>
              <button
                type="button"
                onClick={() => onSelectPlace(surprisePlace(activePlaceId ?? undefined))}
                className={secondaryButtonClass}
              >
                <span aria-hidden="true" className="mr-2 text-[17px]">⚄</span>
                Surprise me
              </button>
              <div role="group" aria-label="Curated places" className="grid grid-cols-2 gap-1.5">
                {CURATED_PLACES.map((place) => {
                  const active = place.id === activePlaceId;
                  return (
                    <button
                      key={place.id}
                      type="button"
                      onClick={() => onSelectPlace(place)}
                      aria-pressed={active}
                      title={place.blurb}
                      className={`flex min-h-11 flex-col items-start justify-center rounded-sm border bg-surface px-3 py-1.5 text-left transition-colors ${
                        active
                          ? "border-signal"
                          : "border-hairline hover:border-hairline-2 hover:bg-surface-2"
                      }`}
                    >
                      <span className="instrument-label text-ink">{place.name}</span>
                      <span className="instrument-label text-ink-faint">{place.region}</span>
                    </button>
                  );
                })}
              </div>
              <DataSection />
            </div>
          )}

          {tab === "style" && (
            <div
              role="tabpanel"
              id="sheet-panel-style"
              aria-labelledby="sheet-tab-style"
              className="pt-3"
            >
              <StudioSwitcher className="mb-1" studio={studio} onStyleChange={onStyleChange} />
              <button
                type="button"
                onClick={onOpenVariations}
                disabled={!variationsReady}
                className={`${secondaryButtonClass} mt-3 w-full`}
              >
                Variations — 4 fresh seeds
              </button>
              <StyleSection
                studio={studio}
                styleId={styleId}
                onStyleChange={onStyleChange}
                terrainGrid={terrainGrid}
              />
              <PresetsSection
                studio={studio}
                onApplyPreset={onApplyPreset}
                terrainGrid={terrainGrid}
              />
              <TerrainSection params={params} controls={controls} update={update} />
              <FeaturesSection
                params={params}
                controls={controls}
                update={update}
                onFetchFeatures={onFetchFeatures}
                isFeatureLoading={isFeatureLoading}
                featureInfo={featureInfo}
                featureError={featureError}
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
            </div>
          )}

          {tab === "export" && (
            <div
              role="tabpanel"
              id="sheet-panel-export"
              aria-labelledby="sheet-tab-export"
              className="flex flex-col gap-3 pt-3"
            >
              <button type="button" onClick={onOpenExport} className={secondaryButtonClass}>
                Export… PNG · SVG · animation
              </button>
              {shareSupported && (
                <button type="button" onClick={onShare} className={secondaryButtonClass}>
                  Share…
                </button>
              )}
              <button type="button" onClick={onCopyUrl} className={secondaryButtonClass}>
                {copiedUrl ? "Link copied" : "Copy share link"}
              </button>
              <p className="text-[12px] leading-snug text-ink-faint">
                Exports are WYSIWYG: the console renders the exact artwork above at print
                and screen sizes. The share link restores this place, style and seed.
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
