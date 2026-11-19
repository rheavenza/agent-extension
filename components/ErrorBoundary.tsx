import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Compact inline variant, used around single messages. */
  inline?: boolean;
  onReset?: () => void;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/** Shows a render error instead of letting React blank the whole panel. */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[agent] render error', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const details = `${error.name}: ${error.message}\n\n${error.stack ?? ''}\n\nComponent stack:${componentStack}`;

    if (this.props.inline) {
      return (
        <details className="rounded border border-red-400 bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
          <summary className="cursor-pointer">This message failed to render: {error.message}</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{details}</pre>
        </details>
      );
    }

    return (
      <div className="space-y-3 p-4 text-sm">
        <div className="font-semibold text-red-700 dark:text-red-400">The agent panel crashed</div>
        <div className="break-words">{error.message}</div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => navigator.clipboard.writeText(details)}>
            Copy error details
          </button>
          <button className="btn" onClick={() => location.reload()}>
            Reload panel
          </button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              this.props.onReset?.();
              await chrome.storage.local.remove('chat:current');
              location.reload();
            }}
          >
            Clear chat &amp; reload
          </button>
        </div>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
          {details}
        </pre>
      </div>
    );
  }
}
