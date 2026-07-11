import { useEffect, useId, useRef, useState } from "react";
import type { AnimationFormat } from "../engine/animationExport.ts";
import type { AnimationExportStatus, ExportStatus } from "../app/status.ts";

type ExportFormat = "png" | "svg" | "animation";
type ExportSize = 1024 | 2048 | 3000;

type Props = {
  open: boolean;
  onClose: () => void;
  /** dpi, when set, is written into the PNG as a pHYs chunk for true-size prints. */
  onExportPng: (size: number, dpi?: number) => void;
  onExportSvg: (size: number) => void;
  onExportAnimation: (format: AnimationFormat) => void;
  onExportJson: () => void;
  onCopyUrl: () => void;
  copiedUrl: boolean;
  exportStatus: ExportStatus;
  animationStatus: AnimationExportStatus;
  isExporting: boolean;
  isExportingAnimation: boolean;
  /** False when animationMode is "none" (animation export needs a mode). */
  animationAvailable: boolean;
  onDismissErrors: () => void;
};

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
  { value: "animation", label: "Animation" },
];

/**
 * Print-truth inch figure for a size row: the export's long edge is always
 * exactly `size` pixels (getExportDimensions pins the long side), so
 * size/dpi is the long-edge print size for EVERY aspect ratio. The dialog
 * deliberately labels only the long edge: it doesn't receive the current
 * aspect ratio (App owns the dialog and its props), and the long edge is the
 * one figure that stays honest across square/16:9/9:16/12:18.
 */
function longEdgeInches(size: number, dpi: number): string {
  const inches = size / dpi;
  return Number.isInteger(inches) ? String(inches) : inches.toFixed(1);
}

const PNG_SIZES: { value: ExportSize; desc: string; dpi?: number }[] = [
  { value: 1024, desc: "screens & social" },
  {
    value: 2048,
    dpi: 300,
    desc: `wallpaper & social · 300 DPI ≈ ${longEdgeInches(2048, 300)} in long edge`,
  },
  {
    value: 3000,
    dpi: 250,
    desc: `print · 250 DPI ≈ ${longEdgeInches(3000, 250)} in long edge`,
  },
];

const SVG_DESC = "vector — plotter & print-shop ready";

const ANIM_FORMATS: { value: AnimationFormat; label: string; desc: string }[] = [
  { value: "gif", label: "GIF", desc: "512 — universal short loop" },
  { value: "apng", label: "APNG", desc: "512 — high-quality short loop" },
  { value: "webm", label: "WEBM", desc: "512 — smallest short loop" },
];

const optionRowClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border border-hairline px-3 py-2 transition-colors hover:border-hairline-2 peer-checked:border-signal peer-checked:bg-surface-2 peer-focus-visible:ring-2 peer-focus-visible:ring-signal";

const shareButtonClass =
  "flex min-h-11 flex-1 items-center justify-center rounded-sm border border-hairline-2 px-3 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50";

/**
 * The export console: format + destination-named size choices, one signal
 * primary, live progress from the export status channels, and the share row.
 * Built on native <dialog> for the focus trap / Esc / top-layer semantics.
 */
