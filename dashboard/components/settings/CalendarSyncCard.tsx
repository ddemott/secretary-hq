'use client';

import React, { useEffect, useState } from 'react';
import { Calendar, ExternalLink, Unlink, CheckCircle2 } from 'lucide-react';
import { Api } from '../../lib/api';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { showToast } from '../ui/Toast';

interface CalendarSyncCardProps {
  tenantId: string | null;
  isSolo: boolean;
}

export function CalendarSyncCard({ tenantId, isSolo }: CalendarSyncCardProps) {
  const [calendarSettings, setCalendarSettings] = useState<{
    provider: string;
    external_calendar_id: string;
  } | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    void fetchCalendarSettings();

    // Detect OAuth redirect params
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('calendarConnected') === 'true') {
      void fetchCalendarSettings();
      const url = new URL(window.location.href);
      url.searchParams.delete('calendarConnected');
      window.history.replaceState({}, '', url.pathname);
    }
    if (params.get('calendarError')) {
      showToast("Couldn't connect your calendar. Please try again.", 'error');
      const url = new URL(window.location.href);
      url.searchParams.delete('calendarError');
      window.history.replaceState({}, '', url.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function fetchCalendarSettings() {
    try {
      const data = await Api.calendar.getSettings(tenantId);
      setCalendarSettings(data);
      setLoadError(false);
    } catch {
      // A failed status check previously fell through to the same "not
      // connected" buttons a genuinely disconnected tenant sees — a
      // connected owner whose fetch merely failed would be told, wrongly,
      // that nothing is hooked up.
      setLoadError(true);
    }
  }

  async function handleConnectCalendar(provider: 'google' | 'outlook') {
    setCalLoading(true);
    try {
      const res = await Api.calendar.getAuthUrl(tenantId, provider);
      window.location.href = res.url;
    } catch {
      const label = provider === 'google' ? 'Google' : 'Outlook';
      showToast(`Could not start the ${label} Calendar connection. Please try again.`, 'error');
      setCalLoading(false);
    }
  }

  async function handleDisconnectCalendar() {
    setCalLoading(true);
    try {
      const res = await Api.calendar.disconnect(tenantId);
      if (res.success) {
        setCalendarSettings(null);
        showToast('Calendar disconnected.', 'success');
      } else {
        showToast(res.error || 'Could not disconnect the calendar. Please try again.', 'error');
      }
    } catch {
      showToast('Could not disconnect the calendar. Please try again.', 'error');
    } finally {
      setCalLoading(false);
    }
  }

  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center">
          <div
            className="p-2 rounded-lg mr-4"
            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
          >
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold">
              {isSolo ? 'My Calendar' : 'Calendar Synchronization'}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {isSolo
                ? 'Sync bookings to your personal Google or Outlook calendar.'
                : 'Automatically push AI bookings to your Google or Outlook calendar.'}
            </p>
          </div>
        </div>
        {calendarSettings && (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Connected
          </Badge>
        )}
      </div>

      {loadError && (
        <p className="text-xs mb-3" style={{ color: 'var(--danger)' }} role="alert">
          Couldn&rsquo;t check your calendar connection. Refresh the page to try again.
        </p>
      )}

      {!calendarSettings ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => void handleConnectCalendar('google')}
            disabled={calLoading}
            className="flex items-center justify-center gap-3 p-4 border rounded-2xl transition-all font-bold group"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-soft)' }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-soft)')}
          >
            <div className="w-8 h-8 bg-red-50 dark:bg-red-900/20 rounded-lg flex items-center justify-center text-red-600">
              G
            </div>
            <span>Connect Google Calendar</span>
            <ExternalLink className="w-4 h-4 ml-auto opacity-0 group-hover:opacity-100 transition-all" />
          </button>
          <button
            onClick={() => void handleConnectCalendar('outlook')}
            disabled={calLoading}
            className="flex items-center justify-center gap-3 p-4 border rounded-2xl transition-all font-bold group"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-soft)' }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-soft)')}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
            >
              O
            </div>
            <span>Connect Outlook Calendar</span>
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
              className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${calendarSettings.provider === 'google' ? 'bg-red-500 text-white' : ''}`}
              style={
                calendarSettings.provider !== 'google'
                  ? { backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }
                  : undefined
              }
            >
              {calendarSettings.provider === 'google' ? 'G' : 'O'}
            </div>
            <div>
              <div className="font-bold capitalize">
                {calendarSettings.provider} Calendar Connected
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                ID: {calendarSettings.external_calendar_id}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={() => void handleDisconnectCalendar()}
            disabled={calLoading}
            className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            icon={Unlink}
          >
            Disconnect
          </Button>
        </div>
      )}
    </Card>
  );
}
