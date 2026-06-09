'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, CreateNotificationRecipientDto } from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<CreateNotificationRecipientDto>({
    email: '',
    name: '',
    role: '',
    receiveErrorAlerts: true,
    receiveDailyReports: false,
    receiveInventoryAlerts: false,
  });

  const { data: recipients, isLoading } = useQuery({
    queryKey: ['notification-recipients'],
    queryFn: () => api.listNotificationRecipients(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateNotificationRecipientDto) => api.createNotificationRecipient(data),
    onSuccess: () => {
      toast.success('Recipient added');
      setShowAdd(false);
      setForm({ email: '', name: '', role: '', receiveErrorAlerts: true, receiveDailyReports: false, receiveInventoryAlerts: false });
      void qc.invalidateQueries({ queryKey: ['notification-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.updateNotificationRecipient(id, { isActive }),
    onSuccess: () => {
      toast.success('Recipient updated');
      void qc.invalidateQueries({ queryKey: ['notification-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNotificationRecipient(id),
    onSuccess: () => {
      toast.success('Recipient removed');
      void qc.invalidateQueries({ queryKey: ['notification-recipients'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Notification Recipients</h1>
        <Button onClick={() => setShowAdd(true)}>Add Recipient</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recipients ({recipients?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-3 pr-4">Name</th>
                    <th className="pb-3 pr-4">Email</th>
                    <th className="pb-3 pr-4">Role</th>
                    <th className="pb-3 pr-4">Error Alerts</th>
                    <th className="pb-3 pr-4">Daily Reports</th>
                    <th className="pb-3 pr-4">Inventory</th>
                    <th className="pb-3 pr-4">Active</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recipients?.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 font-medium">{r.name}</td>
                      <td className="py-3 pr-4 text-gray-500">{r.email}</td>
                      <td className="py-3 pr-4 text-gray-500">{r.role}</td>
                      <td className="py-3 pr-4 text-center">{r.receiveErrorAlerts ? '✓' : '—'}</td>
                      <td className="py-3 pr-4 text-center">{r.receiveDailyReports ? '✓' : '—'}</td>
                      <td className="py-3 pr-4 text-center">{r.receiveInventoryAlerts ? '✓' : '—'}</td>
                      <td className="py-3 pr-4">
                        <span className={r.isActive ? 'text-green-600' : 'text-red-500'}>{r.isActive ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="flex gap-1 py-3">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleActiveMutation.mutate({ id: r.id, isActive: !r.isActive })}
                        >
                          {r.isActive ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 hover:bg-red-50"
                          onClick={() => deleteMutation.mutate(r.id)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!recipients || recipients.length === 0) && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-gray-400">
                        No notification recipients configured
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Notification Recipient</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label htmlFor="role">Role</Label>
              <Input id="role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} placeholder="e.g. OPS, FINANCE, DEV" />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700">Notification Preferences</p>
              {[
                { key: 'receiveErrorAlerts', label: 'Error Alerts' },
                { key: 'receiveDailyReports', label: 'Daily Reports' },
                { key: 'receiveInventoryAlerts', label: 'Inventory Alerts' },
              ].map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form[key as keyof CreateNotificationRecipientDto]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button
                disabled={!form.email || !form.name || !form.role || createMutation.isPending}
                onClick={() => createMutation.mutate(form)}
              >
                Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
