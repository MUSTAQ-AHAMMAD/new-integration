'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { api, type AiAnalysisResult, type AiFinding, type FindingSeverity } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';

const STATUS_STYLES: Record<AiAnalysisResult['status'], { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  degraded: { label: 'Degraded', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  unhealthy: { label: 'Unhealthy', className: 'bg-red-100 text-red-700 border-red-200' },
};

const SEVERITY_STYLES: Record<
  FindingSeverity,
  { icon: typeof AlertTriangle; badge: string; card: string }
> = {
  CRITICAL: {
    icon: ShieldAlert,
    badge: 'bg-red-100 text-red-700 border-red-200',
    card: 'border-l-4 border-l-red-500',
  },
  WARNING: {
    icon: AlertTriangle,
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    card: 'border-l-4 border-l-amber-500',
  },
  INFO: {
    icon: Info,
    badge: 'bg-sky-100 text-sky-700 border-sky-200',
    card: 'border-l-4 border-l-sky-500',
  },
};

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function FindingCard({ finding }: { finding: AiFinding }) {
  const style = SEVERITY_STYLES[finding.severity];
  const Icon = style.icon;
  return (
    <Card className={style.card}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <CardTitle className="text-sm font-semibold text-slate-900">{finding.title}</CardTitle>
          </div>
          <Badge variant="outline" className={style.badge}>
            {finding.severity}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0 text-sm">
        <p className="text-slate-600">{finding.detail}</p>
        <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-700">
          <span className="font-semibold text-slate-900">Fix: </span>
          {finding.recommendation}
        </div>
        <p className="text-xs uppercase tracking-wide text-slate-400">{finding.category}</p>
      </CardContent>
    </Card>
  );
}

export default function AiMonitorPage() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<AiAnalysisResult>({
    queryKey: ['ai-monitor-analyze'],
    queryFn: () => api.aiMonitorAnalyze(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Monitor"
        subtitle="Automated diagnostics that find and explain issues across your integration"
        icon={Bot}
        iconColor="bg-gradient-to-br from-indigo-500 to-purple-600"
      >
        <Button onClick={() => refetch()} disabled={isFetching} variant="outline" size="sm">
          {isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Re-analyze
        </Button>
      </PageHeader>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Analyzing your integration…
        </div>
      ) : isError || !data ? (
        <ErrorState message="Could not run the diagnostic analysis. Is the backend running and are you logged in as an admin?" />
      ) : (
        <>
          {/* Overview */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Overall Status</CardDescription>
                <CardTitle>
                  <Badge variant="outline" className={STATUS_STYLES[data.status].className}>
                    {STATUS_STYLES[data.status].label}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-black ${scoreColor(data.healthScore)}`}>
                  {data.healthScore}
                  <span className="text-base font-medium text-slate-400">/100</span>
                </div>
                <Progress value={data.healthScore} className="mt-2" />
              </CardContent>
            </Card>

            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-indigo-500" />
                  <CardDescription>
                    AI Summary
                    <span className="ml-2 text-xs text-slate-400">
                      ({data.summarySource === 'ai' ? 'AI-generated' : 'rule-based'})
                    </span>
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-slate-700">{data.summary}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline" className={SEVERITY_STYLES.CRITICAL.badge}>
                    {data.counts.critical} critical
                  </Badge>
                  <Badge variant="outline" className={SEVERITY_STYLES.WARNING.badge}>
                    {data.counts.warning} warning
                  </Badge>
                  <Badge variant="outline" className={SEVERITY_STYLES.INFO.badge}>
                    {data.counts.info} info
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Findings */}
          {data.findings.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <CheckCircle2 className="mb-3 h-10 w-10 text-emerald-500" />
                <p className="text-sm font-medium text-slate-700">No issues detected</p>
                <p className="mt-1 text-xs text-slate-400">
                  All monitored checks passed. The integration looks healthy.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
                Detected Issues ({data.findings.length})
              </h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {data.findings.map((f) => (
                  <FindingCard key={f.id} finding={f} />
                ))}
              </div>
            </div>
          )}

          <p className="text-right text-xs text-slate-400">
            Last analyzed {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
