import { useEffect, useId, useState, type CSSProperties } from "react";
import type { MaskMode } from "../../engine/types.ts";

/*
 * Shared instrument-voice primitives for the controls surfaces. Extracted
 * from ControlsPanel so the desktop rail and the mobile bottom sheet render
 * the exact same widgets without duplicating markup or behavior.
 */

/*
 * Every control shares the `press` class, which owns the transition and the
 * 1px seat on :active (see index.css). Hover states are declared here so the
 * whole app has one hover/press/disabled vocabulary rather than per-component
 * variations.
 */
export const selectClass =
  "press min-h-11 rounded-sm border border-hairline-2 bg-surface-2 px-2.5 text-[13px] text-ink outline-none hover:border-hairline-2/80 hover:bg-surface focus:border-signal disabled:opacity-50";
export const textInputClass =
  "press min-h-11 rounded-sm border border-hairline-2 bg-surface-2 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-muted hover:border-hairline-2/80 focus:border-signal disabled:opacity-50";
export const secondaryButtonClass =
  "press flex min-h-11 items-center justify-center rounded-sm border border-hairline-2 px-3 text-[13px] text-ink hover:border-ink-muted hover:bg-surface-2 disabled:opacity-50";
/*
 * The primary action is deliberately NOT a saturated slab. `--color-signal` at
 * full strength is the brightest thing the palette can produce, and a filled
 * cyan bar in the rail reads louder than the artwork it exists to generate.
 * A signal-bordered, signal-tinted instrument button is unmistakably primary
 * (it is the only signal-colored control on the surface) without competing
 * with the poster for the eye.
 */
export const primaryButtonClass =
  "display press flex h-11 w-full items-center justify-center rounded-sm border border-signal/70 bg-signal/12 text-[13px] tracking-[0.08em] text-signal hover:border-signal hover:bg-signal/20 hover:text-ink disabled:opacity-50";

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
        className="instrument-label press flex h-5 w-5 cursor-help select-none items-center justify-center rounded-full border border-hairline-2 bg-surface-2 text-ink-muted hover:border-ink-muted hover:text-ink"
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
        className="press group flex min-h-11 w-full items-center justify-between text-left"
      >
        <span className="instrument-label flex items-center gap-2 text-ink-muted transition-colors duration-[180ms] group-hover:text-ink">
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
          className={`text-ink-muted transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:text-ink ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className="enter-card flex flex-col gap-3.5 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}
