import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Api } from './api';
import { useActiveTenantId } from '@/lib/SessionContext';
import { buildMappingMaps, type ServiceMappingMaps } from './availability';
import type { Customer, Resource, Employee, Service, Skill } from './types';

/**
 * Generic form state hook. Manages form fields, dirty tracking, and reset.
 * Eliminates the repeated useState + handleChange pattern across CRUD views.
 *
 * Usage:
 *   const { form, setField, setForm, reset, isDirty } = useFormState({ name: '', email: '' });
 *   <Input value={form.name} onChange={e => setField('name', e.target.value)} />
 */
export function useFormState<T extends Record<string, unknown>>(initialState: T) {
  const [form, setForm] = useState<T>(initialState);
  const [original, setOriginal] = useState<T>(initialState);

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(
    (newState?: T) => {
      const state = newState ?? original;
      setForm(state);
      setOriginal(state);
    },
    [original]
  );

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  return { form, setField, setForm, reset, isDirty };
}

export interface UseStaticDataOptions {
  /**
   * Whether to fetch customers alongside resources/employees/services/skills.
   * Defaults to true. Customer rows carry PII (name/phone/email/address/notes),
   * so screens that never render customer data should opt out rather than pull
   * every customer as a side effect of loading staff/shift/resource state —
   * this was firing on a super-admin's "all businesses" sentinel tenant with
   * zero server-side scoping (audit finding 2026-09-16). `EmployeeManagementView`
   * / `ShiftManagementView` / `ResourceManagerView` pass `{ customers: false }`.
   */
  customers?: boolean;
}

/**
 * Hook to fetch and manage static data for the active tenant.
 * Automatically uses the active tenant ID from SessionContext.
 */
export function useStaticData(
  tenantIdOverride?: string | null,
  options?: UseStaticDataOptions
) {
  const contextTenantId = useActiveTenantId();
  const tenantId = tenantIdOverride !== undefined ? tenantIdOverride : contextTenantId;
  const includeCustomers = options?.customers !== false;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [cRes, rRes, eRes, sRes, skRes] = await Promise.allSettled([
      includeCustomers ? Api.customers.list(tenantId) : Promise.resolve([]),
      Api.resources.list(tenantId),
      Api.employees.list(tenantId),
      Api.services.list(tenantId),
      Api.skills.list(tenantId),
    ]);

    setCustomers(cRes.status === 'fulfilled' && Array.isArray(cRes.value) ? cRes.value : []);
    setResources(rRes.status === 'fulfilled' && Array.isArray(rRes.value) ? rRes.value : []);
    setEmployees(eRes.status === 'fulfilled' && Array.isArray(eRes.value) ? eRes.value : []);
    setServices(sRes.status === 'fulfilled' && Array.isArray(sRes.value) ? sRes.value : []);
    setSkills(skRes.status === 'fulfilled' && Array.isArray(skRes.value) ? skRes.value : []);

    const failures = [cRes, rRes, eRes, sRes, skRes].filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const firstError = failures[0].reason as { message?: string } | undefined;
      console.error('Some data fetches failed', failures);
      setError(firstError?.message ?? 'Some data failed to load');
    }

    setLoading(false);
  }, [tenantId, includeCustomers]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    customers,
    resources,
    employees,
    services,
    skills,
    loading,
    error,
    refresh: fetchData,
  };
}

// ── Granular data hooks ─────────────────────────────────────────────
// Use these when a component only needs 1-2 resource types.
// Avoids fetching all 5 when only 1 is needed.

/**
 * True while the component is mounted. Read it after every `await` before
 * calling a setter: these hooks fire their fetch from an effect with no
 * cancellation, so a component that unmounts mid-flight would otherwise
 * setState on a dead tree. Under jsdom that surfaces as an unhandled
 * `ReferenceError: window is not defined` once the test environment is torn
 * down — which fails the whole vitest run even though every test passed.
 * Mirrors the `let cancelled = false` idiom used by useTenantTimezone below.
 */
function useIsMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function useEntityList<T>(
  fetcher: (tenantId: string) => Promise<T[]>,
  tenantIdOverride?: string | null
) {
  const contextTenantId = useActiveTenantId();
  const tenantId = tenantIdOverride !== undefined ? tenantIdOverride : contextTenantId;
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const mounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const result = await fetcher(tenantId);
      if (!mounted.current) return;
      setData(Array.isArray(result) ? result : []);
    } catch {
      if (!mounted.current) return;
      setData([]);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [tenantId, fetcher, mounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, refresh };
}

export function useCustomers(tenantId?: string | null) {
  return useEntityList<Customer>(Api.customers.list, tenantId);
}

export function useResources(tenantId?: string | null) {
  return useEntityList<Resource>(Api.resources.list, tenantId);
}

export function useEmployees(tenantId?: string | null) {
  return useEntityList<Employee>(Api.employees.list, tenantId);
}

export function useServices(tenantId?: string | null) {
  return useEntityList<Service>(Api.services.list, tenantId);
}

export function useSkills(tenantId?: string | null) {
  return useEntityList<Skill>(Api.skills.list, tenantId);
}

/**
 * Loads service ↔ employee and service ↔ resource mappings and exposes them
 * as Sets keyed by service_id for O(1) lookup. Used by QuickBookPanel and
 * AppointmentDetailPanel to filter dropdowns to (employee, resource)
 * combinations valid for the selected service — closing the gap where the
 * dashboard previously let operators pick incompatible combinations and
 * relied on the booking RPC's late rejection to surface the problem.
 *
 * "Booking only when everything aligns" — the user's words 2026-05-07.
 */
export function useServiceMappings(tenantIdOverride?: string | null): {
  maps: ServiceMappingMaps;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const contextTenantId = useActiveTenantId();
  const tenantId = tenantIdOverride !== undefined ? tenantIdOverride : contextTenantId;
  const [serviceEmployeeRows, setServiceEmployeeRows] = useState<
    Awaited<ReturnType<typeof Api.mappings.listServiceEmployee>>
  >([]);
  const [serviceResourceRows, setServiceResourceRows] = useState<
    Awaited<ReturnType<typeof Api.mappings.listServiceResource>>
  >([]);
  const [loading, setLoading] = useState(false);
  const mounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const [seRes, srRes] = await Promise.allSettled([
        Api.mappings.listServiceEmployee(tenantId),
        Api.mappings.listServiceResource(tenantId),
      ]);
      if (!mounted.current) return;
      setServiceEmployeeRows(
        seRes.status === 'fulfilled' && Array.isArray(seRes.value) ? seRes.value : []
      );
      setServiceResourceRows(
        srRes.status === 'fulfilled' && Array.isArray(srRes.value) ? srRes.value : []
      );
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [tenantId, mounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const maps = useMemo(
    () => buildMappingMaps(serviceEmployeeRows, serviceResourceRows),
    [serviceEmployeeRows, serviceResourceRows]
  );

  return { maps, loading, refresh };
}

/**
 * Fetch the active tenant's IANA timezone via /tenants/:id/config.
 *
 * Returns `undefined` while loading or on fetch error — the scheduler's
 * date-nav uses that to fall back to browser-local time rather than flash
 * empty state. Once resolved, returns the timezone string (e.g.,
 * `America/Chicago`).
 *
 * Why a dedicated hook rather than extending useStaticData: timezone is a
 * scalar property of the tenant row, not a list of entities. Tying it to
 * the 5-parallel-fetch useStaticData would couple unrelated render
 * lifecycles — a refetch of customers/employees/etc. would needlessly
 * re-fetch the timezone, and vice versa.
 */
export function useTenantTimezone(): string | undefined {
  const tenantId = useActiveTenantId();
  const [timezone, setTimezone] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!tenantId) {
      setTimezone(undefined);
      return;
    }
    let cancelled = false;
    Api.tenants
      .getConfig(tenantId)
      .then((data) => {
        if (!cancelled) setTimezone(data?.timezone);
      })
      .catch(() => {
        if (!cancelled) setTimezone(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return timezone;
}
