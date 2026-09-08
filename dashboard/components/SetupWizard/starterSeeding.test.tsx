/**
 * T-015-E: Step 1 shows the vertical's starter services without the owner
 * typing anything.
 *
 * WHO: an owner who has just picked their business type.
 * WHAT: the wizard opens on Step 1 with 2–4 rows already there, taken from the
 *       template, look-first rows carrying their description.
 * WHEN: every CI run.
 * WHERE: SetupWizard/index.tsx runSeed → useWizardCrud.seedServices →
 *        StepServices Step1Services.
 * WHY: `business_templates.example_services` was empty for all 31 live business
 *      types, so this screen asked "What services do you offer?" against a blank
 *      list — the first thing a new owner saw was a form with nothing in it.
 *      Refilling the DB is only half of it: this asserts the refilled data
 *      actually reaches the screen, which the DB query cannot tell us.
 *
 * The template response here is the REAL catalogue entry from
 * shared/starterServices.ts, not a hand-written fixture. A fixture would pass
 * while the shipped content was wrong, which is the whole failure mode.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import SetupWizard from './index';
import { STARTER_SERVICES } from '../../../shared/starterServices';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

vi.mock('@/lib/SessionContext', () => ({
  useActiveTenantId: () => TENANT_ID,
  useSessionContext: () => ({ tenantId: TENANT_ID, isAdmin: false, role: 'owner' }),
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_label: 'Bay',
    resource_plural: 'Bays',
    employee_label: 'Mechanic',
    employee_plural: 'Mechanics',
    booking_label: 'Appointment',
    example_services: [],
    example_resources: [],
  }),
}));

/**
 * Answer the two calls runSeed makes — the tenant's config (for business_type)
 * and the full template list — and tolerate everything else, matching the
 * catch-all style of SetupWizard/SetupWizard.test.tsx.
 */
function mockBackendFor(businessType: string) {
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi
    .fn()
    .mockImplementation((url: string) => {
      const path = typeof url === 'string' ? url : '';
      if (path.includes('/config')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tenant_id: TENANT_ID, business_type: businessType }),
        });
      }
      if (path.includes('/templates/full')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              business_type: businessType,
              display_name: businessType,
              // The shipped catalogue, exactly as the API serves it.
              example_services: STARTER_SERVICES[businessType],
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('tenantId', TENANT_ID);
});

describe('SetupWizard Step 1 — starter services seed from the template', () => {
  // The T-008 sample verticals plus auto-shop, which is what the work order
  // asks to see. Each is a different shape: SKU-led, look-first-led, and mixed.
  for (const businessType of ['catering', 'plumber', 'salon', 'real-estate', 'auto-shop']) {
    test(`HAPPY: ${businessType} lists its starters with no typing`, async () => {
      mockBackendFor(businessType);
      render(<SetupWizard isOpen={true} onClose={() => {}} />);

      expect(screen.getByText('What services do you offer?')).toBeInTheDocument();

      const starters = STARTER_SERVICES[businessType];
      expect(starters.length).toBeGreaterThan(0);

      for (const starter of starters) {
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: `Edit ${starter.name}` }),
            `Step 1 never showed "${starter.name}" for ${businessType} — the owner sees a blank list`
          ).toBeInTheDocument()
        );
      }
    });
  }

  test('HAPPY: a look-first starter arrives WITH its description', async () => {
    // The description is not decoration: /setup/commit writes it to
    // services.description, and resolveServiceForBooking embeds
    // concat_ws('. ', name, subtitle, description). Dropped here, a plumbing
    // caller saying "water is coming from under my sink" matches nothing in the
    // words "Service call" and falls through to the tenant default instead.
    mockBackendFor('plumber');
    render(<SetupWizard isOpen={true} onClose={() => {}} />);

    const lookFirst = STARTER_SERVICES['plumber'].find((s) => s.look_first);
    expect(lookFirst?.description).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: `Edit ${lookFirst!.name}` })).toBeInTheDocument()
    );
    expect(screen.getByText(lookFirst!.description!)).toBeInTheDocument();
  });

  test('SAD: a template with no starters leaves Step 1 empty rather than crashing', async () => {
    // The pre-fix state, and the state of any business_type this catalogue does
    // not cover. It must degrade to "add your own", never to a broken screen.
    mockBackendFor('catering');
    (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockImplementation((url: string) => {
        const path = typeof url === 'string' ? url : '';
        if (path.includes('/config')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ tenant_id: TENANT_ID, business_type: 'catering' }),
          });
        }
        if (path.includes('/templates/full')) {
          return Promise.resolve({
            ok: true,
            json: async () => [{ business_type: 'catering', example_services: [] }],
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('What services do you offer?')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    );
  });
});