export function ExportDialog({
  open,
  onClose,
  onExportPng,
  onExportSvg,
  onExportAnimation,
  onExportJson,
  onCopyUrl,
  copiedUrl,
  exportStatus,
  animationStatus,
  isExporting,
  isExportingAnimation,
  animationAvailable,
  onDismissErrors,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const groupId = useId();
  const titleId = `${groupId}-title`;

  const [format, setFormat] = useState<ExportFormat>("png");
  const [size, setSize] = useState<ExportSize>(2048);
  const [animFormat, setAnimFormat] = useState<AnimationFormat>("gif");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const animationBlocked = format === "animation" && !animationAvailable;
  const busy = isExporting || isExportingAnimation;
  const exportDisabled = busy || animationBlocked;

  const handleExport = () => {
    if (format === "png") onExportPng(size, PNG_SIZES.find((s) => s.value === size)?.dpi);
    else if (format === "svg") onExportSvg(size);
    else onExportAnimation(animFormat);
  };

  const errorMessage =
    exportStatus.phase === "error"
      ? exportStatus.error.message
      : animationStatus.phase === "error"
        ? animationStatus.error.message
        : null;

  const activeNote =
    animationStatus.phase === "exporting"
      ? animationStatus.note
      : exportStatus.phase === "fetching"
        ? exportStatus.note
        : exportStatus.phase === "rendering"
          ? "Rendering export"
          : null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto rounded-sm border border-hairline-2 bg-surface p-0 text-ink shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop:bg-ground/80"
    >
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="display text-[15px] tracking-[0.06em] text-ink">
            Export
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close export dialog"
            className="-m-2 flex h-11 w-11 items-center justify-center text-ink-muted transition-colors hover:text-ink"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Format segmented control */}
        <fieldset>
          <legend className="instrument-label mb-2 text-ink-faint">Format</legend>
          <div className="grid grid-cols-3 overflow-hidden rounded-sm border border-hairline">
            {FORMATS.map((f) => (
              <label key={f.value}>
                <input
                  type="radio"
                  name={`${groupId}-format`}
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                  className="peer sr-only"
                />
                <span
                  className={`flex h-11 cursor-pointer items-center justify-center border-b-2 font-mono text-[12px] uppercase tracking-[0.08em] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-signal ${
                    format === f.value
                      ? "border-signal bg-surface-2 text-ink"
                      : "border-transparent text-ink-muted hover:text-ink"
                  }`}
                >
                  {f.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Destination-named size / animation-format rows */}
        <fieldset>
          <legend className="instrument-label mb-2 text-ink-faint">
            {format === "animation" ? "Encoding" : "Size"}
          </legend>
          <div className="flex flex-col gap-2">
            {format === "animation"
              ? ANIM_FORMATS.map((f) => (
                  <label key={f.value}>
                    <input
                      type="radio"
                      name={`${groupId}-anim`}
                      value={f.value}
                      checked={animFormat === f.value}
                      onChange={() => setAnimFormat(f.value)}
                      className="peer sr-only"
                    />
                    <span className={optionRowClass}>
                      <span className="w-14 shrink-0 font-mono text-[13px] tabular-nums text-ink">
                        {f.label}
                      </span>
                      <span className="text-[12px] text-ink-muted">{f.desc}</span>
                    </span>
                  </label>
                ))
              : PNG_SIZES.map((s) => (
                  <label key={s.value}>
                    <input
                      type="radio"
                      name={`${groupId}-size`}
                      value={s.value}
                      checked={size === s.value}
                      onChange={() => setSize(s.value)}
                      className="peer sr-only"
                    />
                    <span className={optionRowClass}>
                      <span className="w-14 shrink-0 font-mono text-[13px] tabular-nums text-ink">
                        {s.value}
                      </span>
                      <span className="text-[12px] text-ink-muted">
                        {format === "svg" ? SVG_DESC : s.desc}
                      </span>
                    </span>
                  </label>
                ))}
          </div>
          {animationBlocked && (
            <p className="mt-2 text-[12px] leading-snug text-amber">
              Animation is set to none — choose an animation style in the panel first.
            </p>
          )}
        </fieldset>

        {/* Primary action + live status */}
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleExport}
            disabled={exportDisabled}
            aria-busy={busy}
            className="display flex h-11 w-full items-center justify-center rounded-sm bg-signal text-[13px] tracking-[0.08em] text-ground transition-colors hover:bg-signal/90 disabled:opacity-50"
          >
            {busy ? <span className="status-live">Exporting</span> : "Export"}
          </button>
          {animationStatus.phase === "exporting" && (
            <div className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-2">
              <div
                className="h-full bg-signal transition-all"
                style={{ width: `${Math.round(animationStatus.progress * 100)}%` }}
              />
            </div>
          )}
          {activeNote && (
            <p role="status" className="instrument-label status-live text-ink-muted">
              {activeNote}
            </p>
          )}
          {errorMessage && (
            <div role="alert" className="flex flex-col gap-2 rounded-sm border border-alarm/40 p-3">
              <p className="text-[12px] leading-snug text-alarm">{errorMessage}</p>
              <button
                type="button"
                onClick={onDismissErrors}
                className="instrument-label flex h-9 w-fit items-center rounded-sm border border-hairline-2 px-3 text-ink-muted transition-colors hover:bg-surface-2"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Share row */}
        <div className="flex flex-col gap-2 border-t border-hairline pt-4">
          <span className="instrument-label text-ink-faint">Share</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCopyUrl}
              disabled={isExportingAnimation}
              className={shareButtonClass}
            >
              {copiedUrl ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={onExportJson}
              disabled={isExportingAnimation}
              className={shareButtonClass}
            >
              Save settings JSON
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
