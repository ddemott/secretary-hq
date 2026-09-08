'use client';

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, XCircle, Loader2, Bot } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api';

type State = 'confirm' | 'loading' | 'success' | 'error' | 'invalid';

function SelfCancelInner() {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>(token ? 'confirm' : 'invalid');
  const [message, setMessage] = useState<string>('');

  const handleCancel = async () => {
    if (!token) return;
    setState('loading');
    try {
      const res = await fetch(`${API_BASE_URL}/self/cancel?token=${encodeURIComponent(token)}`);
      const data = (await res.json()) as { success: boolean; message?: string; error?: string };
      if (data.success) {
        setState('success');
        setMessage(data.message ?? 'Your appointment has been canceled.');
      } else {
        setState('error');
        setMessage(data.error ?? 'Failed to cancel appointment.');
      }
    } catch {
      setState('error');
      setMessage('Connection error. Please try again or call us directly.');
    }
  };

  return (
    <div className="p-8 flex flex-col items-center text-center gap-6">
      {state === 'confirm' && (
        <>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Are you sure you want to cancel your appointment?
          </p>
          <button
            onClick={() => void handleCancel()}
            className="w-full py-4 text-white rounded-xl font-bold text-sm shadow-lg hover:opacity-90 active:scale-[0.98] transition-all"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            Yes, cancel my appointment
          </button>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            This cannot be undone. Contact us to rebook.
          </p>
        </>
      )}

      {state === 'loading' && (
        <>
          <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--accent)' }} />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Canceling your appointment&hellip;
          </p>
        </>
      )}

      {state === 'success' && (
        <>
          <CheckCircle className="w-12 h-12" style={{ color: 'var(--accent)' }} />
          <p className="text-base font-medium">{message}</p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            We hope to see you again soon.
          </p>
        </>
      )}

      {(state === 'error' || state === 'invalid') && (
        <>
          <XCircle className="w-12 h-12 text-red-500" />
          <p className="text-base font-medium text-red-600 dark:text-red-400">
            {state === 'invalid'
              ? 'This cancel link is missing a token. Please use the link from your SMS.'
              : message}
          </p>
        </>
      )}
    </div>
  );
}

export default function SelfCancelPage() {
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
          <h1 className="text-2xl font-display tracking-tight">Cancel Appointment</h1>
        </div>
        <Suspense
          fallback={
            <div className="p-8 flex justify-center">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
            </div>
          }
        >
          <SelfCancelInner />
        </Suspense>
      </div>
    </div>
  );
}
