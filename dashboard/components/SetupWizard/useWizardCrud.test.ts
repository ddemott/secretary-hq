/**
 * useWizardCrud — Phase B draft-commit state tests.
 *
 * WHO: the setup wizard, driving services/resources/employees/shifts/mappings
 *      entirely in local React state (Api.setup.commit persists it later).
 * WHAT: (1) cascade-delete — removing an entity must also remove anything
 *       that referenced it (shifts, mappings), so a later coverage preview
 *       or commit never 400s on a dangling tmp_id; (2) buildDraftGraph
 *       serializes the draft into exactly the shape /coverage/dry-run and
 *       /setup/commit expect.
 * WHERE: components/SetupWizard/useWizardCrud.ts
 * WHY: the cascade is load-bearing — findMissingTmpIdReferences on the
 *      backend (src/services/setupGraph.ts) rejects any draft with a shift
 *      or mapping pointing at an entity that no longer exists.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useWizardCrud } from './useWizardCrud';

vi.mock('../../lib/api', () => ({
  Api: {
    coverage: { dryRun: vi.fn().mockResolvedValue([]) },
  },
}));

const TENANT = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

function setup() {
  return renderHook(
    ({ step }: { step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }) => useWizardCrud(TENANT, step),
    { initialProps: { step: 1 } }
  );
}

describe('useWizardCrud — cascade delete', () => {
  it('deleting an employee removes their shifts and service_employee mappings', () => {
    const { result } = setup();

    act(() => {
      result.current.startAddService();
    });
    act(() => {
      result.current.setEditingService({ name: 'Cut', description: '', duration_minutes: 30 });
    });
    act(() => {
      result.current.saveService();
    });
    const serviceId = result.current.draftServices[0].service_id;

    act(() => {
      result.current.startAddEmployee();
    });
    act(() => {
      result.current.setEditingEmployee({
        first_name: 'Tess',
        last_name: '',
        email: '',
        phone: '',
      });
    });
    act(() => {
      result.current.saveEmployee();
    });
    const employeeId = result.current.draftEmployees[0].employee_id;

    act(() => {
      result.current.toggleEmployeeAssignment(serviceId, employeeId);
      result.current.toggleShift(employeeId, 1, '09:00', '17:00');
      result.current.setSelectedShiftEmployee(employeeId);
    });

    expect(result.current.serviceEmployeeMappings).toHaveLength(1);
    expect(result.current.shifts).toHaveLength(1);

    act(() => {
      result.current.deleteEmployee(employeeId);
    });

    expect(result.current.draftEmployees).toHaveLength(0);
    expect(result.current.shifts).toHaveLength(0);
    expect(result.current.serviceEmployeeMappings).toHaveLength(0);
    expect(result.current.selectedShiftEmployee).toBeNull();

    // The decisive check: the serialized draft graph has no dangling
    // employee_tmp_id anywhere — this is exactly what the backend's
    // findMissingTmpIdReferences would otherwise 400 on.
    const graph = result.current.buildDraftGraph();
    expect(graph.shifts).toHaveLength(0);
    expect(graph.service_employee).toHaveLength(0);
  });

  it('deleting a service removes its service_employee and service_resource mappings', () => {
    const { result } = setup();

    act(() => result.current.startAddService());
    act(() =>
      result.current.setEditingService({ name: 'Cut', description: '', duration_minutes: 30 })
    );
    act(() => result.current.saveService());
    const serviceId = result.current.draftServices[0].service_id;

    act(() => result.current.startAddEmployee());
    act(() =>
      result.current.setEditingEmployee({ first_name: 'Tess', last_name: '', email: '', phone: '' })
    );
    act(() => result.current.saveEmployee());
    const employeeId = result.current.draftEmployees[0].employee_id;

    act(() => result.current.startAddResource());
    act(() => result.current.setEditingResource({ name: 'Chair 1', description: '' }));
    act(() => result.current.saveResource());
    const resourceId = result.current.draftResources[0].resource_id;

    act(() => {
      result.current.toggleEmployeeAssignment(serviceId, employeeId);
      result.current.toggleResourceAssignment(serviceId, resourceId);
    });
    expect(result.current.serviceEmployeeMappings).toHaveLength(1);
    expect(result.current.serviceResourceMappings).toHaveLength(1);

    act(() => result.current.deleteService(serviceId));

    expect(result.current.draftServices).toHaveLength(0);
    expect(result.current.serviceEmployeeMappings).toHaveLength(0);
    expect(result.current.serviceResourceMappings).toHaveLength(0);

    const graph = result.current.buildDraftGraph();
    expect(graph.service_employee).toHaveLength(0);
    expect(graph.service_resource).toHaveLength(0);
  });

  it('deleting a resource removes its service_resource mappings only', () => {
    const { result } = setup();

    act(() => result.current.startAddService());
    act(() =>
      result.current.setEditingService({ name: 'Cut', description: '', duration_minutes: 30 })
    );
    act(() => result.current.saveService());
    const serviceId = result.current.draftServices[0].service_id;

    act(() => result.current.startAddResource());
    act(() => result.current.setEditingResource({ name: 'Chair 1', description: '' }));
    act(() => result.current.saveResource());
    const resourceId = result.current.draftResources[0].resource_id;

    act(() => result.current.toggleResourceAssignment(serviceId, resourceId));
    expect(result.current.serviceResourceMappings).toHaveLength(1);

    act(() => result.current.deleteResource(resourceId));

    expect(result.current.draftResources).toHaveLength(0);
    expect(result.current.serviceResourceMappings).toHaveLength(0);
    // Deleting a resource must not touch service_employee mappings.
    expect(result.current.draftServices).toHaveLength(1);
  });
});

describe('useWizardCrud — buildDraftGraph serialization', () => {
  it('serializes services/resources/employees with the full fields the wizard captures', () => {
    const { result } = setup();

    act(() => result.current.startAddService());
    act(() =>
      result.current.setEditingService({
        name: 'Signature Cut',
        description: 'A great cut',
        duration_minutes: 45,
      })
    );
    act(() => result.current.saveService());

    act(() => result.current.startAddEmployee());
    act(() =>
      result.current.setEditingEmployee({
        first_name: 'Tess',
        last_name: 'Stylist',
        email: 'tess@example.com',
        phone: '+16085551234',
      })
    );
    act(() => result.current.saveEmployee());

    const graph = result.current.buildDraftGraph();
    expect(graph.services).toEqual([
      expect.objectContaining({
        name: 'Signature Cut',
        description: 'A great cut',
        duration_minutes: 45,
      }),
    ]);
    expect(graph.employees).toEqual([
      expect.objectContaining({
        name: 'Tess Stylist',
        first_name: 'Tess',
        last_name: 'Stylist',
        email: 'tess@example.com',
        phone: '+16085551234',
      }),
    ]);
    // tmp_id is present and matches the entity's own service_id/employee_id
    // (same field, no separate id scheme — the whole point of the design).
    expect(graph.services[0].tmp_id).toBe(result.current.draftServices[0].service_id);
  });

  it('seedServices never re-seeds over an existing name (user-typed or already seeded)', () => {
    const { result } = setup();

    act(() => result.current.seedServices([{ name: 'Haircut' }, { name: 'Color' }]));
    expect(result.current.draftServices).toHaveLength(2);

    act(() => result.current.seedServices([{ name: 'Haircut' }, { name: 'Manicure' }]));
    // 'Haircut' already exists by name — not duplicated; 'Manicure' is new.
    expect(result.current.draftServices.map((s) => s.name).sort()).toEqual([
      'Color',
      'Haircut',
      'Manicure',
    ]);
  });

  it('seedServices carries the starter description onto the draft row', () => {
    // WHO: an owner whose vertical has a LOOK-FIRST starter ("Service call").
    // WHAT: the description reaches the draft, so /setup/commit writes it to
    //       services.description.
    // WHEN: business-type pick → auto-seed.
    // WHERE: useWizardCrud.seedServices → insertDraftGraph.
    // WHY: resolveServiceForBooking's semantic step embeds
    //      concat_ws('. ', name, subtitle, description). Seeded name-only, a
    //      look-first row is unreachable by meaning — "water under my sink"
    //      matches nothing in the words "Service call" — so the call silently
    //      falls through to the tenant default instead of the right visit type.
    const { result } = setup();

    act(() =>
      result.current.seedServices([
        {
          name: 'Service call',
          description: 'Come out, find the leak, and say what the fix takes.',
        },
        { name: 'Drain cleaning' },
      ])
    );

    const byName = Object.fromEntries(result.current.draftServices.map((s) => [s.name, s]));
    expect(byName['Service call'].description).toBe(
      'Come out, find the leak, and say what the fix takes.'
    );
    // A SKU row has no description and must not gain an empty-string one — the
    // resolver's concat_ws would then embed a trailing separator for nothing.
    expect(byName['Drain cleaning'].description).toBeUndefined();
  });

  it('clearAutoSeeded drops only auto-seeded rows, keeping user-typed ones', () => {
    const { result } = setup();

    act(() => result.current.seedServices([{ name: 'Haircut' }]));
    act(() => result.current.startAddService());
    act(() =>
      result.current.setEditingService({ name: 'My Custom', description: '', duration_minutes: 30 })
    );
    act(() => result.current.saveService());
    expect(result.current.draftServices).toHaveLength(2);

    act(() => result.current.clearAutoSeeded());
    expect(result.current.draftServices.map((s) => s.name)).toEqual(['My Custom']);
  });

  it('clearAutoSeeded cascades to mappings made against the dropped rows', () => {
    const { result } = setup();

    act(() => result.current.seedServices([{ name: 'Haircut' }]));
    const seededServiceId = result.current.draftServices[0].service_id;

    act(() => result.current.startAddEmployee());
    act(() =>
      result.current.setEditingEmployee({ first_name: 'Tess', last_name: '', email: '', phone: '' })
    );
    act(() => result.current.saveEmployee());
    const employeeId = result.current.draftEmployees[0].employee_id;

    act(() => result.current.toggleEmployeeAssignment(seededServiceId, employeeId));
    expect(result.current.serviceEmployeeMappings).toHaveLength(1);

    act(() => result.current.clearAutoSeeded());

    expect(result.current.draftServices).toHaveLength(0);
    expect(result.current.serviceEmployeeMappings).toHaveLength(0);
    // The employee itself wasn't auto-seeded — it survives.
    expect(result.current.draftEmployees).toHaveLength(1);

    const graph = result.current.buildDraftGraph();
    expect(graph.service_employee).toHaveLength(0);
  });
});
