import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.closest("[inert]") && element.getClientRects().length > 0,
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  closeBlocked?: boolean;
  supportsNativeDialog: boolean;
  ariaLabel?: string;
  ariaLabelledby?: string;
  className: string;
  children: ReactNode;
};

/**
 * Native modal dialog with an equivalent fallback for engines without
 * HTMLDialogElement.showModal. The fallback owns focus, Escape, background
 * inert/aria-hidden state, backdrop clicks, and opener restoration.
 */
export function ModalSurface({
  open,
  onClose,
  closeBlocked = false,
  supportsNativeDialog,
  ariaLabel,
  ariaLabelledby,
  className,
  children,
}: Props) {
  const nativeDialogRef = useRef<HTMLDialogElement>(null);
  const fallbackOverlayRef = useRef<HTMLDivElement>(null);
  const fallbackDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    return () => {
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useEffect(() => {
    if (!supportsNativeDialog) return;
    const dialog = nativeDialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, supportsNativeDialog]);

  useEffect(() => {
    if (!open || supportsNativeDialog) return;
    const overlay = fallbackOverlayRef.current;
    const dialog = fallbackDialogRef.current;
    const parent = overlay?.parentElement;
    if (!overlay || !dialog || !parent) return;

    const background = Array.from(parent.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
    );
    const records = background.map((element) => ({
      element,
      inert: element.getAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]");
      (preferred ?? focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      for (const record of records) {
        if (record.inert === null) record.element.removeAttribute("inert");
        else record.element.setAttribute("inert", record.inert);
        if (record.ariaHidden === null) record.element.removeAttribute("aria-hidden");
        else record.element.setAttribute("aria-hidden", record.ariaHidden);
      }
    };
  }, [open, supportsNativeDialog]);

  const requestClose = () => {
    if (!closeBlocked) onClose();
  };

  const handleFallbackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const dialog = fallbackDialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!supportsNativeDialog) {
    if (!open) return null;
    return (
      <div
        ref={fallbackOverlayRef}
        className="fixed inset-0 z-50 flex items-center justify-center bg-ground/80 p-4"
        onClick={(event: MouseEvent<HTMLDivElement>) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        <div
          ref={fallbackDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          tabIndex={-1}
          onKeyDown={handleFallbackKeyDown}
          className={className}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <dialog
      ref={nativeDialogRef}
      onCancel={(event) => {
        if (closeBlocked) event.preventDefault();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        if (event.target === nativeDialogRef.current) requestClose();
      }}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={className}
    >
      {children}
    </dialog>
  );
}
