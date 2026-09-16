'use client';

import React, { useState } from 'react';
import { Lock, Mail, Loader2, Bot, Eye, EyeOff } from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';

interface LoginViewProps {
  onLoginSuccess: (data: { tenant_id: string; user_name: string; role?: string }) => void;
}

export default function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // Guard JSON parse: a non-JSON error body (e.g. a gateway 502 HTML page)
      // would otherwise throw here and be mislabeled as a connection error. The
      // sibling auth pages (register/forgot/reset) guard the same way.
      // tenant_id/user_name are optional here BECAUSE the parse is guarded to {}
      // on a non-JSON body — the presence check below is what makes proceeding safe.
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        tenant_id?: string;
        user_name?: string;
        token?: string;
        role?: string;
        error?: string;
        message?: string;
      };

      if (response.ok && data.success && data.tenant_id && data.user_name) {
        localStorage.setItem('tenantId', data.tenant_id);
        localStorage.setItem('userName', data.user_name);
        localStorage.setItem('userEmail', email);
        if (data.token) localStorage.setItem('authToken', data.token);
        // Persist role so SessionContext reads the right tab set on next
        // mount. Missing from the original LoginView (register page set it
        // correctly). Without this, front-desk users saw owner-level tabs
        // after a fresh login if a prior owner-register left 'owner' in
        // localStorage. 2026-05-28 UX audit #5.
        if (data.role) localStorage.setItem('userRole', data.role);
        onLoginSuccess({ tenant_id: data.tenant_id, user_name: data.user_name, role: data.role });
      } else if (response.status === 429) {
        // Fastify's rate-limit plugin (5 attempts / 5 minutes on /login) throws
        // its own error shape, not ours: `error` is just the generic HTTP
        // reason phrase ("Too Many Requests"), while `message` carries the
        // actually useful "retry in N minutes" the plugin computed. Showing
        // the bare reason phrase told a locked-out owner nothing about how
        // long to wait — the same "control with no explanation" gap as an
        // unexplained disabled button.
        setError(data.message || 'Too many attempts. Please wait a few minutes and try again.');
      } else {
        setError(data.error || 'Sign in failed. Please try again.');
      }
    } catch {
      setError("Couldn't connect. Check your internet and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 font-sans transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-xl overflow-hidden border"
        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-soft)' }}
      >
        {/* Header/Logo */}
        <div
          className="p-8 flex flex-col items-center"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
        >
          <div className="bg-white/20 p-3 rounded-xl mb-4 backdrop-blur-sm">
            <Bot className="w-10 h-10" />
          </div>
          <h1 className="text-2xl font-display tracking-tight">Secretary HQ</h1>
          <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
            Your AI Receptionist
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

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="login-email"
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
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={
                    {
                      backgroundColor: 'var(--bg-raised)',
                      borderColor: 'var(--border-soft)',
                      color: 'var(--text-primary)',
                      '--tw-ring-color': 'var(--accent-glow)',
                    } as React.CSSProperties
                  }
                  placeholder="you@business.com"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="login-password"
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
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-12 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                  style={
                    {
                      backgroundColor: 'var(--bg-raised)',
                      borderColor: 'var(--border-soft)',
                      color: 'var(--text-primary)',
                      '--tw-ring-color': 'var(--accent-glow)',
                    } as React.CSSProperties
                  }
                  placeholder="••••••••"
                  autoComplete="current-password"
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
            </div>

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full py-4 text-white rounded-xl font-bold text-sm shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100 flex items-center justify-center"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" aria-hidden="true" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>

            <div className="text-center">
              <a
                href="/forgot-password"
                className="text-xs hover:underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                Forgot password?
              </a>
            </div>
          </form>

          {/* Self-serve signup CTA. The mailto placeholder (UX audit #8,
              2026-05-18) is now replaced with a real link: the /register
              page wires the long-existing public POST /register endpoint. */}
          <div
            className="mt-8 pt-6 border-t text-center"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Don&apos;t have an account?{' '}
              <a
                href="/register"
                className="font-semibold hover:underline"
                style={{ color: 'var(--accent-soft)' }}
              >
                Create an account
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
