'use client';

import React from 'react';
import { Sparkles, Info } from 'lucide-react';
import { ToggleSwitch } from '../ui/ToggleSwitch';

function preferencesPlaceholder(businessType?: string | null): string {
  const t = (businessType || '').toLowerCase();
  if (/salon|spa|hair|nail|beauty|barber|lash|brow/.test(t)) {
    return 'Ex: Remember the service each client had and which stylist did it. If they book a cut and never mention nails, offer to add a manicure. Always offer them the same stylist they had last time. Note colors, products, or sensitivities they mention so next time feels personal.';
  }
  if (/auto|tire|mechanic|repair|bay|vehicle|car|lube|brake/.test(t)) {
    return "Ex: Remember the customer's vehicle (year/make/model) and the last service done. If they're due for something related — a rotation after new tires, the next oil-change interval — mention it. Note any preferred technician and recurring concerns (brakes, alignment) to bring up next time.";
  }
  if (/trade|plumb|hvac|electric|contractor|roof|handyman|landscap/.test(t)) {
    return 'Ex: Remember the property and the work last done, plus equipment details (furnace model, water-heater age). Flag recurring issues and seasonal maintenance (an AC tune-up before summer). Note a preferred tech and the time window the customer likes.';
  }
  if (/fitness|gym|yoga|studio|pilates|train|crossfit|cycle/.test(t)) {
    return "Ex: Remember the classes or trainer the member prefers and their goals. Suggest the next session in their usual time slot, or a related class they'd enjoy. Note any injuries or limitations they mention so bookings stay appropriate.";
  }
  if (/food|restaurant|cafe|coffee|bar|dining|kitchen|catering|grill/.test(t)) {
    return "Ex: Remember the customer's usual order and party size, their favorite table or seating, and any dietary needs or allergies. Offer their usual and flag specials they'd like. Note occasions (birthdays, anniversaries) to personalize the visit.";
  }
  return "Ex: Remember what each customer prefers — the service they had, who served them, and anything they like or want to avoid. Use it next time to greet them personally and suggest things they'd genuinely want. Don't save one-off details or anything they ask you to keep private.";
}

interface CustomerPreferencesSectionProps {
  savePreferencesEnabled: boolean;
  preferencesInstructions: string;
  businessType?: string | null;
  onToggle: () => void;
  onInstructionsChange: (val: string) => void;
}

export function CustomerPreferencesSection({
  savePreferencesEnabled,
  preferencesInstructions,
  businessType,
  onToggle,
  onInstructionsChange,
}: CustomerPreferencesSectionProps) {
  return (
    <section className="space-y-4" data-tour="caller-preferences">
      <div className="flex items-center justify-between">
        <h2
          className="text-lg font-bold flex items-center"
          style={{ color: 'var(--text-primary)' }}
        >
          <Sparkles className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
          Customer Preferences
        </h2>
        <ToggleSwitch
          checked={savePreferencesEnabled}
          onChange={onToggle}
          label="Save customer preferences"
        />
      </div>
      <div
        className="border p-4 rounded-xl flex items-start"
        style={{ backgroundColor: 'var(--accent-muted)', borderColor: 'var(--accent-muted)' }}
      >
        <Info
          className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0"
          style={{ color: 'var(--accent-soft)' }}
        />
        <p className="text-sm leading-relaxed" style={{ color: 'var(--accent-soft)' }}>
          When this is on, your AI remembers things about each customer between calls — their
          favorite service, who served them last, what they like — and uses it to give a personal
          welcome and suggest things they&apos;d genuinely enjoy. Describe below{' '}
          <strong>what</strong> to remember, <strong>why</strong> it matters, and{' '}
          <strong>when</strong> to bring it up, so the AI uses it intelligently instead of guessing.
          Leave it blank to use a sensible default.
        </p>
      </div>
      <textarea
        data-testid="preferences-instructions"
        rows={8}
        disabled={!savePreferencesEnabled}
        value={preferencesInstructions}
        onChange={(e) => onInstructionsChange(e.target.value)}
        className="w-full p-4 border rounded-xl text-sm md:text-base leading-relaxed focus:ring-2 outline-none shadow-inner disabled:opacity-50"
        style={{
          borderColor: 'var(--border-soft)',
          backgroundColor: 'var(--bg-raised)',
          color: 'var(--text-primary)',
        }}
        placeholder={preferencesPlaceholder(businessType)}
      />
    </section>
  );
}
