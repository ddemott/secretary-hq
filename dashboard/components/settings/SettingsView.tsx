'use client';

import React, { useState, useEffect } from 'react';
import { PlusCircle, Building2, UserPlus, ShieldCheck } from 'lucide-react';
import { Api } from '../../lib/api';
import { useSessionContext } from '../../lib/SessionContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { showToast } from '../ui/Toast';

// IA merge Phase 2b (2026-06-03): SettingsView is now SUPER-ADMIN ONLY — the
// multi-business onboarding console. Owner business configuration (calendar/CRM
// connections, resources) was a duplicate of what now lives under the Setup tab
// (BusinessSettingsView Connections + the Setup → Resources sub-tab), so the
// owner-mode block here was removed. A non-super-admin who reaches
// ?tab=settings via a stale link gets a pointer to Setup rather than a
// second, divergent copy of the config surface.
export default function SettingsView() {
  const { isAdmin: isSuperAdmin } = useSessionContext();

  const [templates, setTemplates] = useState<{ business_type: string; display_name: string }[]>([]);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);

  // Form State for onboarding
  const [form, setForm] = useState({
    tenant_name: '',
    business_type: '',
    owner_first_name: '',
    owner_last_name: '',
    owner_email: '',
    owner_pass: '',
  });

  useEffect(() => {
    if (isSuperAdmin) void fetchTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  async function fetchTemplates() {
    try {
      const data = await Api.templates.list();
      setTemplates(data);
    } catch {
      showToast('Failed to load templates', 'error');
    }
  }

  async function handleCreateOnboarding(e: React.FormEvent) {
    e.preventDefault();
    setOnboardingLoading(true);
    setOnboardingError(null);
    setSuccess(false);

    try {
      const res = await Api.tenants.create(form);
      if (res.success) {
        setSuccess(true);
        setForm({
          tenant_name: '',
          business_type: '',
          owner_first_name: '',
          owner_last_name: '',
          owner_email: '',
          owner_pass: '',
        });
      } else {
        setOnboardingError(res.error || 'Failed to create business');
      }
    } catch {
      setOnboardingError('Connection error to backend');
    } finally {
      setOnboardingLoading(false);
    }
  }

  if (!isSuperAdmin) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 text-center"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
      >
        <ShieldCheck className="w-10 h-10 mb-4" style={{ color: 'var(--text-muted)' }} />
        <h1 className="text-2xl font-display mb-2">Settings moved</h1>
        <p style={{ color: 'var(--text-secondary)', maxWidth: '28rem' }}>
          Business configuration — services, team, hours, calendar &amp; CRM connections — now lives
          under the <strong>Setup</strong> tab in the main navigation.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header
        className="p-4 md:p-8 sticky top-0 z-10 flex items-center"
        style={{
          borderBottom: '1px solid var(--border-soft)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        <div
          className="p-2 rounded-lg mr-4 shadow-md"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
        >
          <ShieldCheck className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-display">Business Onboarding</h1>
          <p className="text-sm italic font-medium" style={{ color: 'var(--text-secondary)' }}>
            Super-Admin Console (Multi-Business Management)
          </p>
        </div>
      </header>

      <div className="p-4 md:p-8 max-w-3xl space-y-8">
        {success && (
          <div className="p-4 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900/40 text-green-700 dark:text-green-400 rounded-xl flex items-center font-bold">
            Business created successfully! The owner can now log in.
          </div>
        )}

        {onboardingError && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-400 rounded-xl flex items-center font-bold">
            {onboardingError}
          </div>
        )}

        <form onSubmit={handleCreateOnboarding} className="space-y-8">
          {/* Business Info */}
          <section className="space-y-4">
            <h2
              className="text-lg font-bold flex items-center"
              style={{ color: 'var(--text-primary)' }}
            >
              <Building2 className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
              1. Business Information
            </h2>
            <Card
              className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6"
              style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
            >
              <Input
                label="Company Name"
                required
                value={form.tenant_name}
                onChange={(e) => setForm({ ...form, tenant_name: e.target.value })}
                placeholder="e.g. Sunny Day Spa"
              />
              <Select
                label="Business Template"
                required
                value={form.business_type}
                onChange={(e) => setForm({ ...form, business_type: e.target.value })}
                options={[
                  { label: 'Select a template...', value: '' },
                  ...templates.map((t) => ({ label: t.display_name, value: t.business_type })),
                ]}
              />
            </Card>
          </section>

          {/* Owner Info */}
          <section className="space-y-4">
            <h2
              className="text-lg font-bold flex items-center"
              style={{ color: 'var(--text-primary)' }}
            >
              <UserPlus className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
              2. Owner Account
            </h2>
            <Card
              className="space-y-4 p-6"
              style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Input
                  label="First Name"
                  required
                  value={form.owner_first_name}
                  onChange={(e) => setForm({ ...form, owner_first_name: e.target.value })}
                  placeholder="John"
                />
                <Input
                  label="Last Name"
                  required
                  value={form.owner_last_name}
                  onChange={(e) => setForm({ ...form, owner_last_name: e.target.value })}
                  placeholder="Doe"
                />
                <Input
                  label="Email"
                  type="email"
                  required
                  value={form.owner_email}
                  onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
                  placeholder="owner@business.com"
                />
              </div>
              <Input
                label="Password"
                type="password"
                required
                value={form.owner_pass}
                onChange={(e) => setForm({ ...form, owner_pass: e.target.value })}
                placeholder="••••••••"
              />
            </Card>
          </section>

          <Button
            type="submit"
            disabled={onboardingLoading}
            isLoading={onboardingLoading}
            className="w-full py-4 text-lg"
            icon={PlusCircle}
          >
            Finalize &amp; Create Business
          </Button>
        </form>
      </div>
    </div>
  );
}
