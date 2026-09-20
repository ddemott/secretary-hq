/**
 * MyAvailabilityCard — the owner's own upcoming schedule on Business Settings.
 *
 * WHO:   a solo owner checking when clients can book them
 * WHAT:  loading / empty / populated states of the schedule strip
 * WHEN:  on Business Settings mount, while shifts load and after
 * WHERE: dashboard/components/settings/MyAvailabilityCard.tsx
 * WHY:   the UX pass made "Loading schedule..." a polite live region
 *        (role="status") so a screen-reader user is told something is in
 *        flight instead of hearing a silent blank card. Nothing pinned that,
 *        nor the loading/empty/populated split it sits inside.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { MyAvailabilityCard } from './MyAvailabilityCard';
import type { EffectiveShift } from '@/lib/types';

const shift = (over: Partial<EffectiveShift> = {}): EffectiveShift => ({
  shift_date: '2026-09-21', // a Monday
  day_of_week: 1,
  start_time: '09:00',
  end_time: '17:00',
  is_override: false,
  is_off: false,
  ...over,
});

describe('MyAvailabilityCard', () => {
  test('HAPPY: while loading, announces a polite live-region status and shows no schedule', () => {
    render(<MyAvailabilityCard shifts={[]} shiftsLoading={true} />);
    const loading = screen.getByText('Loading schedule...');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText(/No schedule set yet/)).not.toBeInTheDocument();
  });

  test('SAD: loading takes precedence over stale shifts (no half-loaded grid)', () => {
    render(<MyAvailabilityCard shifts={[shift()]} shiftsLoading={true} />);
    expect(screen.getByText('Loading schedule...')).toBeInTheDocument();
    expect(screen.queryByText('Mon')).not.toBeInTheDocument();
  });

  test('SAD: not loading and no shifts shows the empty state, which is NOT a live status region', () => {
    // WHY: only the in-flight state should be announced as "status"; an
    // honest empty result is static guidance with a link to fix it.
    render(<MyAvailabilityCard shifts={[]} shiftsLoading={false} />);
    expect(screen.getByText(/No schedule set yet/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading schedule...')).not.toBeInTheDocument();
  });

  test('HAPPY: renders each shift with its weekday, date and a 12-hour time range; off days say Off', () => {
    render(
      <MyAvailabilityCard
        shifts={[
          shift(),
          shift({ shift_date: '2026-09-22', start_time: null, end_time: null, is_off: true }),
        ]}
        shiftsLoading={false}
      />
    );
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText(/9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/5:00 PM/)).toBeInTheDocument();
    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('HAPPY: every "Staff & Shifts" link (header + empty state) asks the shell to open the shifts sub-tab', () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('secretary-hq:setup-subtab', handler);
    try {
      render(<MyAvailabilityCard shifts={[]} shiftsLoading={false} />);
      const links = screen.getAllByRole('button', { name: /Staff & Shifts/ });
      expect(links).toHaveLength(2); // header blurb + empty-state blurb
      links.forEach((l) => fireEvent.click(l));
      expect(seen).toEqual([{ subtab: 'shifts' }, { subtab: 'shifts' }]);
    } finally {
      window.removeEventListener('secretary-hq:setup-subtab', handler);
    }
  });
});
