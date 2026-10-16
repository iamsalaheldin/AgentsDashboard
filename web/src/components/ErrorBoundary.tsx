import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Keeps one broken view from blanking the whole dashboard. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel mx-auto mt-6 max-w-xl p-5" role="alert">
        <div className="font-mono text-[13px] text-st-error">This view failed to render</div>
        <pre className="mt-2 overflow-auto text-[11.5px] whitespace-pre-wrap text-ink-3">{this.state.error.message}</pre>
        <button className="btn mt-3" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
