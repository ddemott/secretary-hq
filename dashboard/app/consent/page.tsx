'use client';

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Bot, CheckCircle2, ShieldAlert } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api';

// Word-for-word identical to the /register page's legal-consent checkbox
// (dashboard/app/register/page.tsx) and to systemEmail.ts's
// TENANT_CONSENT_ATTESTATION_TEXT — the admin-provisioned-tenant consent
// flow must say the SAME thing the self-serve checkbox says.
const ATTESTATION_TEXT =
  'I am authorized to set up Secretary HQ for this business. I agree to the Terms of Service, ' +
  'Privacy Policy, and Data Protection Addendum. I understand an AI assistant answers calls on ' +
  'my behalf and I am responsible for informing my callers as required by law.';

function ConsentPageInner() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resend form state
  const [resendEmail, setResendEmail] = useState('');
  const [resendPassword, setResendPassword] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  const handleConfirm = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/consent/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        business_name?: string;
        error?: string;
        message?: string;
      };
      if (res.ok && data.success) {
        setConfirmed(true);
        setBusinessName(data.business_name || null);
      } else if (res.status === 429) {
        setError(data.message || 'Too many attempts. Please wait a while and try again.');
      } else {
        setError(data.error || 'This link is invalid or has expired.');
      }
    } catch {
      setError("Couldn't connect. Check your internet and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendLoading(true);
    try {
      await fetch(`${API_BASE_URL}/consent/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail, password: resendPassword }),
      });
      // /consent/resend always answers { success: true } regardless of
      // whether the email/password matched anything — same
      // enumeration-safe posture as /forgot-password. Show the same
      // confirmation either way.
      setResendSent(true);
    } catch {
      // Network failure — still show the same message; there is nothing
      // more specific and honest to say without leaking account state.
      setResendSent(true);
    } finally {
      setResendLoading(false);
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
          <h1 className="text-2xl font-display tracking-tight">Confirm your agreement</h1>
        </div>

        <div className="p-8">
          {confirmed ? (
            <div role="status" className="text-sm flex flex-col items-center text-center">
              <CheckCircle2 className="w-12 h-12 mb-4" style={{ color: 'var(--accent)' }} />
              <p className="mb-2 font-semibold">
                {businessName ? `${businessName} is confirmed.` : 'Confirmed.'}
              </p>
              <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
                Your dashboard is now unlocked.
              </p>
              <a
                href="/login"
                className="font-semibold hover:underline"
                style={{ color: 'var(--accent-soft)' }}
              >
                Go to login
              </a>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Before you can sign in, you must confirm the following:
              </p>
              <div
                className="mb-6 p-4 rounded-lg text-sm"
                style={{ backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
              >
                {ATTESTATION_TEXT}
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 text-red-700 dark:text-red-400 text-sm rounded-r-md"
                >
                  <p className="flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </p>
                </div>
              )}

              {!token && !error && (
                <p className="mb-6 text-sm text-red-600 dark:text-red-400" role="alert">
                  Missing confirmation token. Use the link from your email, or request a new one
                  below.
                </p>
              )}

              <button
                type="button"
                onClick={handleConfirm}
                disabled={loading || !token}
                aria-busy={loading}
                className="w-full py-4 text-white rounded-xl font-bold text-sm shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                {loading ? (
                  <>
                    <Loader2 aria-hidden="true" className="w-5 h-5 mr-2 animate-spin" />
                    Confirming...
                  </>
                ) : (
                  'Confirm and unlock my dashboard'
                )}
              </button>

              {(error || !token) && (
                <div
                  className="mt-8 pt-6 border-t"
                  style={{ borderColor: 'var(--border-soft)' }}
                >
                  {resendSent ? (
                    <p className="text-sm text-center" style={{ color: 'var(--text-secondary)' }}>
                      If that matched an account waiting on confirmation, a new link was just
                      emailed.
                    </p>
                  ) : (
                    <>
                      <p
                        className="mb-3 text-xs font-bold uppercase tracking-wider"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        Request a new confirmation link
                      </p>
                      <form onSubmit={handleResend} className="space-y-3">
                        <input
                          type="email"
                          required
                          placeholder="you@business.com"
                          value={resendEmail}
                          onChange={(e) => setResendEmail(e.target.value)}
                          aria-label="Email"
                          autoComplete="username"
                          className="w-full px-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                          style={{
                            backgroundColor: 'var(--bg-raised)',
                            borderColor: 'var(--border-soft)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <input
                          type="password"
                          required
                          placeholder="Your password"
                          value={resendPassword}
                          onChange={(e) => setResendPassword(e.target.value)}
                          aria-label="Password"
                          autoComplete="current-password"
                          className="w-full px-4 py-3 border rounded-xl focus:ring-2 outline-none transition-all text-sm"
                          style={{
                            backgroundColor: 'var(--bg-raised)',
                            borderColor: 'var(--border-soft)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <button
                          type="submit"
                          disabled={resendLoading}
                          aria-busy={resendLoading}
                          className="w-full py-3 rounded-xl font-semibold text-sm border transition-all disabled:opacity-50"
                          style={{
                            borderColor: 'var(--border-soft)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {resendLoading ? 'Sending...' : 'Resend confirmation email'}
                        </button>
                      </form>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ConsentPage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ backgroundColor: 'var(--bg-base)' }}
        >
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      }
    >
      <ConsentPageInner />
    </Suspense>
  );
}
