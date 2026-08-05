import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AnimationFormat } from "../engine/animationExport.ts";
import type { AnimationExportStatus, ExportStatus } from "../app/status.ts";
import type { CapabilityMatrix } from "../app/capabilities.ts";
import {
  supportedAnimationFormats,
  supportedExportFormats,
} from "../app/capabilities.ts";
import type { CompositionImportStatus } from "../app/composition.ts";
import type { ShareStatus } from "../app/useShare.ts";
import { ModalSurface } from "./ModalSurface.tsx";

type ExportFormat = "png" | "svg" | "animation";
type ExportSize = 1024 | 2048 | 3000;

type Props = {
  open: boolean;
  onClose: () => void;
  onExportPng: (size: number, dpi?: number) => Promise<void>;
  onExportSvg: (size: number) => Promise<void>;
  onExportAnimation: (format: AnimationFormat) => Promise<void>;
  onExportJson: () => Promise<void>;
  onImportComposition: (file: File) => Promise<void>;
  importStatus: CompositionImportStatus;
  onDismissImportStatus: () => void;
  onCopyUrl: () => Promise<boolean>;
  copiedUrl: boolean;
  onShare: () => Promise<void>;
  shareSupported: boolean;
  shareStatus: ShareStatus;
  exportStatus: ExportStatus;
  animationStatus: AnimationExportStatus;
  isExporting: boolean;
  isExportingAnimation: boolean;
  isSharing: boolean;
  animationAvailable: boolean;
  capabilities: CapabilityMatrix;
  onCancel: () => void;
  onDismissErrors: () => void;
};

const FORMAT_LABELS: Record<ExportFormat, string> = {
  png: "PNG",
  svg: "SVG",
  animation: "Animation",
};

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

const SVG_DESC = "vector · plotter & print-shop ready";
const ANIM_FORMATS: { value: AnimationFormat; label: string; desc: string }[] = [
  { value: "gif", label: "GIF", desc: "24 frames · universal short loop" },
  { value: "apng", label: "APNG", desc: "24 frames · high-quality short loop" },
  { value: "webm", label: "WEBM", desc: "24 frames · smallest short loop" },
];

const optionRowClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border border-hairline px-3 py-2 press hover:border-hairline-2 peer-checked:border-signal peer-checked:bg-surface-2 peer-focus-visible:ring-2 peer-focus-visible:ring-signal";
const shareButtonClass =
  "flex min-h-11 flex-1 items-center justify-center rounded-sm border border-hairline-2 px-3 text-[13px] text-ink press hover:bg-surface-2 disabled:opacity-50";
const dialogClass =
  "m-auto max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto rounded-sm border border-hairline-2 bg-surface p-0 text-ink shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop:bg-ground/80";

