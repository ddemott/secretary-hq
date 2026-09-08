'use client';

import React, { useEffect, useState } from 'react';
import {
  Bot,
  Lock,
  Mail,
  User,
  Building2,
  Briefcase,
  Loader2,
  Eye,
  EyeOff,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import { API_BASE_URL, Api } from '@/lib/api';
import type { BusinessTemplate } from '@/lib/types';

/**
 * Self-serve signup page. Wires the long-existing public POST /register
 * endpoint (createTenantWithOwner: new tenant + owner user, returns a JWT)
 * to a UI — previously there was none, so the only way in was an owner
 * invite, a super-admin tenant create, or the seed accounts.
 *
 * Mirrors LoginView/forgot-password: standalone client page, direct fetch,
 * stores the same localStorage keys the dashboard reads on mount, then
 * redirects to /dashboard (which opens the setup wizard for the empty
 * tenant). Business types are pulled from the public /templates list.
 */
export default function RegisterPage() {
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [templates, setTemplates] = useState<BusinessTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreedToLegal, setAgreedToLegal] = useState(false);

  // Populate the business-type picker from the public templates endpoint —
  // same source TenantCreateForm uses, so the values match what the backend
  // expects. Failure is non-fatal: the field falls back to a free-text input.
  //
  // Intentionally do NOT pre-select the first template. A defaulted business
  // type silently locks in a stranger's choice (whichever sorted first —
  // "Answering & Scheduling Service") and looked like a filled-in field to
  // Dale in the 2026-05-28 walkthrough. The empty value forces the owner to
  // pick deliberately.
  useEffect(() => {
    Api.templates
      .list()
      .then((t) => {
        setTemplates(t);
      })
      .catch(() => {
        /* leave templates empty → free-text fallback below */
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Re-entry guard: a fast double-click can fire submit twice before React
    // commits the disabled state. The backend's email dup-check would 409 the
    // second request, but guarding here avoids the wasted round-trip + the
    // brief race window where two in-flight registers could both pass the
    // pre-insert email check.
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_name: businessName.trim(),
          business_type: businessType.trim(),
          owner_name: ownerName.trim(),
          email: email.trim(),
          password,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        tenant_id?: string;
        user_name?: string;
        role?: string;
        token?: string;
        error?: string;
      };

      if (res.ok && data.success) {
        // Same keys LoginView writes — the dashboard authenticates off these
        // on mount, so the new owner lands signed-in.
        localStorage.setItem('tenantId', data.tenant_id ?? '');
        localStorage.setItem('userName', data.user_name ?? '');
        localStorage.setItem('userEmail', email.trim());
        // Register always returns an owner; persist it so SessionContext
        // (which reads 'userRole' on mount) shows owner/advanced nav
        // immediately rather than falling back to the default.
        localStorage.setItem('userRole', data.role || 'owner');
        if (data.token) localStorage.setItem('authToken', data.token);
        window.location.href = '/dashboard';
      } else if (res.status === 409) {
        setError(data.error || 'An account with that email already exists. Try signing in.');
      } else {
        setError(data.error || 'Could not create your account. Please try again.');
      }
    } catch {
      setError("Couldn't connect. Check your internet and try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    backgroundColor: 'var(--bg-raised)',
    borderColor: 'var(--border-soft)',
    color: 'var(--text-primary)',
    '--tw-ring-color': 'var(--accent-glow)',
  } as React.CSSProperties;

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 font-sans transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-xl overflow-hidden border"
        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-soft)' }}
      >
        {/* Header/Logo — matches LoginView */}
        <div
          className="p-8 flex flex-col items-center"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
        >
          <div className="bg-white/20 p-3 rounded-xl mb-4 backdrop-blur-sm">
            <Bot className="w-10 h-10" />
          </div>
          <h1 className="text-2xl font-display tracking-tight">Create your account</h1>
          <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
            14-day free trial · No credit card
          </p>
        </div>

        <div className="p-8">
          {error && (
            <div
              role="alert"
              className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 text-red-700 dark:text-red-400 text-sm rounded-r-md"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="reg-business"
                className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Business name
              </label>
              <div className="relative">
                <Building2
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                  aria-hidden="true"
                />
                <input
                  id="reg-business"
                  type="text"
                  required
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={inputStyle}
                  placeholder="Your business name"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="reg-type"
                className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Business type
              </label>
              <div className="relative">
                <Briefcase
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 z-10"
                  aria-hidden="true"
                />
                {templates.length > 0 ? (
                  <select
                    id="reg-type"
                    required
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value)}
                    className="w-full pl-11 pr-10 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm appearance-none"
                    style={inputStyle}
                  >
                    <option value="" disabled>
                      Select your business type…
                    </option>
                    {[...templates]
                      .sort((a, b) => a.display_name.localeCompare(b.display_name))
                      .map((t) => (
                        <option key={t.business_type} value={t.business_type}>
                          {t.display_name}
                        </option>
                      ))}
                  </select>
                ) : null}
                {templates.length > 0 && (
                  // appearance-none strips the native dropdown arrow — add a
                  // visible chevron so the field reads as a select, not a box.
                  <ChevronDown
                    aria-hidden="true"
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                  />
                )}
                {templates.length === 0 && (
                  <input
                    id="reg-type"
                    type="text"
                    required
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                    style={inputStyle}
                    placeholder="e.g. salon, auto-shop, mobile-tire"
                  />
                )}
              </div>
            </div>

            <div>
              <label
                htmlFor="reg-name"
                className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Your name
              </label>
              <div className="relative">
                <User
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                  aria-hidden="true"
                />
                <input
                  id="reg-name"
                  type="text"
                  required
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  autoComplete="name"
                  className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={inputStyle}
                  placeholder="Your full name"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="reg-email"
                className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Email
              </label>
              <div className="relative">
                <Mail
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                  aria-hidden="true"
                />
                <input
                  id="reg-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={inputStyle}
                  placeholder="you@business.com"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="reg-password"
                className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Password
              </label>
              <div className="relative">
                <Lock
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                  aria-hidden="true"
                />
                <input
                  id="reg-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-describedby="reg-password-hint"
                  className="w-full pl-11 pr-12 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={inputStyle}
                  placeholder="At least 6 characters"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md hover:brightness-125 transition-all"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              <p
                id="reg-password-hint"
                className="mt-1.5 ml-1 text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                Use at least 6 characters.
              </p>
            </div>

            <label
              className="flex items-start gap-3 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <input
                id="reg-agree"
                type="checkbox"
                required
                checked={agreedToLegal}
                onChange={(e) => setAgreedToLegal(e.target.checked)}
                className="mt-1"
              />
              <span>
                I am authorized to set up Secretary HQ for this business. I agree to the{' '}
                <a href="/terms" className="underline" style={{ color: 'var(--accent-soft)' }}>
                  Terms of Service
                </a>
                ,{' '}
                <a href="/privacy" className="underline" style={{ color: 'var(--accent-soft)' }}>
                  Privacy Policy
                </a>
                , and{' '}
                <a href="/dpa" className="underline" style={{ color: 'var(--accent-soft)' }}>
                  Data Protection Addendum
                </a>
                . I understand an AI assistant answers calls on my behalf and I am responsible for
                informing my callers as required by law.
              </span>
            </label>

            <button
              type="submit"
              disabled={loading || !agreedToLegal}
              className="w-full py-4 text-white rounded-xl font-bold text-sm shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100 flex items-center justify-center"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" aria-hidden="true" />
                  Creating account...
                </>
              ) : (
                'Start free trial'
              )}
            </button>
          </form>

          <div
            className="mt-8 pt-6 border-t text-center"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Already have an account?{' '}
              <a
                href="/dashboard"
                className="font-semibold hover:underline inline-flex items-center gap-1"
                style={{ color: 'var(--accent-soft)' }}
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                Sign in
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
