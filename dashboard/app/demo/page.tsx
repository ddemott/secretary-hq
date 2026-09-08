'use client';

import { useEffect, useState } from 'react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (typeof window !== 'undefined' ? 'https://localhost:4001' : 'https://localhost:4001');

interface DemoStartResponse {
  success: boolean;
  token: string;
  tenant_id: string;
  user_id: string;
  expires_at: string;
  ttl_minutes: number;
  error?: string;
}

export default function DemoPage() {
  const [status, setStatus] = useState<'starting' | 'error'>('starting');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function startDemo() {
      try {
        const res = await fetch(`${API_BASE}/demo/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Body is required: declaring application/json with no body makes
          // the backend's JSON parser reject the request 400 before the route
          // runs. /demo/start takes no parameters, so send an empty object.
          body: JSON.stringify({}),
        });

        const data: DemoStartResponse = (await res.json()) as DemoStartResponse;

        if (cancelled) return;

        if (!res.ok || !data.success) {
          setErrorMsg(data.error ?? `Error ${res.status}`);
          setStatus('error');
          return;
        }

        // Store session exactly as LoginView does, plus demo-specific fields.
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('tenantId', data.tenant_id);
        localStorage.setItem('userName', 'Demo Owner');
        localStorage.setItem('userEmail', 'demo@quicklubedemo.invalid');
        localStorage.setItem('userRole', 'owner');
        localStorage.setItem('demoExpiresAt', data.expires_at);
        localStorage.setItem('demoTenantId', data.tenant_id);

        // Hard navigation, NOT router.push(). SessionProvider lives in the root
        // layout and reads localStorage in a mount-once useEffect(…, []). A
        // client-side push keeps that provider mounted, so it never re-reads the
        // session we just wrote → tenantId stays null → /dashboard renders the
        // login screen. A full page load remounts the provider.
        window.location.href = '/dashboard';
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Network error');
          setStatus('error');
        }
      }
    }

    void startDemo();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  if (status === 'error') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#090E1A',
          color: '#E8F0FF',
          fontFamily: 'var(--font-dm-sans, sans-serif)',
          gap: 16,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 32 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Demo unavailable</div>
        <div style={{ color: '#7A90B8', maxWidth: 360 }}>{errorMsg}</div>
        <a
          href="/"
          style={{
            marginTop: 8,
            padding: '10px 24px',
            background: '#2563EB',
            color: '#fff',
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Back to home
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#090E1A',
        color: '#E8F0FF',
        fontFamily: 'var(--font-dm-sans, sans-serif)',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          border: '3px solid #2563EB',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ fontSize: 15, color: '#7A90B8' }}>Setting up your demo…</div>
    </div>
  );
}
