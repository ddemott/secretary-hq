'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Calendar, Users, Phone, Wrench, Wand2, X, ArrowRight, Sparkles } from 'lucide-react';
import { useFocusTrap } from '../../lib/useFocusTrap';
import { Button } from '../ui/Button';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import type { Tab } from '../../app/dashboard/page';
import { requestProductTour } from '../../lib/productTour';

interface FirstRunTourProps {
  onNavigate?: (tab: Tab) => void;
}

/**
 * FirstRunTour — single overview modal that fires the first time a tenant
 * lands on Home after completing the setup wizard (Phase 13 launch-blocker,
 * 2026-05-17).
 *
 * Visibility model: SetupWizard/SoloWizard set a localStorage flag
 * `firstRunTour_<tenantId>` = 'pending' on the Done button click. This
 * component reads that flag on mount; if set, it shows the modal and
 * marks the flag 'shown' so it never re-fires for this browser/tenant.
 *
 * UX choice: a single overview modal beats a multi-step coachmark tour for
 * a v1 — fewer state transitions, no overlay positioning, and the user
 * can act on any tab immediately via the "Open X" buttons inside each
 * card. If the data later shows users skim and don't click through, we can
 * upgrade to a spotlight tour without changing the trigger surface.
 *
 * Per-tenant via tenantId so a super-admin managing multiple tenants sees
 * the tour once per tenant, not once per browser.
 */
export function FirstRunTour({ onNavigate }: FirstRunTourProps) {
  const tenantId = useActiveTenantId();
  const vocab = useVocabulary();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open, () => setOpen(false), true);

  useEffect(() => {
    if (!tenantId) return;
    if (typeof window === 'undefined') return;
    const key = `firstRunTour_${tenantId}`;
    if (localStorage.getItem(key) === 'pending') {
      setOpen(true);
      // Mark shown immediately so a quick re-render (Strict Mode, a state
      // flip elsewhere) doesn't trigger the modal twice. The user closing
      // it doesn't need to update localStorage again — it's already 'shown'.
      localStorage.setItem(key, 'shown');
    }
  }, [tenantId]);

  if (!open) return null;

  function go(tab: Tab) {
    setOpen(false);
    onNavigate?.(tab);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-tour-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        ref={containerRef}
        className="rounded-2xl shadow-2xl border max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-6 py-4 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Sparkles
              className="w-5 h-5"
              style={{ color: 'var(--accent-soft)' }}
              aria-hidden="true"
            />
            <h2 id="first-run-tour-title" className="text-lg font-bold">
              You&apos;re set up — here&apos;s what&apos;s where
            </h2>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close tour"
            className="p-1 transition"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-3">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Your AI receptionist is ready to take calls. Below is a quick map of where to find the
            things you&apos;ll use most. Click any card to jump there now.
          </p>

          <TourCard
            icon={Calendar}
            title="Schedule"
            description="Today's bookings, the weekly calendar, and Quick Book for call-ins. Drag to reschedule, click an empty slot to book."
            onClick={() => go('schedule')}
          />
          <TourCard
            icon={Users}
            title="Customers"
            description="Search and edit your customer list. Each profile shows their booking history and call transcripts."
            onClick={() => go('customers')}
          />
          <TourCard
            icon={Phone}
            title="Calls"
            description="Live activity from your AI line plus past call transcripts and summaries. A red badge here means a call is in progress right now."
            onClick={() => go('calls')}
          />
          <TourCard
            icon={Wrench}
            title="Setup"
            description={`Configure your business: services, ${vocab.resource_plural.toLowerCase()}, staff, hours, and which staff can perform which service. Owners only.`}
            onClick={() => go('setup')}
          />
          <TourCard
            icon={Wand2}
            title="Phone Assistant"
            description="The AI's voice, prompt, and knowledge base. This is where you teach your assistant about your business."
            onClick={() => go('ai-insights')}
          />
        </div>

        <div
          className="px-6 py-3 border-t flex justify-between items-center"
          style={{ borderColor: 'var(--border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            You can revisit any time from the Setup Assistant.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setOpen(false);
                requestProductTour();
              }}
            >
              Show me around
            </Button>
            <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
              Got it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TourCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
}

function TourCard({ icon: Icon, title, description, onClick }: TourCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] focus-visible:ring-offset-1"
      style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-soft)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-soft)';
      }}
    >
      <div className="p-2 rounded-lg shrink-0" style={{ backgroundColor: 'var(--accent-muted)' }}>
        <Icon className="w-5 h-5" style={{ color: 'var(--accent-soft)' }} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-1.5 font-semibold text-sm"
          style={{ color: 'var(--text-primary)' }}
        >
          {title}
          <ArrowRight
            className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity"
            aria-hidden="true"
          />
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {description}
        </div>
      </div>
    </button>
  );
}

/**
 * Set the pending-tour flag for a tenant. Call from any wizard's "Done"
 * button so the tour fires when the user lands back on Home.
 */
export function markFirstRunTourPending(tenantId: string | null) {
  if (!tenantId) return;
  if (typeof window === 'undefined') return;
  const key = `firstRunTour_${tenantId}`;
  // Only mark pending if not already shown — re-running the wizard
  // shouldn't replay the tour.
  if (localStorage.getItem(key) === null) {
    localStorage.setItem(key, 'pending');
  }
}
