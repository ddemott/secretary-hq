'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ExternalLink, Unlink, CheckCircle2, Link2, RefreshCw } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface CRMProvider {
  name: string;
  color: string; // tailwind color prefix (e.g. 'green', 'orange')
  icon: string; // single letter/emoji for avatar
  description: string;
  getSettings: (tenantId: string | null) => Promise<{ last_sync_at?: string } | null>;
  getAuthUrl: (tenantId: string | null) => Promise<{ success: boolean; authUrl: string }>;
  disconnect: (tenantId: string | null) => Promise<{ success: boolean }>;
  triggerSync: (tenantId: string | null) => Promise<unknown>;
  connectedParam: string; // URL param to check (e.g. 'squareConnected')
  getSyncStatus?: (tenantId: string | null) => Promise<{
    pending_count?: number;
    error_count?: number;
    total_mapped?: number | { customers: number; appointments: number };
  } | null>;
}

interface CRMIntegrationCardProps {
  provider: CRMProvider;
  tenantId: string | null;
}

export function CRMIntegrationCard({ provider, tenantId }: CRMIntegrationCardProps) {
  const [settings, setSettings] = useState<{ last_sync_at?: string } | null>(null);
  const [syncStatus, setSyncStatus] = useState<{
    pending_count?: number;
    error_count?: number;
    total_mapped?: number | { customers: number; appointments: number };
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await provider.getSettings(tenantId);
      setSettings(data);
      if (provider.getSyncStatus) {
        const s = await provider.getSyncStatus(tenantId);
        setSyncStatus(s);
      }
    } catch {
      // Settings not available — provider not connected
    }
  }, [tenantId, provider]);

  useEffect(() => {
    if (tenantId) void fetchSettings();
  }, [tenantId, fetchSettings]);

  // Check for OAuth callback success
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(provider.connectedParam) === 'true') {
      void fetchSettings();
      const url = new URL(window.location.href);
      url.searchParams.delete(provider.connectedParam);
      window.history.replaceState({}, '', url.toString());
    }
  }, [provider.connectedParam, fetchSettings]);

  async function handleConnect() {
    setLoading(true);
    try {
      const res = await provider.getAuthUrl(tenantId);
      window.location.href = res.authUrl;
    } catch {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    try {
      const res = await provider.disconnect(tenantId);
      if (res.success) setSettings(null);
    } catch {
      // disconnect failed
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await provider.triggerSync(tenantId);
      await fetchSettings();
    } catch {
      // sync failed
    } finally {
      setSyncing(false);
    }
  }

  const colorMap: Record<
    string,
    {
      bg: string;
      text: string;
      avatar: string;
      style?: { bg: React.CSSProperties; text: React.CSSProperties; avatar: React.CSSProperties };
    }
  > = {
    green: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-600 dark:text-green-400',
      avatar: 'bg-green-500',
    },
    orange: {
      bg: 'bg-orange-100 dark:bg-orange-900/30',
      text: 'text-orange-600 dark:text-orange-400',
      avatar: 'bg-orange-500',
    },
    blue: {
      bg: '',
      text: '',
      avatar: '',
      style: {
        bg: { backgroundColor: 'var(--accent-muted)' },
        text: { color: 'var(--accent-soft)' },
        avatar: { backgroundColor: 'var(--accent)' },
      },
    },
    purple: {
      bg: 'bg-purple-100 dark:bg-purple-900/30',
      text: 'text-purple-600 dark:text-purple-400',
      avatar: 'bg-purple-500',
    },
  };
  const colors = colorMap[provider.color] || colorMap.blue;

  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center">
          <div
            className={`${colors.bg} p-2 rounded-lg mr-4 ${colors.text}`}
            style={colors.style ? { ...colors.style.bg, ...colors.style.text } : undefined}
          >
            <Link2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold">{provider.name} CRM</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {provider.description}
            </p>
          </div>
        </div>
        {settings && (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Connected
          </Badge>
        )}
      </div>

      {!settings ? (
        <div>
          <button
            onClick={handleConnect}
            disabled={loading}
            className="flex items-center justify-center gap-3 p-4 border rounded-2xl hover:border-green-500 transition-all font-bold group w-full"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-soft)' }}
          >
            <div
              className={`w-8 h-8 ${colors.bg} rounded-lg flex items-center justify-center ${colors.text} font-bold`}
              style={colors.style ? { ...colors.style.bg, ...colors.style.text } : undefined}
            >
              {provider.icon}
            </div>
            <span>Connect {provider.name}</span>
            <ExternalLink className="w-4 h-4 ml-auto opacity-0 group-hover:opacity-100 transition-all" />
          </button>
        </div>
      ) : (
        <div
          className="p-4 border rounded-2xl flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-soft)' }}
        >
          <div className="flex items-center gap-4">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white ${colors.avatar}`}
              style={colors.style?.avatar}
            >
              {provider.icon}
            </div>
            <div>
              <div className="font-bold">{provider.name} Connected</div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {settings.last_sync_at
                  ? `Last synced: ${new Date(settings.last_sync_at).toLocaleString('en-US', { hour12: true })}`
                  : 'Not yet synced'}
              </div>
              {syncStatus &&
                (syncStatus.pending_count != null || syncStatus.error_count != null) && (
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Sync health: {syncStatus.pending_count ?? 0} pending •{' '}
                    {syncStatus.error_count ?? 0} errors
                    {syncStatus.total_mapped != null
                      ? typeof syncStatus.total_mapped === 'object'
                        ? ` • ${syncStatus.total_mapped.customers + syncStatus.total_mapped.appointments} mapped`
                        : ` • ${syncStatus.total_mapped} mapped`
                      : ''}
                  </div>
                )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={handleSync}
              disabled={syncing}
              isLoading={syncing}
              icon={RefreshCw}
            >
              Sync Now
            </Button>
            <Button
              variant="ghost"
              onClick={handleDisconnect}
              disabled={loading}
              className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              icon={Unlink}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
