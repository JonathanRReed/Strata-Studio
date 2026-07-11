import { useEffect, useId, useState, type CSSProperties } from "react";
import type { MaskMode } from "../../engine/types.ts";

/*
 * Shared instrument-voice primitives for the controls surfaces. Extracted
 * from ControlsPanel so the desktop rail and the mobile bottom sheet render
 * the exact same widgets without duplicating markup or behavior.
 */

export const selectClass =
  "min-h-11 rounded-sm border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-signal";
export const textInputClass =
  "min-h-11 rounded-sm border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-signal";
export const secondaryButtonClass =
  "flex min-h-11 items-center justify-center rounded-sm border border-hairline-2 px-3 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50";
export const primaryButtonClass =
  "display flex h-11 w-full items-center justify-center rounded-sm bg-signal text-[13px] tracking-[0.08em] text-ground transition-colors hover:bg-signal/90 disabled:opacity-50";

export function InfoDot({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="More info"
        aria-describedby={id}
        className="instrument-label flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-hairline bg-surface-2 text-ink-faint"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="absolute left-5 top-0 z-50 hidden w-48 rounded-sm border border-hairline-2 bg-ground px-2 py-1.5 text-[12px] leading-snug text-ink-muted shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
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
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[13px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          {label}
          {tooltip && <InfoDot text={tooltip} />}
        </span>
        <span
          className="w-[6ch] text-right font-mono text-[12px] tabular-nums text-ink"
          aria-live="polite"
        >
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
        style={{ "--fader-fill": `${fill}%` } as CSSProperties}
        className="w-full"
      />
    </label>
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
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
      <span className="flex items-center gap-1.5">
        {label}
        {tooltip && <InfoDot text={tooltip} />}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as MaskMode)}
        className={selectClass}
      >
        <option value="interrupt">Interrupt</option>
        <option value="amplify">Amplify</option>
        <option value="flatten">Flatten</option>
        <option value="glow">Glow</option>
        <option value="outline">Outline</option>
        <option value="invert">Invert</option>
      </select>
    </label>
  );
}

export function Section({
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
    <section className="border-b border-hairline">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex min-h-11 w-full items-center justify-between text-left"
      >
        <span className="instrument-label flex items-center gap-2 text-ink-faint transition-colors group-hover:text-ink-muted">
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
          className={`text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="flex flex-col gap-3.5 pb-4">{children}</div>}
    </section>
  );
}
