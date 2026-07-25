'use client';

import { useLiveActivity, LiveEvent } from '@/hooks/use-live-activity';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Radio } from 'lucide-react';

const typeColor: Record<LiveEvent['type'], string> = {
  order: 'text-sky-400',
  job: 'text-indigo-400',
  integration: 'text-violet-400',
  alert: 'text-red-400',
  health: 'text-emerald-400',
};

function QueueTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-center">
      <div className="text-xl font-bold text-slate-900">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

export function LiveActivityFeed() {
  const events = useLiveActivity(40);
  const { data: queue } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: api.getQueueStats,
    refetchInterval: 2000,
  });
  const q = queue?.orderSync;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="h-4 w-4 animate-pulse text-emerald-500" />
          Live Activity
          <span className="ml-auto text-xs font-normal text-slate-400">
            real-time · websocket
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {q && (
          <div className="grid grid-cols-4 gap-2">
            <QueueTile label="Waiting" value={q.waiting} />
            <QueueTile label="Active" value={q.active} />
            <QueueTile label="Failed" value={q.failed} />
            <QueueTile label="Completed" value={q.completed} />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-xs">
          {events.length === 0 ? (
            <div className="text-slate-500">
              Listening for live events… trigger a sync or integration run to see
              the stream fill in.
            </div>
          ) : (
            events.map((e) => (
              <div key={e.id} className="whitespace-pre-wrap text-slate-200">
                <span className="text-slate-500">
                  {new Date(e.at).toLocaleTimeString()}
                </span>{' '}
                <span className={`uppercase ${typeColor[e.type]}`}>
                  [{e.type}]
                </span>{' '}
                {e.message}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
