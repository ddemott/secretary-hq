'use client';

import React, { useState } from 'react';
import { Mail, Loader2, Bot, ArrowLeft } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (res.status === 429) {
          // Fastify rate-limit (3 requests / hour on this route) throws its own
          // error shape: `error` is the generic HTTP reason phrase ("Too Many
          // Requests"), `message` carries the actual "retry in N" wait time.
          // Showing the bare reason phrase left a locked-out owner with no
          // idea how long to wait before trying again.
          setError(data.message ?? 'Too many requests. Please wait a while and try again.');
        } else {
          setError(data.error ?? 'Something went wrong. Please try again.');
        }
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 font-sans"
      style={{ backgroundColor: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-xl overflow-hidden border"
        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-soft)' }}
      >
        <div
          className="p-8 flex flex-col items-center"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
        >
          <div className="bg-white/20 p-3 rounded-xl mb-4 backdrop-blur-sm">
            <Bot className="w-10 h-10" />
          </div>
          <h1 className="text-2xl font-display tracking-tight">Reset your password</h1>
        </div>

        <div className="p-8">
          {submitted ? (
            <div role="status" className="text-sm" style={{ color: 'var(--text-primary)' }}>
              <p className="mb-4">
                If an account exists for that email, a reset link has been sent.
              </p>
              <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
                The link expires in 30 minutes. Check your inbox (and spam folder).
              </p>
              <a
                href="/dashboard"
                className="inline-flex items-center text-sm hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                <ArrowLeft className="w-4 h-4 mr-1" /> Back to login
              </a>
            </div>
          ) : (
            <>
              {error && (
                <div
                  role="alert"
                  className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 text-red-700 dark:text-red-400 text-sm rounded-r-md"
                >
                  {error}
                </div>
              )}
              <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
                Enter your email and we&apos;ll send you a link to reset your password.
              </p>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label
                    htmlFor="forgot-email"
                    className="block text-xs font-bold uppercase tracking-wider mb-2 ml-1"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Email
                  </label>
                  <div className="relative">
                    <Mail
                      aria-hidden="true"
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                      style={{ color: 'var(--text-muted)' }}
                    />
                    <input
                      id="forgot-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      className="w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                      style={
                        {
                          backgroundColor: 'var(--bg-raised)',
                          borderColor: 'var(--border-soft)',
                          color: 'var(--text-primary)',
                          '--tw-ring-color': 'var(--accent-glow)',
                        } as React.CSSProperties
                      }
                      placeholder="you@example.com"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                  className="w-full py-4 text-white rounded-xl font-bold text-sm shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center"
                  style={{ backgroundColor: 'var(--accent)' }}
                >
                  {loading ? (
                    <>
                      <Loader2 aria-hidden="true" className="w-5 h-5 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send reset link'
                  )}
                </button>
                <div className="text-center">
                  <a
                    href="/dashboard"
                    className="text-xs hover:underline"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Back to login
                  </a>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
