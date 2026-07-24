/**
 * Discovery toast for landmark easter eggs: an instrument-label pill,
 * bottom-center (clear of the mobile sheet), auto-dismissed by its hook
 * after 6s. role=status announces it politely to assistive tech.
 */
export function EggToast({
  text,
  onDismiss,
  backgroundInert = false,
}: {
  text: string;
  onDismiss: () => void;
  backgroundInert?: boolean;
}) {
  return (
    <div
      inert={backgroundInert ? true : undefined}
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--sheet-peek)+12px)] z-50 flex justify-center px-4 lg:bottom-8"
    >
      <div
        role="status"
        className="pointer-events-auto flex min-h-9 items-center gap-1 rounded-sm border border-signal/40 bg-surface pl-4 pr-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
      >
        <span className="instrument-label text-signal">{text}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="flex h-8 w-8 items-center justify-center text-ink-muted press hover:text-ink"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}
