'use client';

import React, { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Bot, CheckCircle2, ShieldAlert } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api';

/**
 * Landing page for the signup verification link (POST /register emails
 * `/verify-email?token=...`). Confirms automatically on load — the link IS
 * the confirmation, there is nothing else to review. Mirrors /consent's
 * standalone layout.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
  const [error, setError] = useState<string | null>(
    token ? null : 'This link is missing its code. Open the link from your email again.'
  );
  // React StrictMode runs effects twice in dev; the token is single-use, so
  // the second POST would fail and flash an error over a real success.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          message?: string;
        };
        if (res.ok && data.success) {
          try {
            localStorage.setItem('emailVerified', 'true');
          } catch {
            // ignore — purely a UI hint for the Billing notice
          }
          setState('done');
        } else if (res.status === 429) {
          setState('failed');
          setError(data.message || 'Too many attempts. Please wait a while and try again.');
        } else {
          setState('failed');
          setError(data.error || 'This link is invalid or has expired.');
        }
      } catch {
        setState('failed');
        setError("Couldn't connect. Check your internet and try again.");
      }
    })();
  }, [token]);

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
          <h1 className="text-2xl font-display tracking-tight">Confirm your email</h1>
        </div>

        <div className="p-8 text-sm flex flex-col items-center text-center">
          {state === 'working' && (
            <p role="status" className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Confirming your email…
            </p>
          )}
          {state === 'done' && (
            <div role="status" className="flex flex-col items-center">
              <CheckCircle2 className="w-12 h-12 mb-4" style={{ color: 'var(--accent)' }} />
              <p className="mb-2 font-semibold">Your email is confirmed.</p>
              <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
                You can now choose a plan and start your free trial.
              </p>
              <a
                href="/dashboard?tab=setup&subtab=billing"
                className="font-semibold hover:underline"
                style={{ color: 'var(--accent-soft)' }}
              >
                Go to Billing
              </a>
            </div>
          )}
          {state === 'failed' && (
            <div role="alert" className="flex flex-col items-center">
              <ShieldAlert className="w-12 h-12 mb-4" style={{ color: 'var(--danger)' }} />
              <p className="mb-2 font-semibold">{error}</p>
              <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
                Sign in and use &quot;Resend email&quot; on the Billing page to get a new link.
              </p>
              <a
                href="/dashboard"
                className="font-semibold hover:underline"
                style={{ color: 'var(--accent-soft)' }}
              >
                Sign in
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
