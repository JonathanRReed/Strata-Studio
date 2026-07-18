import { Component, type ErrorInfo, type ReactNode } from "react";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "An unexpected rendering error occurred";
}

export class ApplicationErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-ground p-6 text-ink">
        <div role="alert" className="flex w-full max-w-lg flex-col gap-4 border border-alarm/40 bg-surface p-5">
          <p className="display text-xl tracking-[0.06em]">Strata Studio could not continue</p>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            {errorMessage(this.state.error)}. Reloading resets the in-memory session; cached terrain remains available.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="display flex h-11 items-center justify-center rounded-sm bg-signal px-4 text-[13px] tracking-[0.08em] text-ground"
          >
            Reload application
          </button>
        </div>
      </main>
    );
  }
}

type MapErrorBoundaryProps = {
  children: ReactNode;
  fallback: (error: Error, retry: () => void) => ReactNode;
  onRetry: () => void;
};

export class MapErrorBoundary extends Component<
  MapErrorBoundaryProps,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Lazy map render failed", error, info.componentStack);
  }

  private retry = () => {
    this.props.onRetry();
  };

  render() {
    return this.state.error
      ? this.props.fallback(this.state.error, this.retry)
      : this.props.children;
  }
}
