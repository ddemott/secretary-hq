'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Plus, ShieldCheck, UserCircle2, LogOut } from 'lucide-react';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '@/lib/SessionContext';
import { useConfirm } from '../../lib/useConfirm';
import type { TeamUser } from '@/lib/types';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { showToast } from '../ui/Toast';
import { EmptyState } from '../ui/EmptyState';
import { InviteTeamMemberModal } from './InviteTeamMemberModal';

type Role = 'owner' | 'front_desk';

export default function TeamAccessView() {
  const tenantId = useActiveTenantId();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();

  const loadUsers = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const res = await Api.users.list(tenantId);
      setUsers(res.users);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not load team logins', 'error');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function handleInvite(data: { email: string; full_name: string; role: Role }) {
    if (!tenantId) return { success: false as const, error: 'No tenant' };
    const res = await Api.users.invite(tenantId, data);
    if (res.success) {
      showToast(`Invite sent to ${data.email}`, 'success');
      void loadUsers();
    }
    return res;
  }

  const handleRoleChange = async (user: TeamUser, nextRole: Role) => {
    if (!tenantId || nextRole === user.role) return;
    setPendingRoleId(user.user_id);
    const res = await Api.users.updateRole(user.user_id, tenantId, nextRole);
    setPendingRoleId(null);
    if (res.success) {
      setUsers((prev) =>
        prev.map((u) => (u.user_id === user.user_id ? { ...u, role: nextRole } : u))
      );
      showToast(`${user.email} is now ${nextRole === 'owner' ? 'Owner' : 'Front Desk'}`, 'success');
    } else {
      showToast(res.error || 'Could not update role', 'error');
    }
  };

  const handleRevokeSessions = (user: TeamUser) => {
    confirmAction({
      title: `Log out ${user.full_name || user.email}?`,
      message: `${user.email} will be signed out on every device immediately. They can sign back in with their existing password — use "change role" or a password reset if you need to remove access entirely.`,
      confirmLabel: 'Log out their sessions',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeConfirm();
        if (!tenantId) return;
        setPendingRevokeId(user.user_id);
        // apiMutate rethrows network/fetch errors — without try/catch the row
        // would stay stuck in its loading state with no feedback.
        try {
          const res = await Api.users.revokeUserSessions(user.user_id, tenantId);
          if (res.success) {
            showToast(`${user.email} has been logged out everywhere`, 'success');
          } else {
            showToast(res.error || 'Could not log out their sessions', 'error');
          }
        } catch (err) {
          showToast(
            err instanceof Error ? err.message : 'Could not log out their sessions',
            'error'
          );
        } finally {
          setPendingRevokeId(null);
        }
      },
    });
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto">
        <header className="flex items-start justify-between mb-6">
          <div>
            <h2
              className="text-2xl font-display tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Team Logins
            </h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              Invite staff to sign in. Owners see everything. Front Desk sees only the daily
              schedule, customers, and calls.
            </p>
          </div>
          <Button icon={Plus} onClick={() => setInviteOpen(true)} aria-label="Invite teammate">
            Invite
          </Button>
        </header>

        {loading && (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
            Loading…
          </div>
        )}

        {!loading && users.length === 0 && (
          <EmptyState
            icon={UserCircle2}
            title="No team logins yet"
            description="Invite your first teammate to get started."
            variant="compact"
            className="border rounded-xl"
          />
        )}

        {!loading && users.length > 0 && (
          <ul className="space-y-2" role="list">
            {users.map((u) => (
              <li
                key={u.user_id}
                className="flex items-center justify-between gap-4 p-4 border rounded-xl"
                style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {u.role === 'owner' ? (
                    <ShieldCheck
                      className="w-5 h-5 shrink-0"
                      style={{ color: 'var(--accent-soft)' }}
                      aria-hidden="true"
                    />
                  ) : (
                    <UserCircle2
                      className="w-5 h-5 shrink-0"
                      style={{ color: 'var(--text-secondary)' }}
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0">
                    <div
                      className="text-sm font-bold truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {u.full_name || u.email}
                      {u.is_self && (
                        <span
                          className="ml-2 text-xs uppercase tracking-wider px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: 'var(--accent-muted)',
                            color: 'var(--accent-soft)',
                          }}
                        >
                          You
                        </span>
                      )}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                      {u.email}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="sr-only" htmlFor={`role-${u.user_id}`}>
                    Role for {u.email}
                  </label>
                  <select
                    id={`role-${u.user_id}`}
                    value={u.role}
                    disabled={u.is_self || pendingRoleId === u.user_id}
                    onChange={(e) => void handleRoleChange(u, e.target.value as Role)}
                    className="text-xs rounded-md px-2 py-1.5 outline-none transition disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: 'var(--bg-raised)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                    title={
                      u.is_self ? "You can't change your own role" : `Change ${u.email}'s role`
                    }
                  >
                    <option value="owner">Owner</option>
                    <option value="front_desk">Front Desk</option>
                  </select>
                  {!u.is_self && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={LogOut}
                      isLoading={pendingRevokeId === u.user_id}
                      onClick={() => handleRevokeSessions(u)}
                      aria-label={`Log out ${u.email}'s sessions`}
                      title={`Sign ${u.email} out on every device`}
                    >
                      Log out sessions
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <InviteTeamMemberModal
        isOpen={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSubmit={handleInvite}
      />

      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
