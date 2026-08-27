import { AlertTriangle } from 'lucide-react';

interface ErrorStateProps {
  message?: string;
  /** Rendered as a retry button when supplied; omitted leaves the plain message. */
  onRetry?: () => void;
}

export function ErrorState({ message = 'Something went wrong. Please try again.', onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <AlertTriangle className="mb-3 h-8 w-8 text-red-400" />
      <p className="text-sm font-medium text-gray-700">Error loading data</p>
      <p className="mt-1 text-xs text-gray-400">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-600"
        >
          Try again
        </button>
      )}
    </div>
  );
}
