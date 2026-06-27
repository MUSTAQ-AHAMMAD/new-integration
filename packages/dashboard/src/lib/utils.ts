import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) {
    return 'N/A';
  }
  
  const dateObj = new Date(date);
  
  // Check if the date is valid
  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }
  
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dateObj);
}

export function formatCurrency(amount: number, currency = 'AED'): string {
  return new Intl.NumberFormat('en-AE', { style: 'currency', currency }).format(amount);
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    SYNCED: 'bg-green-100 text-green-800',
    PENDING: 'bg-yellow-100 text-yellow-800',
    PROCESSING: 'bg-blue-100 text-blue-800',
    FAILED: 'bg-red-100 text-red-800',
    SKIPPED: 'bg-gray-100 text-gray-800',
    QUEUED_FOR_RETRY: 'bg-orange-100 text-orange-800',
    VALIDATED: 'bg-green-100 text-green-800',
    HEALTHY: 'bg-green-100 text-green-800',
    DEGRADED: 'bg-yellow-100 text-yellow-800',
    UNHEALTHY: 'bg-red-100 text-red-800',
    COMPLETED: 'bg-green-100 text-green-800',
    PARTIAL: 'bg-orange-100 text-orange-800',
    CANCELLED: 'bg-gray-100 text-gray-800',
  };

  return colors[status] ?? 'bg-gray-100 text-gray-600';
}

export function getSeverityColor(severity: string): string {
  const colors: Record<string, string> = {
    INFO: 'bg-blue-100 text-blue-800',
    WARNING: 'bg-yellow-100 text-yellow-800',
    ERROR: 'bg-red-100 text-red-800',
    CRITICAL: 'bg-red-600 text-white',
  };

  return colors[severity] ?? 'bg-gray-100 text-gray-600';
}
