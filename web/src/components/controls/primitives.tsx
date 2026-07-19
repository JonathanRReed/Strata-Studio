import { useEffect, useId, useState, type CSSProperties } from "react";
import type { MaskMode } from "../../engine/types.ts";

/*
 * Shared instrument-voice primitives for the controls surfaces. Extracted
 * from ControlsPanel so the desktop rail and the mobile bottom sheet render
 * the exact same widgets without duplicating markup or behavior.
 */

export const selectClass =
  "min-h-11 rounded-sm border border-hairline-2 bg-surface-2 px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-signal";
export const textInputClass =
  "min-h-11 rounded-sm border border-hairline-2 bg-surface-2 px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-signal";
export const secondaryButtonClass =
  "flex min-h-11 items-center justify-center rounded-sm border border-hairline-2 px-3 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50";
export const primaryButtonClass =
  "display flex h-11 w-full items-center justify-center rounded-sm bg-signal text-[13px] tracking-[0.08em] text-ground transition-colors hover:bg-signal/90 disabled:opacity-50";

export function InfoDot({
  text,
  label,
  tooltipId,
}: {
  text: string;
  label: string;
  tooltipId?: string;
}) {
  const generatedId = useId();
  const id = tooltipId ?? `${generatedId}-help`;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`${label} help`}
        aria-describedby={id}
        className="instrument-label flex h-5 w-5 cursor-help select-none items-center justify-center rounded-full border border-hairline-2 bg-surface-2 text-ink-muted"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="absolute left-6 top-0 z-50 hidden w-48 rounded-sm border border-hairline-2 bg-ground px-2 py-1.5 text-[12px] leading-snug text-ink-muted shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

function formatSliderValue(value: number, step: number): string {
  const precision = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(value.toFixed(precision)).toString();
}

export function Slider({
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
  const controlId = `${useId()}-slider`;
  const helpId = `${controlId}-help`;
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const displayValue = formatSliderValue(value, step);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[13px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <label htmlFor={controlId}>{label}</label>
          {tooltip && <InfoDot text={tooltip} label={label} tooltipId={helpId} />}
        </span>
        <output
          htmlFor={controlId}
          className="w-[6ch] text-right font-mono text-[12px] tabular-nums text-ink"
        >
          {displayValue}
        </output>
      </div>
      <input
        id={controlId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={tooltip ? helpId : undefined}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        style={{ "--fader-fill": `${fill}%` } as CSSProperties}
        className="w-full"
      />
    </div>
  );
}

export function ModeSelector({
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
  const controlId = `${useId()}-mode`;
  const helpId = `${controlId}-help`;
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
      <span className="flex items-center gap-1.5">
        <label htmlFor={controlId}>{label}</label>
        {tooltip && <InfoDot text={tooltip} label={label} tooltipId={helpId} />}
      </span>
      <select
        id={controlId}
        value={value}
        aria-describedby={tooltip ? helpId : undefined}
        onChange={(event) => onChange(event.target.value as MaskMode)}
        className={selectClass}
      >
        <option value="interrupt">Interrupt</option>
        <option value="amplify">Amplify</option>
        <option value="flatten">Flatten</option>
        <option value="glow">Glow</option>
        <option value="outline">Outline</option>
        <option value="invert">Invert</option>
      </select>
    </div>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
  badge,
  id,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string;
  id?: string;
}) {
  const generatedId = useId();
  const sectionId = id ?? `${generatedId}-section`;
  const toggleId = `${sectionId}-toggle`;
  const bodyId = `${sectionId}-body`;
  const [open, setOpen] = useState(defaultOpen);
  // Sync with defaultOpen when it changes (e.g., when OSM features load or animation mode changes)
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  return (
    <section id={sectionId} aria-labelledby={toggleId} className="border-b border-hairline">
      <button
        id={toggleId}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group flex min-h-11 w-full items-center justify-between text-left"
      >
        <span className="instrument-label flex items-center gap-2 text-ink-muted transition-colors group-hover:text-ink">
          {title}
          {badge && <span className="instrument-label text-ok">{badge}</span>}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className={`text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-3.5 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}
