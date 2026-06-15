import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  iconColor?: string;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, icon: Icon, iconColor = 'bg-indigo-500', children, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm', className)}>
      <div className="flex items-center gap-3">
        {Icon ? (
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm', iconColor)}>
            <Icon className="h-4.5 w-4.5 text-white" />
          </div>
        ) : (
          <div className={cn('h-8 w-1 shrink-0 rounded-full', iconColor)} />
        )}
        <div>
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
