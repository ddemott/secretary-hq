'use client';

import React, { useState } from 'react';
import { User, Mail, Shield, Lock, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useSessionContext } from '../../lib/SessionContext';
import { useTheme, THEMES } from '@/lib/ThemeContext';
import { Api, forceLogout } from '../../lib/api';
import { useConfirm } from '../../lib/useConfirm';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { showToast } from '../ui/Toast';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  front_desk: 'Front Desk',
};

export default function ProfileView() {
  const { userName, userEmail, isAdmin, role } = useSessionContext();
  const { theme, setTheme } = useTheme();
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();
  const [revoking, setRevoking] = useState(false);

  function handleRevokeAllSessions() {
    confirmAction({
      title: 'Log out of all sessions?',
      message:
        'Every device signed in to your account — including this one — will be logged out immediately. You will need to sign in again.',
      confirmLabel: 'Log out everywhere',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeConfirm();
        setRevoking(true);
        // apiMutate rethrows network/fetch errors — without try/catch the button
        // would stay stuck spinning with no feedback. On success we forceLogout()
        // (hard nav), so the finally reset is effectively a no-op there; the catch
        // is what rescues the throw path with a toast.
        try {
          const res = await Api.users.revokeMySessions();
          if (res.success) {
            // The current token is now invalid too — clear it and go to login.
            forceLogout();
          } else {
            showToast(res.error || 'Could not log out of all sessions', 'error');
          }
        } catch (err) {
          showToast(
            err instanceof Error ? err.message : 'Could not log out of all sessions',
            'error'
          );
        } finally {
          setRevoking(false);
        }
      },
    });
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header className="mb-8 flex items-center">
        <div
          className="p-2 rounded-lg mr-4"
          style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
        >
          <User className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl font-display">My Profile</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Your account details and preferences</p>
        </div>
      </header>

      <div className="max-w-2xl space-y-6">
        {/* Account Info */}
        <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
          <fieldset>
            <legend
              className="text-xs font-bold uppercase tracking-widest mb-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              Account
            </legend>
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
                  style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
                >
                  {userName ? userName.charAt(0).toUpperCase() : 'U'}
                </div>
                <div>
                  <div className="font-bold text-sm">{userName || 'Not set'}</div>
                  <div
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <Mail className="w-3 h-3" />
                    {userEmail || 'Not set'}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {!isAdmin && (
                    <span
                      className="px-2.5 py-1 rounded-full text-xs font-medium"
                      style={{ backgroundColor: 'var(--bg-base)', color: 'var(--text-secondary)' }}
                    >
                      {ROLE_LABELS[role] ?? role}
                    </span>
                  )}
                  {isAdmin && (
                    <div
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-widest"
                      style={{
                        backgroundColor: 'var(--accent-muted)',
                        color: 'var(--accent-soft)',
                      }}
                    >
                      <Shield className="w-3 h-3" />
                      Admin
                    </div>
                  )}
                </div>
              </div>
            </div>
          </fieldset>
        </Card>

        {/* Theme Preference */}
        <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
          <fieldset>
            <legend
              className="text-xs font-bold uppercase tracking-widest mb-1"
              style={{ color: 'var(--text-secondary)' }}
            >
              Appearance
            </legend>
            {/* The page header calls this an "account" preference, but setTheme()
                only ever writes to localStorage (dashboard/lib/ThemeContext.tsx) —
                there is no backend column and nothing syncs it. An owner who picks
                a theme here, then opens the dashboard on their phone or a second
                browser, lands back on Navy with no explanation. Say so plainly
                rather than let the page's own "account preferences" framing imply
                persistence this control doesn't have. */}
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Saved to this browser only — it won&apos;t follow you to a different device or
              browser.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  aria-pressed={theme === t.id}
                  className="p-3 rounded-xl border text-left transition-all"
                  style={{
                    borderColor: theme === t.id ? 'var(--accent)' : 'var(--border-soft)',
                    backgroundColor: theme === t.id ? 'var(--accent-muted)' : 'var(--bg-surface)',
                  }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div
                      className="w-4 h-4 rounded-full border"
                      style={{
                        backgroundColor: t.preview.accent,
                        borderColor: 'var(--border-soft)',
                      }}
                    />
                    <span
                      className="text-xs font-bold"
                      style={{
                        color: theme === t.id ? 'var(--accent-soft)' : 'var(--text-primary)',
                      }}
                    >
                      {t.name}
                    </span>
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          </fieldset>
        </Card>

        {/* Account facts — session is JWT-managed; password reset is handled via the login flow */}
        <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
          <fieldset>
            <legend
              className="text-xs font-bold uppercase tracking-widest mb-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              Security
            </legend>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Shield
                  className="w-3.5 h-3.5 shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                  aria-hidden="true"
                />
                <span style={{ color: 'var(--text-secondary)' }}>
                  Sessions expire after 8 hours and auto-logout on 401.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Lock
                  className="w-3.5 h-3.5 shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                  aria-hidden="true"
                />
                <Link
                  href="/forgot-password"
                  className="text-sm hover:underline"
                  style={{ color: 'var(--accent-soft)' }}
                >
                  Change password
                </Link>
              </div>
              {/* The other two rows in this fieldset each explain themselves
                  (session expiry fact; the log-out-everywhere caption below) —
                  this link was the one control with zero indication of what
                  clicking it does before navigating away from the dashboard. */}
              <p className="text-xs pl-[22px]" style={{ color: 'var(--text-muted)' }}>
                Emails a reset link to your account address; it expires in 30 minutes.
              </p>
              <div className="pt-3 mt-3 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                <Button
                  variant="danger"
                  icon={LogOut}
                  isLoading={revoking}
                  onClick={handleRevokeAllSessions}
                >
                  Log out of all sessions
                </Button>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Signs you out on every device, including this one. Use this if you left yourself
                  logged in somewhere or suspect someone else has your password.
                </p>
              </div>
            </div>
          </fieldset>
        </Card>
      </div>

      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
