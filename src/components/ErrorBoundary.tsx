import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage:
        error?.message || 'Unexpected graphics or runtime error occurred.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ARC STREETRACING] Unhandled error:', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0d0d0f] p-6 text-[#f8f8f8]">
        <div className="w-full max-w-md border border-[rgba(248,248,248,0.16)] bg-[#16161a] p-6">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2.5 w-2.5 bg-[#f43f5e]" />
            <span className="font-['Space_Mono',monospace] text-xs font-bold uppercase tracking-[0.16em] text-[#f43f5e]">
              ARC STREETRACING • RECOVERY
            </span>
          </div>
          <h1 className="font-['Inter',sans-serif] text-2xl font-black uppercase tracking-[-0.02em] text-white">
            Session Interrupted
          </h1>
          <p className="mt-2 font-['Space_Mono',monospace] text-xs leading-relaxed text-[rgba(248,248,248,0.7)]">
            {this.state.errorMessage}
          </p>
          <p className="mt-2 font-['Space_Mono',monospace] text-[0.68rem] text-[rgba(248,248,248,0.45)]">
            Your wallet balance and recent race history remain saved locally.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-5 w-full cursor-pointer border-none bg-[#2563eb] px-4 py-3 font-['Inter',sans-serif] text-sm font-black uppercase tracking-[0.08em] text-white transition hover:bg-[#3b82f6]"
          >
            Reload Game
          </button>
        </div>
      </div>
    );
  }
}
