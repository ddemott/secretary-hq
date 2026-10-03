'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';

export interface CustomerPreference {
  pref_key: string;
  pref_value: string;
  /** Owner-facing label in this business's wording (from the backend). */
  label: string;
  updated_at?: string;
}

interface CustomerPreferencesCardProps {
  preferences: CustomerPreference[];
}

/**
 * What this caller told the AI receptionist they like — "Alex does my oil
 * changes", "call before any work over $200". Saved by the agent during the
 * call (remember_preference) and used on their next call; this card is where
 * the owner sees them.
 */
export function CustomerPreferencesCard({ preferences }: CustomerPreferencesCardProps) {
  return (
    <div id="customer-preferences" className="space-y-4" data-tour="customer-preferences">
      <h3 className="font-bold flex items-center text-lg" style={{ color: 'var(--text-primary)' }}>
        <Sparkles className="w-5 h-5 mr-2" style={{ color: 'var(--text-muted)' }} />
        Preferences
      </h3>
      {preferences.length > 0 ? (
        <dl
          className="rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3"
          style={{ border: '1px solid var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
        >
          {preferences.map((p) => (
            <div key={p.pref_key}>
              <dt
                className="text-xs uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                {p.label}
              </dt>
              <dd className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {p.pref_value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Nothing yet. When this caller mentions a preference on a call, the AI saves it here.
        </p>
      )}
    </div>
  );
}
