'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  api,
  type AreaDefinition,
  type CreateUserPayload,
  type DashboardUser,
} from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  UserCog,
} from 'lucide-react';

const ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;

const ROLE_HINT: Record<string, string> = {
  ADMIN: 'Full access, including credentials and user management.',
  OPERATOR: 'Runs the integration. No credentials, settings or user management.',
  VIEWER: 'Read-only: dashboards, reports, reconciliation and audit.',
};

interface UserFormState {
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  /** null = inherit the role defaults; an array pins an explicit selection. */
  areaOverrides: string[] | null;
  password: string;
}

const EMPTY_FORM: UserFormState = {
  email: '',
  name: '',
  role: 'VIEWER',
  isActive: true,
  areaOverrides: null,
  password: '',
};

function roleBadge(role: string) {
  if (role === 'ADMIN') return 'bg-indigo-100 text-indigo-700';
  if (role === 'OPERATOR') return 'bg-blue-100 text-blue-700';
  return 'bg-slate-100 text-slate-600';
}

/** Groups the catalogue the way the sidebar is grouped, preserving API order. */
function groupAreas(areas: AreaDefinition[]) {
  const groups = new Map<string, AreaDefinition[]>();
  for (const area of areas) {
    const list = groups.get(area.group) ?? [];
    list.push(area);
    groups.set(area.group, list);
  }
  return [...groups.entries()];
}

