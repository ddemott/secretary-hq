/**
 * Tests for ContactDetailsCard (UX review, 2026-09-16).
 *
 * Two defects fixed here:
 *  1. View-mode address was hand-assembled inline with the exact same
 *     join/filter logic `lib/utils.ts`'s `formatCustomerAddress()` already
 *     implements and other dashboard views (AppointmentEditForm,
 *     useAppointmentCRUD) already call — duplicated logic that could drift
 *     from the shared formatter. Now delegates to it.
 *  2. Edit-mode's "Internal Notes" <label> had no `htmlFor`/`id` pairing
 *     with its <textarea>, so a screen-reader user focusing the field heard
 *     no accessible name at all — the label was purely visual.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import { ContactDetailsCard } from './ContactDetailsCard';
import type { Customer } from '@/lib/types';

const EMPTY_EDIT_FORM = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  address: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  timezone: 'America/New_York',
  notes: '',
};

describe('ContactDetailsCard — address formatting + notes label association', () => {
  it('HAPPY: view mode renders the address through the shared formatCustomerAddress() output', () => {
    // WHO: an operator viewing a customer with a full address on file.
    // WHAT: the rendered address string matches formatCustomerAddress()'s
    //       output exactly — line1, line2, city, "state zip", comma-joined.
    // WHEN: !isEditing && !isCreating.
    // WHERE: ContactDetailsCard's view-mode address <span>.
    // WHY: pins the switch from hand-rolled inline join logic to the shared
    //       helper other views already use, so this card can't drift from
    //       the address format the rest of the dashboard renders.
    const customer = {
      customer_id: 'c1',
      name: 'Pat Lee',
      address: '123 Main St',
      address_line2: 'Suite 4',
      city: 'Naperville',
      state: 'IL',
      postal_code: '60540',
    } as unknown as Customer;

    render(
      <ContactDetailsCard
        selectedCustomer={customer}
        isCreating={false}
        isEditing={false}
        editForm={EMPTY_EDIT_FORM}
        onEditFormChange={vi.fn()}
      />
    );

    expect(screen.getByText('123 Main St, Suite 4, Naperville, IL 60540')).toBeInTheDocument();
  });

  it('SAD: a customer with no address parts falls back to "No address on file" (not an empty string or stray commas)', () => {
    // WHO: an operator viewing a customer created by phone with no address
    //       ever collected. WHAT: the empty-address fallback copy renders,
    //       not a bare/blank line or dangling punctuation from the join.
    // WHEN: every address field is undefined. WHERE: same view-mode branch.
    // WHY: formatCustomerAddress() returns '' for no parts — the card must
    //       still show honest copy rather than a blank row.
    const customer = { customer_id: 'c2', name: 'No Address Customer' } as unknown as Customer;

    render(
      <ContactDetailsCard
        selectedCustomer={customer}
        isCreating={false}
        isEditing={false}
        editForm={EMPTY_EDIT_FORM}
        onEditFormChange={vi.fn()}
      />
    );

    expect(screen.getByText('No address on file')).toBeInTheDocument();
  });

  it('A11Y: edit mode\'s "Internal Notes" label is programmatically associated with its textarea', () => {
    // WHO: a screen-reader user editing a customer's internal notes.
    // WHAT: getByLabelText('Internal Notes') must resolve to the textarea —
    //       previously the <label> had no htmlFor and the <textarea> no id,
    //       so the visible label was invisible to assistive tech.
    // WHEN: isEditing=true. WHERE: ContactDetailsCard's edit-mode notes field.
    // WHY: an unassociated label reads as an unlabeled control to a
    //       screen-reader user even though it looks labeled visually.
    render(
      <ContactDetailsCard
        selectedCustomer={null}
        isCreating={false}
        isEditing={true}
        editForm={{ ...EMPTY_EDIT_FORM, notes: 'Prefers afternoon calls' }}
        onEditFormChange={vi.fn()}
      />
    );

    const notesField = screen.getByLabelText('Internal Notes');
    expect(notesField.tagName).toBe('TEXTAREA');
    expect(notesField).toHaveValue('Prefers afternoon calls');
  });
});
