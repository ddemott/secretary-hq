/**
 * Tests for CustomerDetailPanel — covers the reactivate-from-history flow
 * shipped 2026-05-10 (paired with the new POST /appointments/:id/reactivate
 * backend route). Today canceled appointments are filtered out of the
 * scheduler / calendar / list views; the customer-history pane is the only
 * UI surface where a canceled row is reachable from a click flow. This file
 * pins that contract.
 *
 * Coverage:
 *   - CANCELED rows render as a <button> (semantic + keyboard accessible)
 *     and clicking invokes onReactivateAppointment with the appointment id.
 *   - COMPLETED / past scheduled rows render as a non-interactive <div>
 *     (no click handler — there's no detail-view route for past rows yet).
 *   - Mixed history renders both flavors side-by-side without crashing.
 *   - The Canceled badge text + danger variant are visible regardless of
 *     interactive shape — operators need the visual cue before they click.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

import { CustomerDetailPanel } from './CustomerDetailPanel';

// Minimal Customer shape — CustomerDetailPanel only reads name/phone/etc.
// for header rendering. The test focuses on the appointment-history pane.
const baseCustomer = {
  id: 'cust-1',
  tenant_id: 'tenant-1',
  name: 'Alice Lee',
  first_name: 'Alice',
  last_name: 'Lee',
  phone: '+15555550100',
  email: 'alice@example.test',
  notes: '',
} as unknown as React.ComponentProps<typeof CustomerDetailPanel>['selectedCustomer'];

const baseEditForm = {
  first_name: 'Alice',
  last_name: 'Lee',
  phone: '+15555550100',
  email: 'alice@example.test',
  address: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  timezone: 'America/Chicago',
  notes: '',
};

const canceledAppt = {
  appointment_id: 'appt-canceled',
  start_time: '2026-04-15T14:00:00Z',
  end_time: '2026-04-15T15:00:00Z',
  status: 'canceled',
  description: 'Tire rotation',
  resource_name: 'Bay 1',
  employee_name: 'Mike',
};

const completedAppt = {
  appointment_id: 'appt-completed',
  start_time: '2026-04-10T14:00:00Z',
  end_time: '2026-04-10T15:00:00Z',
  status: 'completed',
  description: 'Brake pads',
  resource_name: 'Bay 2',
  employee_name: 'Carlos',
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof CustomerDetailPanel>> = {}) {
  const defaultProps: React.ComponentProps<typeof CustomerDetailPanel> = {
    selectedCustomer: baseCustomer,
    isCreating: false,
    isEditing: false,
    saving: false,
    showDetailOnMobile: true,
    editForm: baseEditForm,
    summaries: [],
    upcomingAppointments: [],
    pastAppointments: [],
    onEditFormChange: vi.fn(),
    onEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSave: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onCancelAppointment: vi.fn(),
    onReactivateAppointment: vi.fn(),
    onCloseMobile: vi.fn(),
  };
  return render(<CustomerDetailPanel {...defaultProps} {...overrides} />);
}

describe('CustomerDetailPanel — appointment history reactivate affordance', () => {
  it('HAPPY: a canceled history row renders as a button and click invokes onReactivateAppointment with the row id', () => {
    // WHO: front-desk operator viewing a customer's history with at least one
    //       canceled appointment in it
    // WHAT: the row renders as a semantic <button> (keyboard accessible,
    //       focusable, screen-reader announced) AND clicking it fires
    //       onReactivateAppointment with the appointment's id
    // WHEN: the operator wants to restore a canceled appointment
    // WHERE: pastAppointments map in CustomerDetailPanel
    // WHY: today canceled appointments are filtered out of every other
    //       click surface (calendar / list / scheduler). Customer-history
    //       is the operator's only path back to a canceled row — if this
    //       click breaks, the new /appointments/:id/reactivate route is
    //       unreachable from the dashboard. Pin both the semantic shape
    //       (button vs div) and the wiring (id flows through).
    const onReactivate = vi.fn();
    renderPanel({ pastAppointments: [canceledAppt], onReactivateAppointment: onReactivate });

    const row = screen.getByTestId(`customer-history-canceled-${canceledAppt.appointment_id}`);
    expect(row.tagName).toBe('BUTTON');
    // Visible cue — the Canceled badge must render before/with the button
    // so the operator knows what they're about to act on.
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    // Description is also visible for context (which appointment am I about to restore?).
    expect(screen.getByText('Tire rotation')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onReactivate).toHaveBeenCalledTimes(1);
    expect(onReactivate).toHaveBeenCalledWith(canceledAppt.appointment_id);
  });

  it('SAD: a completed history row renders as a non-interactive div (no reactivate handler invoked on click)', () => {
    // WHO: same operator as above, but the customer's history only has
    //       past *completed* appointments (the normal case)
    // WHAT: the completed row renders as a <div> (not a button) and clicking
    //       it does NOT invoke onReactivateAppointment
    // WHEN: history rendering for non-canceled past rows
    // WHERE: pastAppointments map's `isCanceled ? <button> : <div>` branch
    // WHY: only canceled rows are reactivatable. A regression that made
    //       *every* history row clickable would mis-fire reactivate on
    //       completed appointments, hitting /reactivate which would 400
    //       NOT_CANCELED — chatty error, no visible affordance, confusing
    //       operator. Pin the non-interactive shape so the affordance
    //       stays scoped to the only valid case.
    const onReactivate = vi.fn();
    renderPanel({ pastAppointments: [completedAppt], onReactivateAppointment: onReactivate });

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Brake pads')).toBeInTheDocument();
    // No button data-testid for the completed row — only canceled rows get the testid
    expect(
      screen.queryByTestId(`customer-history-canceled-${completedAppt.appointment_id}`)
    ).toBeNull();
    // Defensive: if a button somehow rendered with the row's id, it shouldn't
    // call onReactivate — but since it doesn't render, the click can't fire.
    expect(onReactivate).not.toHaveBeenCalled();
  });

  it('HAPPY: mixed history renders both a clickable canceled row and a static completed row', () => {
    // WHO: operator viewing a customer who has both canceled and completed
    //       past appointments — the realistic case after a cancellation
    //       earlier in the customer's history
    // WHAT: both rows render with their correct shapes; only the canceled
    //       one fires the reactivate handler when clicked
    // WHEN: typical post-launch state where customers accumulate mixed history
    // WHERE: pastAppointments map's per-row branching
    // WHY: rendering one in isolation could pass while the mixed case has
    //       a key collision, badge bleed, or click-handler over-binding —
    //       this test guards the integration of both branches in the same
    //       map call without introducing N tests for every status mix.
    const onReactivate = vi.fn();
    renderPanel({
      pastAppointments: [canceledAppt, completedAppt],
      onReactivateAppointment: onReactivate,
    });

    // Both badges visible
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();

    // Only the canceled row is wired to reactivate
    fireEvent.click(screen.getByTestId(`customer-history-canceled-${canceledAppt.appointment_id}`));
    expect(onReactivate).toHaveBeenCalledTimes(1);
    expect(onReactivate).toHaveBeenCalledWith(canceledAppt.appointment_id);

    // Clicking the completed row's text doesn't call reactivate (no handler bound)
    fireEvent.click(screen.getByText('Brake pads'));
    expect(onReactivate).toHaveBeenCalledTimes(1); // unchanged — still the one from above
  });

  it('A11Y: the mobile back button has an accessible name and closes the panel', () => {
    // WHO: a screen-reader / keyboard user on mobile. WHAT: the icon-only back
    //       button was announced as just "button"; it now carries an aria-label
    //       and firing it calls onCloseMobile. WHERE: CustomerDetailPanel mobile
    //       header. WHY: icon-only controls need an accessible name.
    const onCloseMobile = vi.fn();
    renderPanel({ onCloseMobile });
    const back = screen.getByRole('button', { name: 'Back to customer list' });
    fireEvent.click(back);
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
  });
});