export function ExportDialog(props: Props) {
  const {
    open,
    onClose,
    onExportPng,
    onExportSvg,
    onExportAnimation,
    onExportJson,
    onImportComposition,
    importStatus,
    onDismissImportStatus,
    onCopyUrl,
    copiedUrl,
    onShare,
    shareSupported,
    shareStatus,
    exportStatus,
    animationStatus,
    isExporting,
    isExportingAnimation,
    isSharing,
    animationAvailable,
    capabilities,
    onCancel,
    onDismissErrors,
  } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const groupId = useId();
  const titleId = `${groupId}-title`;
  const [format, setFormat] = useState<ExportFormat>(capabilities.pngExport ? "png" : "svg");
  const [size, setSize] = useState<ExportSize>(2048);
  const [animFormat, setAnimFormat] = useState<AnimationFormat>(
    supportedAnimationFormats(capabilities)[0] ?? "gif",
  );

  const availableFormats: ExportFormat[] = supportedExportFormats(capabilities);
  const availableAnimationFormats = supportedAnimationFormats(capabilities);

  useEffect(() => {
    if (!availableFormats.includes(format)) setFormat(availableFormats[0] ?? "svg");
  }, [availableFormats, format]);

  useEffect(() => {
    if (!availableAnimationFormats.includes(animFormat)) {
      setAnimFormat(availableAnimationFormats[0] ?? "gif");
    }
  }, [animFormat, availableAnimationFormats]);

  const animationBlocked = format === "animation" && !animationAvailable;
  const busy = isExporting || isExportingAnimation || isSharing || importStatus.phase === "reading";
  const exportDisabled = busy || animationBlocked || availableFormats.length === 0;

  const handleExport = async () => {
    if (format === "png") {
      await onExportPng(size, PNG_SIZES.find((option) => option.value === size)?.dpi);
    } else if (format === "svg") {
      await onExportSvg(size);
    } else {
      await onExportAnimation(animFormat);
    }
  };

  const requestClose = () => {
    if (!busy) onClose();
  };

  const errorMessage =
    exportStatus.phase === "error"
      ? exportStatus.error.message
      : animationStatus.phase === "error"
        ? animationStatus.error.message
        : null;

  const activeMessage = (() => {
    if (animationStatus.phase === "exporting") return animationStatus.note;
    if (animationStatus.phase === "done" || animationStatus.phase === "cancelled") {
      return animationStatus.message;
    }
    if (exportStatus.phase === "fetching" || exportStatus.phase === "rendering") {
      return exportStatus.note ?? "Rendering export…";
    }
    if (exportStatus.phase === "done" || exportStatus.phase === "cancelled") {
      return exportStatus.message;
    }
    if (shareStatus.phase !== "idle") return shareStatus.message;
    return null;
  })();

  const content: ReactNode = (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="display text-[15px] tracking-[0.06em] text-ink">
          Export
        </h2>
        <button
          type="button"
          data-modal-initial-focus
          onClick={requestClose}
          disabled={busy}
          aria-label={busy ? "Export in progress; use Cancel first" : "Close export dialog"}
          className="-m-2 flex h-11 w-11 items-center justify-center text-ink-muted press hover:text-ink disabled:opacity-40"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <fieldset>
        <legend className="instrument-label mb-2 text-ink-faint">Format</legend>
        <div
          className="grid overflow-hidden rounded-sm border border-hairline"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, availableFormats.length)}, minmax(0, 1fr))` }}
        >
          {availableFormats.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`${groupId}-format`}
                value={value}
                checked={format === value}
                onChange={() => setFormat(value)}
                disabled={busy}
                className="peer sr-only"
              />
              <span
                className={`flex h-11 cursor-pointer items-center justify-center border-b-2 font-mono text-[12px] uppercase tracking-[0.08em] press peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-signal ${
                  format === value
                    ? "border-signal bg-surface-2 text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {FORMAT_LABELS[value]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="instrument-label mb-2 text-ink-faint">
          {format === "animation" ? "Encoding" : "Size"}
        </legend>
        <div className="flex flex-col gap-2">
          {format === "animation"
            ? ANIM_FORMATS.filter((option) => availableAnimationFormats.includes(option.value)).map(
                (option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name={`${groupId}-anim`}
                      value={option.value}
                      checked={animFormat === option.value}
                      onChange={() => setAnimFormat(option.value)}
                      disabled={busy}
                      className="peer sr-only"
                    />
                    <span className={optionRowClass}>
                      <span className="w-14 shrink-0 font-mono text-[13px] tabular-nums text-ink">
                        {option.label}
                      </span>
                      <span className="text-[12px] text-ink-muted">{option.desc}</span>
                    </span>
                  </label>
                ),
              )
            : PNG_SIZES.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name={`${groupId}-size`}
                    value={option.value}
                    checked={size === option.value}
                    onChange={() => setSize(option.value)}
                    disabled={busy}
                    className="peer sr-only"
                  />
                  <span className={optionRowClass}>
                    <span className="w-14 shrink-0 font-mono text-[13px] tabular-nums text-ink">
                      {option.value}
                    </span>
                    <span className="text-[12px] text-ink-muted">
                      {format === "svg" ? SVG_DESC : option.desc}
                    </span>
                  </span>
                </label>
              ))}
        </div>
        {animationBlocked && (
          <p className="mt-2 text-[12px] leading-snug text-amber">
            Animation is set to none. Choose an animation style in the panel first.
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exportDisabled}
          aria-busy={busy}
          className="display flex h-11 w-full items-center justify-center rounded-sm border border-signal/70 bg-signal/12 text-[13px] tracking-[0.08em] text-signal press hover:border-signal hover:bg-signal/20 hover:text-ink disabled:opacity-50"
        >
          {busy ? <span className="status-live">Working</span> : "Export"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={onCancel}
            className="instrument-label flex h-10 w-full items-center justify-center rounded-sm border border-hairline-2 text-ink press hover:bg-surface-2"
          >
            Cancel
          </button>
        )}
        {animationStatus.phase === "exporting" && (
          <div className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-2">
            <div
              className="h-full bg-signal transition-all"
              style={{ width: `${Math.round(animationStatus.progress * 100)}%` }}
            />
          </div>
        )}
        {/* Static export (PNG/SVG) indeterminate progress — the work is
            single-shot (fetch + render), so a shimmering bar communicates
            "working" without a fake percentage. */}
        {(exportStatus.phase === "fetching" || exportStatus.phase === "rendering") && (
          <div className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-2">
            <div className="strata-shimmer h-full w-1/3 bg-signal" />
          </div>
        )}
        {activeMessage && (
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="instrument-label status-live text-ink-muted"
          >
            {activeMessage}
          </p>
        )}
        {errorMessage && (
          <div role="alert" className="flex flex-col gap-2 rounded-sm border border-alarm/40 p-3">
            <p className="text-[12px] leading-snug text-alarm">{errorMessage}</p>
            <button
              type="button"
              onClick={onDismissErrors}
              className="instrument-label flex h-9 w-fit items-center rounded-sm border border-hairline-2 px-3 text-ink-muted press hover:bg-surface-2"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline pt-4">
        <span className="instrument-label text-ink-faint">Share & settings</span>
        <div className="flex flex-wrap gap-2">
          {shareSupported && (
            <button
              type="button"
              onClick={() => void onShare()}
              disabled={busy}
              className={shareButtonClass}
            >
              Share…
            </button>
          )}
          <button
            type="button"
            onClick={() => void onCopyUrl()}
            disabled={busy}
            className={shareButtonClass}
          >
            {copiedUrl ? "Copied" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={() => void onExportJson()}
            disabled={busy}
            className={shareButtonClass}
          >
            Save composition
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className={shareButtonClass}
          >
            Import composition
          </button>
          <input
            ref={fileInputRef}
            type="file"
            tabIndex={-1}
            aria-label="Import composition file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onImportComposition(file);
            }}
          />
        </div>
        {importStatus.phase !== "idle" && importStatus.phase !== "reading" && (
          <div
            role={importStatus.phase === "error" ? "alert" : "status"}
            className={`flex items-start justify-between gap-3 rounded-sm border p-3 ${
              importStatus.phase === "error" ? "border-alarm/40 text-alarm" : "border-ok/40 text-ok"
            }`}
          >
            <p className="text-[12px] leading-snug">{importStatus.message}</p>
            <button
              type="button"
              onClick={onDismissImportStatus}
              aria-label="Dismiss composition import status"
              className="shrink-0 text-ink-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      closeBlocked={busy}
      supportsNativeDialog={capabilities.dialog}
      ariaLabelledby={titleId}
      className={dialogClass}
    >
      {content}
    </ModalSurface>
  );
}
