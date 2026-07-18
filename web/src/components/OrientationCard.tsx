import type { MouseEvent } from "react";
import { secondaryButtonClass } from "./controls/primitives.tsx";

type Props = {
  place: string;
  style: string;
  onChoosePlace: (opener: HTMLElement) => void;
  onCustomizeArtwork: (opener: HTMLElement) => void;
  onDismiss: () => void;
};

/** Non-modal first-session guide; the Daily Strata artwork remains visible. */
export function OrientationCard({
  place,
  style,
  onChoosePlace,
  onCustomizeArtwork,
  onDismiss,
}: Props) {
  const choose = (event: MouseEvent<HTMLButtonElement>) => {
    onChoosePlace(event.currentTarget);
  };
  const customize = (event: MouseEvent<HTMLButtonElement>) => {
    onCustomizeArtwork(event.currentTarget);
  };

  return (
    <aside
      aria-labelledby="orientation-title"
      className="absolute bottom-4 right-3 top-auto z-20 w-[min(20rem,calc(100%-1.5rem))] rounded-sm border border-hairline-2 bg-surface/95 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.55)] backdrop-blur-sm lg:fixed lg:bottom-auto lg:left-4 lg:right-auto lg:top-4 lg:w-[22rem]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="orientation-title" className="display text-[13px] tracking-[0.06em] text-ink">
            Your Daily Strata is ready
          </h2>
          <p className="mt-1 text-[12px] leading-snug text-ink-muted">
            {place} · {style}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss getting started guide"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-muted transition-colors hover:text-ink"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <p className="mt-3 text-[12px] leading-snug text-ink-muted">
        Pan or zoom to change the exported area automatically, or tune the artwork controls.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={choose} className={secondaryButtonClass}>
          Choose your place
        </button>
        <button type="button" onClick={customize} className={secondaryButtonClass}>
          Customize artwork
        </button>
      </div>
    </aside>
  );
}
