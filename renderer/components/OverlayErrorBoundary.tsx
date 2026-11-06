import React from 'react';

// Last-resort net around the whole overlay tree. Without this, ANY render
// throw (bad tool payload, broken markdown, crashed widget) unmounts the
// entire box: invisible overlay + stuck fullscreen capture until force-quit.
// With it, the user gets a visible recovery card and a working reload.
type State = { error: string | null };

export class OverlayErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info?: { componentStack?: string | null }): void {
    try {
      // Full stack + component stack to the log (no trimming). The on-screen
      // card below shows only the first lines — the log gets everything.
      const full = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const where = info?.componentStack ? `\ncomponentStack:${info.componentStack}` : '';
      window.spirit?.reportRendererError?.(`react-crash: ${full}${where}`);
    } catch {
      /* reporting must never throw */
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed left-1/2 top-24 z-[10002] w-[320px] -translate-x-1/2 rounded-2xl border border-rose-400/40 bg-black/85 px-4 py-3 text-white">
        <div className="text-[13px] font-semibold">The box crashed — sorry.</div>
        <div className="mt-1 max-h-20 overflow-auto font-mono text-[10.5px] text-white/60">
          {this.state.error.slice(0, 220)}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-lg bg-white/15 px-3 py-1.5 text-[12px] font-medium hover:bg-white/25"
        >
          Reload box
        </button>
      </div>
    );
  }
}