function AreaPicker({
  areas,
  value,
  onChange,
}: {
  areas: AreaDefinition[];
  /** null = inherit role defaults. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const inherit = value === null;
  const selected = new Set(value ?? []);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Unticking the last area means "inherit" rather than "see nothing" —
    // an account with zero areas would land on a blank shell.
    onChange(next.size === 0 ? null : [...next]);
  };

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={inherit}
          onChange={(e) => onChange(e.target.checked ? null : [])}
        />
        <span className="text-sm">
          <span className="font-medium text-slate-800">
            Use the role&apos;s default areas
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">
            Untick to pick exactly what this person sees. A selection can only
            narrow the role, never widen it.
          </span>
        </span>
      </label>

      {!inherit && (
        <div className="max-h-72 space-y-4 overflow-y-auto rounded-lg border border-slate-200 p-3">
          {groupAreas(areas).map(([group, groupAreas_]) => (
            <div key={group}>
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                {group}
              </p>
              <div className="space-y-1.5">
                {groupAreas_.map((area) => (
                  <label key={area.key} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(area.key)}
                      onChange={() => toggle(area.key)}
                    />
                    <span className="text-sm">
                      <span className="font-medium text-slate-800">
                        {area.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {area.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();

  const {
    data: users,
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });

  const { data: areas } = useQuery({
    queryKey: ['user-areas'],
    queryFn: () => api.listAreas(),
    staleTime: 10 * 60 * 1000,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DashboardUser | null>(null);
  const [form, setForm] = useState<UserFormState>(EMPTY_FORM);
  const [issuedPassword, setIssuedPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const areaList = useMemo(() => areas ?? [], [areas]);
  const areaLabels = useMemo(
    () => new Map(areaList.map((a) => [a.key, a.label])),
    [areaList],
  );

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (user: DashboardUser) => {
    setEditing(user);
    setForm({
      email: user.email,
      name: user.name ?? '',
      role: user.role,
      isActive: user.isActive,
      areaOverrides: user.areaOverrides,
      password: '',
    });
    setDialogOpen(true);
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    // The signed-in admin may have just changed their own visibility.
    void qc.invalidateQueries({ queryKey: ['auth-me'] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        return api.updateUser(editing.id, {
          name: form.name,
          role: form.role,
          isActive: form.isActive,
          areaOverrides: form.areaOverrides,
        });
      }
      const payload: CreateUserPayload = {
        email: form.email,
        name: form.name || undefined,
        role: form.role,
        isActive: form.isActive,
        areaOverrides: form.areaOverrides,
        ...(form.password ? { password: form.password } : {}),
      };
      return api.createUser(payload);
    },
    onSuccess: (result) => {
      const created =
        result && 'temporaryPassword' in result ? result : undefined;
      if (created?.temporaryPassword) {
        setIssuedPassword({
          email: created.user.email,
          password: created.temporaryPassword,
        });
      }
      toast.success(editing ? 'User updated' : 'User created');
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not save the user'),
  });

  const resetPassword = useMutation({
    mutationFn: (user: DashboardUser) => api.resetUserPassword(user.id),
    onSuccess: (result, user) => {
      setIssuedPassword({ email: user.email, password: result.temporaryPassword });
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not reset the password'),
  });

  const remove = useMutation({
    mutationFn: (user: DashboardUser) => api.deleteUser(user.id),
    onSuccess: () => {
      toast.success('User deleted');
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not delete the user'),
  });

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load users'}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        subtitle="Who can sign in to the dashboard, and which areas each person sees."
        icon={UserCog}
      >
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Add user
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            Accounts
          </CardTitle>
          <CardDescription>
            A role sets the ceiling; area overrides narrow it further. Changes
            take effect the next time the person&apos;s dashboard refreshes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
          ) : (users?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              No accounts yet. The ADMIN_EMAIL bootstrap account appears here
              after its first sign-in.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Visibility</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sign-in</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users?.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="font-medium text-slate-800">
                          {user.name || user.email}
                        </div>
                        <div className="text-xs text-slate-500">{user.email}</div>
                      </TableCell>
                      <TableCell>
                        <Badge className={roleBadge(user.role)}>{user.role}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {user.areaOverrides === null ? (
                          <span className="text-xs text-slate-500">
                            Role defaults ({user.effectiveAreas.length} areas)
                          </span>
                        ) : (
                          <span className="text-xs text-slate-700">
                            {user.effectiveAreas
                              .map((k) => areaLabels.get(k) ?? k)
                              .join(', ')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {user.isActive ? (
                          <Badge className="bg-emerald-100 text-emerald-700">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="destructive">Disabled</Badge>
                        )}
                        {user.mustChangePassword && (
                          <div className="mt-1 text-[11px] text-amber-600">
                            Must change password
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(user)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            title="Issue a temporary password"
                            onClick={() => resetPassword.mutate(user)}
                            disabled={resetPassword.isPending}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            title={
                              user.id === profile?.id
                                ? 'You cannot delete your own account'
                                : 'Delete this account'
                            }
                            disabled={
                              user.id === profile?.id || remove.isPending
                            }
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete ${user.email}? They will lose access immediately.`,
                                )
                              ) {
                                remove.mutate(user);
                              }
                            }}
                            className="text-red-600 hover:border-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / edit */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit user' : 'Add user'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Email cannot be changed — delete and recreate the account instead.'
                : 'Leave the password blank to have a temporary one generated.'}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="user-email">Email</Label>
                <Input
                  id="user-email"
                  type="email"
                  required
                  disabled={!!editing}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="user-name">Name</Label>
                <Input
                  id="user-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>

            {!editing && (
              <div>
                <Label htmlFor="user-password">Password (optional)</Label>
                <Input
                  id="user-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Generate a temporary password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
            )}

            <div>
              <Label htmlFor="user-role">Role</Label>
              <select
                id="user-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {ROLE_HINT[form.role]}
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              Account is active
            </label>

            <div>
              <Label>Area visibility</Label>
              <div className="mt-2">
                <AreaPicker
                  areas={areaList}
                  value={form.areaOverrides}
                  onChange={(next) => setForm({ ...form, areaOverrides: next })}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time password hand-off */}
      <Dialog
        open={issuedPassword !== null}
        onOpenChange={(open) => !open && setIssuedPassword(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              This is shown once. Give it to {issuedPassword?.email} over a
              channel you trust — they will be asked to change it at sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <code className="flex-1 break-all font-mono text-sm text-slate-800">
              {issuedPassword?.password}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (issuedPassword) {
                  void navigator.clipboard.writeText(issuedPassword.password);
                  toast.success('Copied');
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssuedPassword(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
