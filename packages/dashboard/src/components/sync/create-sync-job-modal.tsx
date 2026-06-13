'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CreateSyncJobDto } from '@/lib/api';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const initialForm: CreateSyncJobDto = {
  jobType: 'ORDER_SYNC',
  scopeType: 'ALL',
  createdBy: 'DASHBOARD_USER',
};

export function CreateSyncJobModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateSyncJobDto>(initialForm);

  const mutation = useMutation({
    mutationFn: api.createSyncJob,
    onSuccess: () => {
      toast.success('Sync job created successfully');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
      setOpen(false);
      setForm(initialForm);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const update = (key: keyof CreateSyncJobDto, value?: string | string[]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> New Sync Job
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Sync Job</DialogTitle>
          <DialogDescription>Configure the job type and scope, then submit to queue a new sync job.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="jobType">Job Type</Label>
            <select
              id="jobType"
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
              value={form.jobType}
              onChange={(event) => update('jobType', event.target.value)}
            >
              {['ORDER_SYNC', 'INVENTORY_SYNC', 'PAYMENT_SYNC', 'CONFIG_SYNC', 'REFUND_SYNC'].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="scopeType">Scope Type</Label>
            <select
              id="scopeType"
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
              value={form.scopeType}
              onChange={(event) => {
                const scopeType = event.target.value;
                setForm({ ...initialForm, jobType: form.jobType, scopeType });
              }}
            >
              {['ALL', 'SINGLE_ORDER', 'DATE_RANGE', 'BRANCH', 'BRANCH_DATE_RANGE', 'FAILED_ONLY'].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
          {form.scopeType === 'SINGLE_ORDER' && (
            <div>
              <Label htmlFor="orderIds">Order IDs (comma-separated)</Label>
              <Input
                id="orderIds"
                placeholder="ORD-001, ORD-002"
                onChange={(event) =>
                  update(
                    'orderIds',
                    event.target.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  )
                }
              />
            </div>
          )}
          {form.scopeType === 'BRANCH' && (
            <div>
              <Label htmlFor="branchCode">Branch Code</Label>
              <Input id="branchCode" placeholder="STORE-001" onChange={(event) => update('branchCode', event.target.value)} />
            </div>
          )}
          {form.scopeType === 'BRANCH_DATE_RANGE' && (
            <>
              <div>
                <Label htmlFor="branchCodeBdr">Branch Code</Label>
                <Input id="branchCodeBdr" placeholder="STORE-001" onChange={(event) => update('branchCode', event.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="startDateBdr">Start Date</Label>
                  <Input id="startDateBdr" type="date" onChange={(event) => update('startDate', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="endDateBdr">End Date</Label>
                  <Input id="endDateBdr" type="date" onChange={(event) => update('endDate', event.target.value)} />
                </div>
              </div>
            </>
          )}
          {form.scopeType === 'DATE_RANGE' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="startDate">Start Date</Label>
                <Input id="startDate" type="date" onChange={(event) => update('startDate', event.target.value)} />
              </div>
              <div>
                <Label htmlFor="endDate">End Date</Label>
                <Input id="endDate" type="date" onChange={(event) => update('endDate', event.target.value)} />
              </div>
            </div>
          )}
          <Button className="w-full" onClick={() => mutation.mutate(form)} disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating...' : 'Create Job'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
