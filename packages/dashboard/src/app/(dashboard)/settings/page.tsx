'use client';

import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type CreateNotificationRecipientDto, type NotificationRecipient } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface AlertThresholdSettings {
  failureRateThreshold: number;
  latencyThresholdMs: number;
  maxQueueDepth: number;
  alertCooldownMinutes: number;
}

interface SyncScheduleItem {
  expression: string;
  description: string;
}

interface SyncScheduleSettings {
  orderSync: SyncScheduleItem;
  retryFailed: SyncScheduleItem;
  healthCheck: SyncScheduleItem;
}

interface RetryPolicySettings {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

interface CronValidationResult {
  nextRuns: string[];
}

interface RecipientFormState {
  id?: string;
  email: string;
  name: string;
  receiveErrorAlerts: boolean;
  receiveDailyReports: boolean;
  receiveInventoryAlerts: boolean;
  isActive: boolean;
}

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const DEFAULT_THRESHOLDS: AlertThresholdSettings = {
  failureRateThreshold: 5,
  latencyThresholdMs: 2000,
  maxQueueDepth: 100,
  alertCooldownMinutes: 15,
};
const DEFAULT_SCHEDULES: SyncScheduleSettings = {
  orderSync: { expression: '*/5 * * * *', description: 'Every 5 minutes' },
  retryFailed: { expression: '*/15 * * * *', description: 'Every 15 minutes' },
  healthCheck: { expression: '*/5 * * * *', description: 'Every 5 minutes' },
};
const DEFAULT_RETRY_POLICY: RetryPolicySettings = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};
const EMPTY_RECIPIENT: RecipientFormState = {
  email: '',
  name: '',
  receiveErrorAlerts: true,
  receiveDailyReports: false,
  receiveInventoryAlerts: false,
  isActive: true,
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getWithFallback<T>(path: string, fallback: T): Promise<T> {
  try {
    return await apiRequest<T>(path);
  } catch {
    return fallback;
  }
}

function RecipientDialog({
  open,
  onOpenChange,
  form,
  setForm,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: RecipientFormState;
  setForm: Dispatch<SetStateAction<RecipientFormState>>;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{form.id ? 'Edit Recipient' : 'Add Recipient'}</DialogTitle>
          <DialogDescription>Manage who receives dashboard notifications and operational reports.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="recipient-email">Email</Label>
              <Input id="recipient-email" type="email" className="mt-2" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
            </div>
            <div>
              <Label htmlFor="recipient-name">Name</Label>
              <Input id="recipient-name" className="mt-2" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-700">Preferences</p>
            {[
              ['receiveErrorAlerts', 'Failure Alerts'],
              ['receiveDailyReports', 'Daily Reports'],
              ['receiveInventoryAlerts', 'Inventory Alerts'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={Boolean(form[key as keyof RecipientFormState])}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={onSubmit} disabled={isPending || !form.email || !form.name}>
              {form.id ? 'Save Changes' : 'Add Recipient'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [recipientDialogOpen, setRecipientDialogOpen] = useState(false);
  const [recipientForm, setRecipientForm] = useState<RecipientFormState>(EMPTY_RECIPIENT);
  const [thresholdForm, setThresholdForm] = useState<AlertThresholdSettings>(DEFAULT_THRESHOLDS);
  const [retryPolicyForm, setRetryPolicyForm] = useState<RetryPolicySettings>(DEFAULT_RETRY_POLICY);
  const [cronExpression, setCronExpression] = useState(DEFAULT_SCHEDULES.orderSync.expression);
  const [nextRuns, setNextRuns] = useState<string[]>([]);

  const { data: recipients, isLoading, isError } = useQuery({
    queryKey: ['settings-recipients'],
    queryFn: () => api.listNotificationRecipients(false),
  });

  const { data: alertThresholds } = useQuery({
    queryKey: ['alert-thresholds'],
    queryFn: () => getWithFallback('/settings/alert-thresholds', DEFAULT_THRESHOLDS),
  });

  const { data: syncSchedules } = useQuery({
    queryKey: ['sync-schedules'],
    queryFn: () => getWithFallback('/settings/sync-schedule', DEFAULT_SCHEDULES),
  });

  const { data: retryPolicy } = useQuery({
    queryKey: ['retry-policy'],
    queryFn: () => getWithFallback('/settings/retry-policy', DEFAULT_RETRY_POLICY),
  });

  useEffect(() => {
    if (alertThresholds) setThresholdForm(alertThresholds);
  }, [alertThresholds]);

  useEffect(() => {
    if (retryPolicy) setRetryPolicyForm(retryPolicy);
  }, [retryPolicy]);

  useEffect(() => {
    if (syncSchedules) setCronExpression(syncSchedules.orderSync.expression);
  }, [syncSchedules]);

  const saveRecipientMutation = useMutation({
    mutationFn: async (form: RecipientFormState) => {
      const payload: CreateNotificationRecipientDto = {
        email: form.email,
        name: form.name,
        role: 'DASHBOARD_USER',
        receiveErrorAlerts: form.receiveErrorAlerts,
        receiveDailyReports: form.receiveDailyReports,
        receiveInventoryAlerts: form.receiveInventoryAlerts,
      };

      if (form.id) {
        await api.updateNotificationRecipient(form.id, payload);
        const togglePayload: Partial<CreateNotificationRecipientDto> & { isActive: boolean } = { isActive: form.isActive };
        await api.updateNotificationRecipient(form.id, togglePayload);
        return;
      }

      await api.createNotificationRecipient(payload);
    },
    onSuccess: () => {
      toast.success('Recipient saved');
      setRecipientDialogOpen(false);
      setRecipientForm(EMPTY_RECIPIENT);
      void queryClient.invalidateQueries({ queryKey: ['settings-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => {
      const payload: Partial<CreateNotificationRecipientDto> & { isActive: boolean } = { isActive };
      return api.updateNotificationRecipient(id, payload);
    },
    onSuccess: () => {
      toast.success('Recipient updated');
      void queryClient.invalidateQueries({ queryKey: ['settings-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNotificationRecipient(id),
    onSuccess: () => {
      toast.success('Recipient deleted');
      void queryClient.invalidateQueries({ queryKey: ['settings-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveThresholdsMutation = useMutation({
    mutationFn: (payload: AlertThresholdSettings) => apiRequest('/settings/alert-thresholds', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => {
      toast.success('Alert thresholds saved');
      void queryClient.invalidateQueries({ queryKey: ['alert-thresholds'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const validateCronMutation = useMutation({
    mutationFn: (expression: string) => apiRequest<CronValidationResult>('/settings/sync-schedule/validate', { method: 'POST', body: JSON.stringify({ expression }) }),
    onSuccess: (result) => {
      setNextRuns(result.nextRuns ?? []);
      toast.success('Cron expression validated');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveRetryPolicyMutation = useMutation({
    mutationFn: (payload: RetryPolicySettings) => apiRequest('/settings/retry-policy', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => {
      toast.success('Retry policy saved');
      void queryClient.invalidateQueries({ queryKey: ['retry-policy'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const recipientRows = useMemo(() => recipients ?? [], [recipients]);

  if (isLoading) {
    return <div className="py-16 text-center text-gray-500">Loading...</div>;
  }

  if (isError) {
    return <ErrorState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Integration Settings</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manage notification routing, operational thresholds, schedules, and retry behavior.</p>
        </div>
      </div>

      <Tabs defaultValue="notifications" className="space-y-6">
        <TabsList>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="thresholds">Alert Thresholds</TabsTrigger>
          <TabsTrigger value="schedule">Sync Schedule</TabsTrigger>
          <TabsTrigger value="retry-policy">Retry Policy</TabsTrigger>
        </TabsList>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle>Notification Recipients</CardTitle>
                  <CardDescription>Configure who receives operational, failure, and inventory notifications.</CardDescription>
                </div>
                <Button onClick={() => { setRecipientForm(EMPTY_RECIPIENT); setRecipientDialogOpen(true); }}>Add Recipient</Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Failure Alerts</TableHead>
                    <TableHead>Daily Reports</TableHead>
                    <TableHead>Inventory Alerts</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipientRows.map((recipient: NotificationRecipient) => (
                    <TableRow key={recipient.id}>
                      <TableCell>{recipient.email}</TableCell>
                      <TableCell className="font-medium">{recipient.name}</TableCell>
                      <TableCell>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={recipient.isActive}
                            onChange={(event) => toggleActiveMutation.mutate({ id: recipient.id, isActive: event.target.checked })}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          {recipient.isActive ? 'Active' : 'Inactive'}
                        </label>
                      </TableCell>
                      <TableCell>{recipient.receiveErrorAlerts ? 'Yes' : 'No'}</TableCell>
                      <TableCell>{recipient.receiveDailyReports ? 'Yes' : 'No'}</TableCell>
                      <TableCell>{recipient.receiveInventoryAlerts ? 'Yes' : 'No'}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setRecipientForm({
                                id: recipient.id,
                                email: recipient.email,
                                name: recipient.name,
                                receiveErrorAlerts: recipient.receiveErrorAlerts,
                                receiveDailyReports: recipient.receiveDailyReports,
                                receiveInventoryAlerts: recipient.receiveInventoryAlerts,
                                isActive: recipient.isActive,
                              });
                              setRecipientDialogOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 hover:bg-red-50"
                            onClick={() => {
                              if (window.confirm(`Delete recipient ${recipient.email}?`)) {
                                deleteMutation.mutate(recipient.id);
                              }
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {recipientRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-gray-500">No notification recipients configured.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="thresholds">
          <Card>
            <CardHeader>
              <CardTitle>Alert Thresholds</CardTitle>
              <CardDescription>Update the triggers used by the monitoring and alerting pipeline.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    ['failureRateThreshold', 'Failure Rate Threshold (%)'],
                    ['latencyThresholdMs', 'Latency Threshold (ms)'],
                    ['maxQueueDepth', 'Max Queue Depth'],
                    ['alertCooldownMinutes', 'Alert Cooldown (minutes)'],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label htmlFor={key}>{label}</Label>
                    <Input
                      id={key}
                      type="number"
                      className="mt-2"
                      value={thresholdForm[key]}
                      onChange={(event) => setThresholdForm((current) => ({ ...current, [key]: Number(event.target.value) }))}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button onClick={() => saveThresholdsMutation.mutate(thresholdForm)} disabled={saveThresholdsMutation.isPending}>Save Thresholds</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schedule">
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              {syncSchedules && (
                [
                  ['Order Sync', syncSchedules.orderSync],
                  ['Retry Failed', syncSchedules.retryFailed],
                  ['Health Check', syncSchedules.healthCheck],
                ] as const
              ).map(([label, item]) => (
                <Card key={label}>
                  <CardHeader>
                    <CardDescription>{label}</CardDescription>
                    <CardTitle className="font-mono text-base">{item.expression}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-gray-600">{item.description}</CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Cron Editor</CardTitle>
                <CardDescription>Validate a cron expression and preview the next three execution times.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="cron-expression">Cron Expression</Label>
                  <Input id="cron-expression" className="mt-2 font-mono" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => validateCronMutation.mutate(cronExpression)} disabled={validateCronMutation.isPending}>Validate Cron</Button>
                </div>
                <div className="rounded-lg border border-gray-200 p-4">
                  <p className="mb-3 text-sm font-medium text-gray-700">Next 3 run times</p>
                  {nextRuns.length === 0 ? (
                    <p className="text-sm text-gray-500">No validation results yet.</p>
                  ) : (
                    <ul className="space-y-2 text-sm text-gray-600">
                      {nextRuns.map((run) => (
                        <li key={run}>{formatDate(run)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="retry-policy">
          <Card>
            <CardHeader>
              <CardTitle>Retry Policy</CardTitle>
              <CardDescription>Tune retry attempts, delay windows, and exponential backoff behavior.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    ['maxRetries', 'Max Retries'],
                    ['initialDelayMs', 'Initial Delay ms'],
                    ['backoffMultiplier', 'Backoff Multiplier'],
                    ['maxDelayMs', 'Max Delay ms'],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label htmlFor={key}>{label}</Label>
                    <Input
                      id={key}
                      type="number"
                      className="mt-2"
                      value={retryPolicyForm[key]}
                      onChange={(event) => setRetryPolicyForm((current) => ({ ...current, [key]: Number(event.target.value) }))}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button onClick={() => saveRetryPolicyMutation.mutate(retryPolicyForm)} disabled={saveRetryPolicyMutation.isPending}>Save Retry Policy</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RecipientDialog
        open={recipientDialogOpen}
        onOpenChange={setRecipientDialogOpen}
        form={recipientForm}
        setForm={setRecipientForm}
        onSubmit={() => saveRecipientMutation.mutate(recipientForm)}
        isPending={saveRecipientMutation.isPending}
      />
    </div>
  );
}
