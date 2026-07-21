import { normalizePhone } from './phone';
import type {
  Appointment,
  Customer,
  UsageStatementResult,
  ReminderDeliveryStats,
  Resource,
  Employee,
  Service,
  ScheduleEntry,
  EffectiveShift,
  BulkEffectiveShift,
  Skill,
  ServiceMapping,
  TenantFull,
  BusinessTemplate,
  Tenant,
  CalendarSettings,
  AnalyticsStats,
  AnalyticsCalls,
  AnalyticsCohorts,
  AnalyticsUtilization,
  Vocabulary,
  CoverageItem,
  WizardDraftGraph,
  CallSummary,
  CrmSyncStatus,
  SquareSettings,
  VoiceSession,
  VoiceSessionDisplay,
  CustomerContext,
  RecordHistoryResponse,
  DeletedRecordsResponse,
  RecordRestorePreview,
  RecentChangesResponse,
  VersionedTable,
  ChangeSource,
  RecordVersion,
  VersionComparison,
  TeamUser,
  CustomerMessage,
  AuditLogResponse,
  KnowledgeExplainResponse,
  TenantDataExportResponse,
  CustomerImportResult,
} from './types';

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (typeof window !== 'undefined' ? 'https://localhost:4001' : 'https://localhost:4001');

export const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const getHeaders = () => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getLocalStorageItem('authToken');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

export function getLocalStorageItem(key: string) {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem(key);
  }
  return null;
}

// SuperAdmin callers pass the entity's own tenant_id; non-admins use their JWT tenant.
export function getTargetTenantId(entityTenantId?: string) {
  const currentTenantId = getLocalStorageItem('tenantId');
  if (currentTenantId === SUPER_ADMIN_TENANT_ID && entityTenantId) {
    return entityTenantId;
  }
  return currentTenantId;
}

let subscriptionRequiredCallback: (() => void) | null = null;

export function setSubscriptionRequiredCallback(cb: () => void): void {
  subscriptionRequiredCallback = cb;
}

export function forceLogout() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('tenantId');
    localStorage.removeItem('userName');
    localStorage.removeItem('authToken');
    localStorage.removeItem('managedTenantId');
    localStorage.removeItem('managedTenantName');
    window.location.href = '/';
  }
}

// Client-side only — never used for auth decisions, only proactive refresh timing.
function decodeJwtPayload(token: string): { exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1])) as { exp?: number } | null;
  } catch {
    return null;
  }
}

let refreshInProgress: Promise<void> | null = null;
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes before expiry

async function ensureTokenFresh(): Promise<void> {
  const token = getLocalStorageItem('authToken');
  if (!token) return;

  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return;

  const expiresAt = payload.exp * 1000;
  const now = Date.now();

  // If more than 10 minutes until expiry, token is fresh
  if (expiresAt - now > TOKEN_REFRESH_BUFFER_MS) return;

  // If already expired, force logout
  if (now >= expiresAt) {
    forceLogout();
    return;
  }

  // Token is about to expire — refresh it
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = (await response.json()) as { success?: boolean; token?: string };
        if (data.success && data.token) {
          localStorage.setItem('authToken', data.token);
        }
      }
    } catch {
      // Refresh failed — token will expire naturally, then 401 triggers logout
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

async function checkAuthFailure(response: Response): Promise<string | null> {
  if (response.status === 401) {
    forceLogout();
    return 'Session expired. Please log in again.';
  }
  if (response.status === 402) {
    subscriptionRequiredCallback?.();
    return 'Upgrade required to access this feature.';
  }
  if (response.status === 404) {
    try {
      const body = (await response.clone().json()) as { code?: string };
      if (body.code === 'TENANT_NOT_FOUND') {
        forceLogout();
        return 'Your business account was not found. Please log in again.';
      }
    } catch {
      // Not a JSON response or not tenant error — fall through
    }
  }
  return null;
}

// Browser throws TypeError("Failed to fetch") when the self-signed cert is untrusted.
let certRedirectTriggered = false;
function handleFetchError(err: unknown) {
  if (
    err instanceof TypeError &&
    err.message === 'Failed to fetch' &&
    !certRedirectTriggered &&
    typeof window !== 'undefined' &&
    API_BASE_URL.startsWith('https://localhost')
  ) {
    certRedirectTriggered = true;
    // Reset after 10 seconds so the user can retry if the redirect didn't help
    setTimeout(() => {
      certRedirectTriggered = false;
    }, 10000);
    // Redirect to backend so the user can accept the self-signed cert
    window.location.href = `${API_BASE_URL}/health?redirect=${encodeURIComponent(window.location.href)}`;
  }
}

// Returns undefined (not just empty) when tenant is absent — the analytics endpoints
// require tenant_id, so sending date bounds without it produces a 400/404.
function analyticsQuery(
  tenantId: string | null,
  range?: { start_date?: string; end_date?: string }
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const query: Record<string, string> = { tenant_id: tenantId };
  if (range?.start_date) query.start_date = range.start_date;
  if (range?.end_date) query.end_date = range.end_date;
  return query;
}

function tenantParam(tenantId: string | null | undefined): Record<string, string> | undefined {
  return tenantId ? { tenant_id: tenantId } : undefined;
}

export async function apiFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  await ensureTokenFresh();
  let url = `${API_BASE_URL}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers: getHeaders() });
  } catch (err) {
    handleFetchError(err);
    throw err;
  }

  const authError = await checkAuthFailure(response);
  if (authError) throw new Error(authError);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `API Error: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// For POST endpoints that return raw JSON (not the {success,error} envelope).
// Throws on non-2xx so callers use try/catch, not a success check.
async function apiPostRaw<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  await ensureTokenFresh();
  const url = `${API_BASE_URL}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
  } catch (err) {
    handleFetchError(err);
    throw err;
  }

  const authError = await checkAuthFailure(response);
  if (authError) throw new Error(authError);

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error || `API Error: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function apiUpload<T>(endpoint: string, file: File, tenantId?: string | null): Promise<T> {
  await ensureTokenFresh();
  const formData = new FormData();
  formData.append('file', file);
  if (tenantId) formData.append('tenant_id', tenantId);

  const token = getLocalStorageItem('authToken');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    });
  } catch (err) {
    handleFetchError(err);
    throw err;
  }

  const authError = await checkAuthFailure(response);
  if (authError) throw new Error(authError);

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error || `API Error: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function apiMutate<T>(
  endpoint: string,
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  body?: Record<string, unknown>
): Promise<{ success: boolean; error?: string } & T> {
  await ensureTokenFresh();
  const url = `${API_BASE_URL}${endpoint}`;

  const headers = getHeaders();
  if (!body) delete headers['Content-Type'];

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    handleFetchError(err);
    throw err;
  }

  const authError = await checkAuthFailure(response);
  if (authError)
    return { success: false, error: authError } as { success: boolean; error?: string } & T;

  const json = (await response.json()) as unknown;
  const obj = json as Record<string, unknown>;
  if (!response.ok) {
    const errMsg = typeof obj['error'] === 'string' ? obj['error'] : `Error: ${response.status}`;
    return { success: false, error: errMsg, ...obj } as { success: boolean; error?: string } & T;
  }
  return { success: true, ...obj } as { success: boolean; error?: string } & T;
}

export const Api = {
  // --- CUSTOMERS ---
  customers: {
    list: (tenantId: string | null) => apiFetch<Customer[]>(`/customers`, tenantParam(tenantId)),

    create: (tenantId: string | null, data: Partial<Customer>) =>
      apiMutate<{ customer: Customer }>(`/customers/create`, 'POST', {
        tenant_id: tenantId,
        ...data,
        phone: normalizePhone(data.phone),
      }),

    update: (id: string, entityTenantId: string, data: Partial<Customer>) =>
      apiMutate<{ customer: Customer }>(`/customers/${id}`, 'PUT', {
        tenant_id: getTargetTenantId(entityTenantId),
        ...data,
        phone: normalizePhone(data.phone),
      }),

    delete: (id: string) => apiMutate(`/customers/${id}`, 'DELETE'),

    appointments: (customerId: string, tenantId: string | null) =>
      apiFetch<Appointment[]>(`/customers/${customerId}/appointments`, tenantParam(tenantId)),

    // Bulk CSV onboarding — the caller reads the file client-side (FileReader)
    // and POSTs the raw text; the backend parses/validates/dedupes per row.
    importCsv: (tenantId: string | null, csv: string) =>
      apiMutate<CustomerImportResult>(`/customers/import`, 'POST', {
        tenant_id: tenantId,
        csv,
      }),
  },

  // --- APPOINTMENTS ---
  appointments: {
    list: (tenantId: string | null, opts?: { startDate?: string; endDate?: string }) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (opts?.startDate) params.start_date = opts.startDate;
      if (opts?.endDate) params.end_date = opts.endDate;
      return apiFetch<Appointment[]>(
        `/appointments`,
        Object.keys(params).length > 0 ? params : undefined
      );
    },

    create: (tenantId: string | null, data: Partial<Appointment> & Record<string, unknown>) =>
      // On overlap, the backend returns 409 with `error_code: 'TIMESLOT_OCCUPIED'`
      // and a `conflict` block describing the existing appointment so the
      // dashboard can surface it (see ConflictModal). apiMutate spreads the
      // response body, so these fields flow through the typed return.
      apiMutate<{
        appointment_id?: string;
        error_code?: string;
        conflict?: {
          appointment_id: string;
          start_time: string;
          end_time: string;
          customer_name: string | null;
          employee_name: string | null;
          resource_name: string | null;
          description: string | null;
        };
        next_available?: Array<{
          start_time: string;
          end_time: string;
          employee_id: string;
          employee_name: string;
          resource_id: string;
          resource_name: string;
          skill_count: number;
        }>;
      }>(`/appointments/create`, 'POST', {
        tenant_id: tenantId,
        ...data,
        customer_phone: normalizePhone(data.customer_phone as string | undefined),
      }),

    update: (
      id: string,
      entityTenantId: string,
      data: Partial<Appointment> & Record<string, unknown>
    ) =>
      apiMutate(`/appointments/${id}/update`, 'POST', {
        tenant_id: getTargetTenantId(entityTenantId),
        ...data,
        customer_phone: normalizePhone(data.customer_phone as string | undefined),
      }),

    delete: (id: string) => apiMutate(`/appointments/${id}`, 'DELETE'),

    cancel: (id: string, tenantId: string | null) =>
      apiMutate(`/appointments/${id}/cancel`, 'POST', { tenant_id: tenantId }),

    // Reactivate flips a canceled appointment back to scheduled. Returns 409
    // with `error_code: 'TIMESLOT_OCCUPIED'` + a `conflict` block when the
    // slot was rebooked while canceled (mirrors /appointments/create's
    // shape so the dashboard can reuse ConflictModal). Returns 400 with
    // `error_code: 'NOT_CANCELED'` when the row isn't currently canceled —
    // the UI should refresh and clear the reactivate affordance.
    reactivate: (id: string, tenantId: string | null) =>
      apiMutate<{
        error_code?: string;
        conflict?: {
          appointment_id: string;
          start_time: string;
          end_time: string;
          customer_name: string | null;
          employee_name: string | null;
          resource_name: string | null;
          description: string | null;
        };
      }>(`/appointments/${id}/reactivate`, 'POST', { tenant_id: tenantId }),

    sendSelfServiceLinks: (id: string, tenantId?: string | null) =>
      apiMutate<{ message?: string; cancelLink?: string; rescheduleLink?: string }>(
        `/appointments/${id}/send-self-service-links`,
        'POST',
        tenantParam(tenantId)
      ),
  },

  // --- RESOURCES ---
  resources: {
    list: (tenantId: string | null) => apiFetch<Resource[]>(`/resources`, tenantParam(tenantId)),

    create: (tenantId: string | null, data: Partial<Resource>) =>
      apiMutate<{ resource: Resource }>(`/resources/create`, 'POST', {
        tenant_id: tenantId,
        ...data,
      }),

    update: (id: string, data: Partial<Resource>, tenantId?: string | null) =>
      apiMutate(`/resources/${id}/update`, 'POST', { tenant_id: tenantId, ...data }),

    delete: (id: string, tenantId?: string | null) =>
      apiMutate(`/resources/${id}/delete`, 'DELETE', { tenant_id: tenantId }),
  },

  // --- EMPLOYEES ---
  employees: {
    list: (tenantId: string | null) => apiFetch<Employee[]>(`/employees`, tenantParam(tenantId)),

    create: (tenantId: string | null, data: Partial<Employee>) =>
      apiMutate<{ employee: Employee }>(`/employees/create`, 'POST', {
        tenant_id: tenantId,
        ...data,
      }),

    update: (id: string, data: Partial<Employee>) =>
      apiMutate<{ employee: Employee }>(`/employees/${id}/update`, 'POST', data),

    delete: (id: string, tenantId: string | null) =>
      apiMutate(`/employees/${id}/delete`, 'DELETE', { tenant_id: tenantId }),
  },

  // --- USERS (login + role management) ---
  users: {
    list: (tenantId: string | null) =>
      apiFetch<{ success: true; users: TeamUser[] }>(`/users`, tenantParam(tenantId)),

    invite: (
      tenantId: string | null,
      data: { email: string; full_name: string; role: 'owner' | 'front_desk' }
    ) => apiMutate<{ user_id: string }>(`/users/invite`, 'POST', { tenant_id: tenantId, ...data }),

    updateRole: (id: string, tenantId: string | null, role: 'owner' | 'front_desk') =>
      apiMutate<{ role: 'owner' | 'front_desk' }>(`/users/${id}/role`, 'PATCH', {
        tenant_id: tenantId,
        role,
      }),

    // "Log out everywhere" — bumps the caller's own password_changed_at so
    // every outstanding JWT (including the current one) is rejected. The
    // caller must forceLogout() immediately after a success.
    revokeMySessions: () => apiMutate(`/users/me/revoke-sessions`, 'POST'),

    // Owner action: kill all of a staff member's sessions (same tenant only).
    revokeUserSessions: (id: string, tenantId: string | null) =>
      apiMutate(`/users/${id}/revoke-sessions`, 'POST', { tenant_id: tenantId }),
  },

  // --- MAPPINGS ---
  mappings: {
    listServiceResource: (tenantId: string | null) =>
      apiFetch<ServiceMapping[]>(`/mappings/service-resource`, tenantParam(tenantId)),

    assignServiceResource: (serviceId: string, resourceId: string, tenantId: string | null) =>
      apiMutate(`/services/${serviceId}/resources/${resourceId}/assign`, 'POST', {
        tenant_id: tenantId,
      }),

    unassignServiceResource: (serviceId: string, resourceId: string, tenantId: string | null) =>
      apiMutate(`/services/${serviceId}/resources/${resourceId}/unassign`, 'POST', {
        tenant_id: tenantId,
      }),

    assignServiceEmployee: (serviceId: string, employeeId: string, tenantId: string | null) =>
      apiMutate(`/services/${serviceId}/employees/${employeeId}/assign`, 'POST', {
        tenant_id: tenantId,
      }),

    unassignServiceEmployee: (serviceId: string, employeeId: string, tenantId: string | null) =>
      apiMutate(`/services/${serviceId}/employees/${employeeId}/unassign`, 'POST', {
        tenant_id: tenantId,
      }),

    listServiceEmployee: (tenantId: string | null) =>
      apiFetch<ServiceMapping[]>(`/mappings/service-employee`, tenantParam(tenantId)),
  },

  // --- SERVICES ---
  services: {
    list: (tenantId: string | null) => apiFetch<Service[]>(`/services`, tenantParam(tenantId)),

    create: (tenantId: string | null, data: Partial<Service>) =>
      apiMutate<{ service: Service }>(`/services/create`, 'POST', { tenant_id: tenantId, ...data }),

    update: (id: string, tenantId: string | null, data: Partial<Service>) =>
      apiMutate<{ service: Service }>(`/services/${id}/update`, 'POST', {
        tenant_id: tenantId,
        ...data,
      }),

    delete: (id: string, tenantId: string | null) =>
      apiMutate(`/services/${id}/delete?tenant_id=${tenantId}`, 'DELETE'),
  },

  // --- SHIFTS ---
  // No legacy weekly-pattern CRUD anymore — the wizard collects the
  // weekly pattern in form state and posts it directly to expandWeekly.
  // Date-specific entries are managed via `schedule` below
  // (employee_schedule table) and the copy-week + expand-weekly RPCs.
  shifts: {
    schedule: {
      list: (tenantId: string | null) =>
        apiFetch<ScheduleEntry[]>(`/shifts/overrides`, tenantParam(tenantId)),

      forDate: (tenantId: string | null, employeeId: string, startDate: string, endDate: string) =>
        apiFetch<EffectiveShift[]>(`/shifts/overrides`, {
          ...(tenantId ? { tenant_id: tenantId } : {}),
          employee_id: employeeId,
          start_date: startDate,
          end_date: endDate,
        }),

      /** Bulk: effective shifts for ALL employees on a date range (scheduler) */
      bulkForDate: (tenantId: string | null, startDate: string, endDate: string) =>
        apiFetch<BulkEffectiveShift[]>(`/shifts/overrides`, {
          ...(tenantId ? { tenant_id: tenantId } : {}),
          start_date: startDate,
          end_date: endDate,
        }),

      save: (tenantId: string | null, data: Partial<ScheduleEntry>) =>
        apiMutate<{ override: ScheduleEntry }>(`/shifts/overrides/create`, 'POST', {
          tenant_id: tenantId,
          ...data,
        }),

      // 2026-05-18 pilot #3: composite-key path (employee_id, shift_date).
      // Tenant comes from JWT — no query param needed.
      remove: (employeeId: string, shiftDate: string, tenantId: string | null) =>
        apiMutate(
          `/shifts/overrides/${encodeURIComponent(employeeId)}/${encodeURIComponent(shiftDate)}${tenantId ? `?tenant_id=${tenantId}` : ''}`,
          'DELETE'
        ),
    },

    copyWeek: (
      tenantId: string | null,
      employeeId: string,
      sourceStart: string,
      targetStart: string
    ) =>
      apiMutate<{ copied: number }>(`/shifts/copy-week`, 'POST', {
        tenant_id: tenantId,
        employee_id: employeeId,
        source_start: sourceStart,
        target_start: targetStart,
      }),

    /**
     * Fan a caller-supplied weekly pattern out into N weeks of
     * date-specific employee_schedule rows. Booking RPCs read only
     * employee_schedule, so this is the bridge that makes
     * post-onboarding bookings work. Idempotent — safe to re-call.
     *
     * Pattern is `{ day_of_week, start_time, end_time }[]`. The wizard
     * collects it in form state and posts it here at finalize; there
     * is no separate weekly-pattern table anymore.
     */
    // `replace` clears the employee's future schedule first, making `pattern` the
    // complete truth. Only pass it when the pattern was PRELOADED from the real
    // schedule — with a half-filled grid it would erase the days you left out.
    expandWeekly: (
      tenantId: string | null,
      employeeId: string,
      pattern: Array<{ day_of_week: number; start_time: string; end_time: string }>,
      weeksAhead?: number,
      replace?: boolean
    ) =>
      apiMutate<{ inserted: number; rangeStart: string; rangeEnd: string }>(
        `/shifts/expand-weekly`,
        'POST',
        {
          tenant_id: tenantId,
          employee_id: employeeId,
          pattern,
          weeks_ahead: weeksAhead,
          replace,
        }
      ),
  },

  // --- CALENDAR SYNC ---
  calendar: {
    getSettings: (tenantId: string | null) =>
      apiFetch<CalendarSettings | null>(`/calendar/settings`, tenantParam(tenantId)),

    getAuthUrl: (tenantId: string | null, provider: 'google' | 'outlook' = 'google') =>
      apiFetch<{ url: string }>(`/calendar/auth/${provider}`, tenantParam(tenantId)),

    updateSettings: (tenantId: string | null, data: Partial<CalendarSettings>) =>
      apiMutate<{ settings: CalendarSettings }>(`/calendar/settings`, 'POST', {
        tenant_id: tenantId,
        ...data,
      }),

    disconnect: (tenantId: string | null) =>
      apiMutate(`/calendar/settings/disconnect`, 'POST', { tenant_id: tenantId }),
  },

  // --- ANALYTICS ---
  analytics: {
    getStats: (tenantId: string | null) =>
      apiFetch<AnalyticsStats>(`/analytics/stats`, tenantParam(tenantId)),

    getCalls: (tenantId: string | null, range?: { start_date?: string; end_date?: string }) =>
      apiFetch<AnalyticsCalls>(`/analytics/calls`, analyticsQuery(tenantId, range)),

    getCohorts: (tenantId: string | null, range?: { start_date?: string; end_date?: string }) =>
      apiFetch<AnalyticsCohorts>(`/analytics/cohorts`, analyticsQuery(tenantId, range)),

    getUtilization: (tenantId: string | null, range?: { start_date?: string; end_date?: string }) =>
      apiFetch<AnalyticsUtilization>(`/analytics/utilization`, analyticsQuery(tenantId, range)),
  },

  // --- REMINDERS (delivery monitoring) ---
  reminders: {
    deliveryStats: (tenantId: string | null) =>
      apiFetch<ReminderDeliveryStats>(`/reminders/delivery-stats`, tenantParam(tenantId)),
  },

  // --- MASTER SKILLS ---
  skills: {
    list: (tenantId: string | null) => apiFetch<Skill[]>(`/skills`, tenantParam(tenantId)),

    create: (tenantId: string | null, data: Partial<Skill>) =>
      apiMutate<{ skill: Skill }>(`/skills/create`, 'POST', { tenant_id: tenantId, ...data }),

    // 2026-05-18 composite-key retrofit pilot #2: the surrogate
    // tenant_skill_id was dropped; the route now keys on the slug name.
    // Argument renamed so a wrong-type caller fails at type-check time.
    delete: (name: string, tenantId: string | null) =>
      apiMutate(`/skills/${encodeURIComponent(name)}`, 'DELETE', tenantParam(tenantId)),
  },

  // --- TENANTS & TEMPLATES ---
  tenants: {
    list: () => apiFetch<TenantFull[]>(`/tenants`),
    getConfig: (tenantId: string | null) => apiFetch<Tenant>(`/tenants/${tenantId}/config`),
    update: (id: string, data: Partial<TenantFull>) =>
      apiMutate(`/tenants/${id}/update-attributes`, 'POST', data as Record<string, unknown>),
    // `disclosure_attested` is a per-request affirmation, not a stored Tenant
    // column — the backend requires it only when call_disclosure changes to a
    // custom value. It rides alongside the Partial<Tenant> fields.
    updateConfig: (id: string, data: Partial<Tenant> & { disclosure_attested?: boolean }) =>
      apiMutate(`/tenants/${id}/update-config`, 'POST', data as Record<string, unknown>),
    delete: (id: string) => apiMutate(`/tenants/${id}`, 'DELETE'),
    create: (data: Record<string, unknown>) =>
      apiMutate<{ tenant_id: string }>(`/tenants/create`, 'POST', data),
    reorder: (order: string[]) => apiMutate(`/tenants/reorder`, 'POST', { order }),
    // Wizard Done — promotes every is_auto_seeded row to user-owned so a
    // post-launch business_type change in Settings doesn't wipe them.
    // See routes/tenants.ts /finalize-setup.
    finalizeSetup: (id: string) =>
      apiMutate<{ services: number; resources: number }>(
        `/tenants/${id}/finalize-setup`,
        'POST',
        {}
      ),
  },

  templates: {
    list: () => apiFetch<BusinessTemplate[]>(`/templates`),
    listFull: () => apiFetch<BusinessTemplate[]>(`/templates/full`),
  },

  // --- FEEDBACK ---
  feedback: {
    submit: (
      tenantId: string | null,
      data: { page: string; context?: string; comment: string; rating?: number }
    ) => apiMutate(`/feedback`, 'POST', { tenant_id: tenantId, ...data }),
  },

  // --- CALL SUMMARIES ---
  callSummaries: {
    list: (tenantId: string | null, customerId: string) =>
      apiFetch<CallSummary[]>(`/call-summaries`, {
        ...tenantParam(tenantId),
        customer_id: customerId,
      }),
  },

  // --- VOCABULARY ---
  vocabulary: {
    get: (tenantId: string | null) => apiFetch<Vocabulary>(`/vocabulary`, tenantParam(tenantId)),
  },

  // --- COVERAGE ---
  coverage: {
    check: (tenantId: string | null, startDate?: string, endDate?: string) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      return apiFetch<CoverageItem[]>(`/coverage`, params);
    },
    // Wizard Phase B — coverage for a DRAFT graph that isn't in the DB yet.
    // tenant_id must be sent explicitly (same as every other mutating Api.*
    // call) — requireTenantId() falls back to the JWT's own tenant when it's
    // absent, which is wrong for a super-admin managing a DIFFERENT tenant
    // (the wizard would silently commit into the super-admin's own tenant
    // instead of the one being set up). tenantMiddleware validates this
    // user-supplied value against the JWT (must match, or caller must be
    // super-admin) before requireTenantId ever sees it.
    dryRun: (tenantId: string | null, draft: WizardDraftGraph) =>
      apiPostRaw<CoverageItem[]>(`/coverage/dry-run`, {
        tenant_id: tenantId,
        ...draft,
      }),
  },

  // --- SETUP (Wizard Phase B) ---
  setup: {
    // The tenant's CURRENT graph, in draft shape. The wizard loads this as its
    // starting draft so a re-run edits the real business instead of duplicating
    // it. Required before a 'sync' commit — see the route's doc comment.
    graph: (tenantId: string | null) =>
      apiFetch<{
        services: Array<{
          service_id: string;
          name: string;
          subtitle: string | null;
          description: string | null;
          duration_minutes: number;
          price: number | null;
        }>;
        resources: Array<{ resource_id: string; name: string; description: string | null }>;
        employees: Array<{
          employee_id: string;
          name: string;
          first_name: string | null;
          last_name: string | null;
          email: string | null;
          phone: string | null;
        }>;
        shifts: Array<{
          employee_id: string;
          day_of_week: number;
          start_time: string;
          end_time: string;
        }>;
        service_employee: Array<{ service_id: string; employee_id: string }>;
        service_resource: Array<{ service_id: string; resource_id: string }>;
      }>(`/setup/graph`, tenantParam(tenantId)),
    // What a SYNC commit of this draft would destroy: upcoming appointments booked
    // against services/staff/resources the owner removed in the wizard. Called
    // BEFORE commit so they can still back out — the commit reports the same
    // number, but by then the soft-delete has already happened.
    impact: (tenantId: string | null, draft: WizardDraftGraph) =>
      apiMutate<{
        impact: {
          upcomingAppointments: number;
          removed: Array<{
            kind: 'service' | 'employee' | 'resource';
            name: string;
            upcomingAppointments: number;
          }>;
        };
      }>(`/setup/impact`, 'POST', { tenant_id: tenantId, ...draft }),

    // Commits the wizard's draft entity graph — same shape as coverage.dryRun, but
    // persists. See docs/superpowers/specs/2026-07-05-wizard-phase-b-design.md.
    // tenant_id explicit for the same reason as coverage.dryRun above.
    // `mode` defaults to 'create' (INSERT-only, and 409s if the tenant already
    // has services). Pass 'sync' when the wizard preloaded the tenant's real
    // graph: the draft is then the complete desired state, so rows carrying an
    // existing_id are updated, new rows inserted, and omitted rows soft-deleted.
    commit: (
      tenantId: string | null,
      draft: WizardDraftGraph,
      mode: 'create' | 'sync' = 'create'
    ) =>
      apiMutate<{
        counts: {
          services: number;
          resources: number;
          employees: number;
          serviceEmployee: number;
          serviceResource: number;
          updated: number;
          pruned: number;
          upcoming_appointments_affected: number;
        };
      }>(`/setup/commit`, 'POST', {
        tenant_id: tenantId,
        mode,
        ...draft,
      }),
  },

  // --- KNOWLEDGE BASE (RAG) ---
  knowledge: {
    list: (tenantId: string | null) =>
      apiFetch<
        Array<{
          tenant_doc_id: string;
          title: string;
          section: string | null;
          content: string;
          source: string;
          created_at: string;
        }>
      >(`/knowledge`, tenantParam(tenantId)),

    delete: (id: string, tenantId: string | null) =>
      apiMutate(`/knowledge/${id}`, 'DELETE', { tenant_id: tenantId }),

    // `source` defaults to 'policy-questionnaire' (the preset-question
    // catalog path). Caller passes 'custom-question' for owner-authored
    // Q&A added via the new Custom Questions section. The discriminator
    // lets the questionnaire UI filter its own preset answers without
    // mixing in custom entries.
    add: (
      tenantId: string | null,
      data: { question: string; answer: string; category?: string; source?: string }
    ) =>
      apiMutate<{ success: boolean; tenant_doc_id: string }>(`/knowledge/add`, 'POST', {
        tenant_id: tenantId,
        ...data,
        source: data.source ?? 'policy-questionnaire',
      }),

    update: (
      id: string,
      tenantId: string | null,
      data: { question: string; answer: string; category?: string }
    ) =>
      apiMutate<{ success: boolean }>(`/knowledge/${id}`, 'PUT', {
        tenant_id: tenantId,
        ...data,
        source: 'policy-questionnaire',
      }),

    unanswered: (tenantId: string | null) =>
      apiFetch<{
        success: boolean;
        questions: Array<{
          unanswered_question_id: string;
          question: string;
          caller_phone: string | null;
          caller_message: string | null;
          created_at: string;
        }>;
      }>(`/knowledge/unanswered`, tenantParam(tenantId)),

    resolveUnanswered: (id: string, tenantId: string | null) =>
      apiMutate<{ success: boolean }>(`/knowledge/unanswered/${id}/resolve`, 'PATCH', {
        tenant_id: tenantId,
      }),

    ingest: (tenantId: string | null, file: File) =>
      apiUpload<{ success: boolean; chunksIngested: number; error?: string }>(
        `/knowledge/ingest`,
        file,
        tenantId
      ),

    // Prefills standard questions from the document prose; adds Q:/A: custom questions staged for review.
    importDocument: (tenantId: string | null, file: File) =>
      apiUpload<{
        success: boolean;
        standard_answers?: Array<{
          questionId: string | null;
          question: string;
          answer: string | null;
        }>;
        custom_questions?: Array<{ question: string; answer: string }>;
        malformed?: string[];
        confirmed?: number;
        error?: string;
      }>(`/knowledge/import-document`, file, tenantId),

    importWebsite: (tenantId: string | null, url: string) =>
      apiMutate<{
        success: boolean;
        extracted?: any[];
        discovered?: any[];
        confirmed?: number;
        suggestions?: number;
        error?: string;
      }>(`/knowledge/import-website`, 'POST', { tenant_id: tenantId, url }),

    suggestions: (tenantId: string | null) =>
      apiFetch<{
        success: boolean;
        suggestions: Array<{
          id: string;
          question_id: string | null;
          question: string;
          answer: string;
          source_url: string | null;
          confidence: number | null;
          status: string;
          created_at: string;
        }>;
      }>(`/knowledge/suggestions`, tenantParam(tenantId)),

    approveSuggestion: (id: string, tenantId: string | null) =>
      apiMutate<{ success: boolean }>(`/knowledge/suggestions/${id}`, 'PATCH', {
        tenant_id: tenantId,
        status: 'confirmed',
      }),

    rejectSuggestion: (id: string, tenantId: string | null) =>
      apiMutate<{ success: boolean }>(`/knowledge/suggestions/${id}`, 'PATCH', {
        tenant_id: tenantId,
        status: 'rejected',
      }),

    // "Explain this answer" RAG debugger — shows which KB chunks the AI
    // retrieves for a question + their scores (owner-only on the backend).
    explain: (tenantId: string | null, question: string) =>
      apiMutate<KnowledgeExplainResponse>(`/knowledge/explain`, 'POST', {
        tenant_id: tenantId,
        question,
      }),
  },

  // --- AUDIT LOG (owner-only change history) ---
  auditLog: {
    list: (
      tenantId: string | null,
      params?: {
        limit?: number;
        offset?: number;
        table_name?: string;
        start_date?: string;
        end_date?: string;
      }
    ) => {
      const query: Record<string, string> = {};
      if (tenantId) query.tenant_id = tenantId;
      if (params?.limit != null) query.limit = String(params.limit);
      if (params?.offset != null) query.offset = String(params.offset);
      if (params?.table_name) query.table_name = params.table_name;
      if (params?.start_date) query.start_date = params.start_date;
      if (params?.end_date) query.end_date = params.end_date;
      return apiFetch<AuditLogResponse>(
        `/audit-log`,
        Object.keys(query).length > 0 ? query : undefined
      );
    },
  },

  // --- DATA EXPORT (owner-only data portability) ---
  exportData: {
    tenantData: (tenantId: string | null) =>
      apiFetch<TenantDataExportResponse>(`/export/tenant-data`, tenantParam(tenantId)),

    // CSV exports return text/csv, not JSON, so apiFetch (which json()s the
    // body) can't be used — this is the one plain-text fetch in the client.
    csv: async (
      kind: 'customers' | 'appointments' | 'calls',
      tenantId: string | null
    ): Promise<string> => {
      await ensureTokenFresh();
      const params = tenantId ? `?${new URLSearchParams({ tenant_id: tenantId })}` : '';
      let response: Response;
      try {
        response = await fetch(`${API_BASE_URL}/export/${kind}.csv${params}`, {
          headers: getHeaders(),
        });
      } catch (err) {
        handleFetchError(err);
        throw err;
      }
      const authError = await checkAuthFailure(response);
      if (authError) throw new Error(authError);
      if (!response.ok) {
        // Failures come back in the standard JSON { success, error } shape.
        // Surface the human-readable `error` field (mirrors apiMutate) rather
        // than throwing the raw JSON blob into a toast; fall back to the raw
        // body when it isn't JSON (e.g. a proxy 502 HTML page).
        const bodyText = await response.text();
        let message = bodyText;
        try {
          const parsed = JSON.parse(bodyText) as { error?: unknown };
          if (typeof parsed.error === 'string') message = parsed.error;
        } catch {
          // Non-JSON body — keep the raw text.
        }
        throw new Error(message || `API Error: ${response.status}`);
      }
      return response.text();
    },
  },

  // --- BILLING ---
  billing: {
    checkout: (tenantId: string, plan: 'solo' | 'growth' | 'professional') =>
      apiMutate<{ url: string }>(`/billing/checkout`, 'POST', { tenant_id: tenantId, plan }),

    status: (tenantId: string) =>
      apiFetch<{ subscription_status: string; subscription_plan: string | null }>(
        `/billing/status`,
        { tenant_id: tenantId }
      ),

    // Online billing statement ("no paper"): monthly answered-call usage +
    // pack overage math, computed live from voice_sessions.
    usage: (tenantId: string, months = 6) =>
      apiFetch<UsageStatementResult>(`/billing/usage`, {
        tenant_id: tenantId,
        months: String(months),
      }),

    portal: (tenantId: string) =>
      apiMutate<{ url: string }>(`/billing/portal`, 'POST', { tenant_id: tenantId }),
  },

  // --- PHONE PROVISIONING ---
  provisioning: {
    activate: (tenantId: string, areaCode?: string) =>
      apiMutate<{ success: boolean; phone_number: string; telnyx_phone_number_id: string }>(
        `/provisioning/activate`,
        'POST',
        { tenant_id: tenantId, ...(areaCode ? { area_code: areaCode } : {}) }
      ),

    deactivate: (tenantId: string) =>
      apiMutate<{ success: boolean; warnings?: string[] }>(`/provisioning/deactivate`, 'POST', {
        tenant_id: tenantId,
      }),

    status: (tenantId: string) =>
      apiFetch<{
        phone_status: string;
        inbound_phone: string | null;
        telnyx_phone_number_id: string | null;
        forwarded_from_phone: string | null;
      }>(`/provisioning/status`, { tenant_id: tenantId }),

    // Owner wants to port their real number into Telnyx instead of
    // forwarding. Emails the platform admin — no porting API is invoked
    // (a real LNP port always needs a human). See GoLivePanel Stage C.
    portInquiry: (tenantId: string, phoneNumber: string, notes?: string) =>
      apiMutate<{ success: boolean }>(`/provisioning/port-inquiry`, 'POST', {
        tenant_id: tenantId,
        phone_number: phoneNumber,
        ...(notes ? { notes } : {}),
      }),
  },

  // --- SQUARE CRM ---
  square: {
    getSettings: (tenantId: string | null) =>
      apiFetch<SquareSettings | null>(`/square/settings`, tenantParam(tenantId)),

    getAuthUrl: (tenantId: string | null) =>
      apiFetch<{ success: boolean; authUrl: string }>(`/square/auth`, tenantParam(tenantId)),

    disconnect: (tenantId: string | null) =>
      apiMutate(`/square/settings/disconnect`, 'POST', { tenant_id: tenantId }),

    triggerSync: (tenantId: string | null) =>
      apiMutate<{ customersSynced: number; appointmentsSynced: number; errors: number }>(
        `/square/sync`,
        'POST',
        { tenant_id: tenantId }
      ),

    getSyncStatus: (tenantId: string | null) =>
      apiFetch<CrmSyncStatus>(`/square/sync/status`, tenantParam(tenantId)),
  },

  // --- VOICE CRM (Call Context) ---
  voice: {
    getActiveCalls: (tenantId: string | null) =>
      apiFetch<{ calls: VoiceSessionDisplay[]; total: number }>(
        `/voice/active`,
        tenantParam(tenantId)
      ),

    getHistory: (
      tenantId: string | null,
      opts?: { customer_id?: string; status?: string; limit?: number; offset?: number }
    ) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (opts?.customer_id) params.customer_id = opts.customer_id;
      if (opts?.status) params.status = opts.status;
      if (opts?.limit) params.limit = String(opts.limit);
      if (opts?.offset) params.offset = String(opts.offset);
      return apiFetch<{ calls: VoiceSession[]; total: number; has_more: boolean }>(
        `/voice/history`,
        Object.keys(params).length > 0 ? params : undefined
      );
    },

    getSession: (tenantId: string | null, callId: string) =>
      apiFetch<VoiceSession>(`/voice/session/${callId}`, tenantParam(tenantId)),

    getCustomerContext: (tenantId: string | null, customerId: string) =>
      apiFetch<CustomerContext>(`/voice/customer/${customerId}/context`, tenantParam(tenantId)),

    getCustomerCalls: (tenantId: string | null, customerId: string, limit?: number) =>
      apiFetch<{ calls: VoiceSession[] }>(`/voice/customer/${customerId}/calls`, {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }),

    addCustomerNote: (
      tenantId: string | null,
      data: { customer_id: string; note: string; note_type?: string; call_id?: string }
    ) =>
      apiMutate<{ success: boolean }>(`/voice/customer/note`, 'POST', {
        tenant_id: tenantId,
        ...data,
      }),

    // Soft-delete a single call record (owner-only; recoverable, hidden from
    // lists + analytics).
    deleteCall: (tenantId: string | null, voiceSessionId: string) =>
      apiMutate(`/voice/session/${voiceSessionId}`, 'DELETE', { tenant_id: tenantId }),

    // Bulk soft-delete finished calls older than N days (owner-only). Returns
    // the number of calls removed.
    deleteOldCalls: (tenantId: string | null, olderThanDays: number) =>
      apiMutate<{ result?: { deleted: number } }>(`/voice/delete-old`, 'POST', {
        tenant_id: tenantId,
        older_than_days: olderThanDays,
      }),

    // Used during active calls to look up context by incoming phone number.
    getContextByPhone: (tenantId: string | null, phone: string) =>
      apiFetch<CustomerContext>(
        `/voice/context/${encodeURIComponent(phone)}`,
        tenantParam(tenantId)
      ),

    listMessages: (
      tenantId: string | null,
      opts?: { status?: string; limit?: number; offset?: number }
    ) =>
      apiFetch<CustomerMessage[]>(
        `/voice/messages`,
        tenantId
          ? {
              tenant_id: tenantId,
              ...(opts?.status ? { status: opts.status } : {}),
              ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
              ...(opts?.offset !== undefined ? { offset: String(opts.offset) } : {}),
            }
          : undefined
      ),

    updateMessageStatus: (messageId: string, status: 'new' | 'read' | 'actioned') =>
      apiMutate<{ success: boolean }>(`/voice/messages/${messageId}`, 'PATCH', { status }),
  },

  // --- Version History API ---
  versionHistory: {
    getHistory: (tenantId: string | null, table: VersionedTable, recordId: string) =>
      apiFetch<RecordHistoryResponse>(
        `/records/${table}/${recordId}/history`,
        tenantParam(tenantId)
      ),

    getVersion: (
      tenantId: string | null,
      table: VersionedTable,
      recordId: string,
      versionNumber: number
    ) =>
      apiFetch<RecordVersion>(
        `/records/${table}/${recordId}/version/${versionNumber}`,
        tenantParam(tenantId)
      ),

    compareVersions: (
      tenantId: string | null,
      table: VersionedTable,
      recordId: string,
      versionA: number,
      versionB: number
    ) =>
      apiFetch<{
        record_id: string;
        table_name: string;
        version_a: number;
        version_b: number;
        differences: VersionComparison[];
      }>(`/records/${table}/${recordId}/compare/${versionA}/${versionB}`, tenantParam(tenantId)),

    getRestorePreview: (tenantId: string | null, table: VersionedTable, recordId: string) =>
      apiFetch<RecordRestorePreview>(
        `/records/${table}/${recordId}/restore-preview`,
        tenantParam(tenantId)
      ),

    restoreFields: (
      tenantId: string | null,
      table: VersionedTable,
      recordId: string,
      // Either a single group or a batch of groups restored in one transaction.
      data: (
        | { source_version: number; fields: string[] }
        | { restores: { source_version: number; fields: string[] }[] }
      ) & {
        restored_by?: string;
        change_source?: ChangeSource;
      }
    ) =>
      apiMutate<{ success: boolean; data: Record<string, unknown>; message: string }>(
        `/records/${table}/${recordId}/restore-fields`,
        'POST',
        { tenant_id: tenantId, ...data }
      ),

    softDelete: (
      tenantId: string | null,
      table: VersionedTable,
      recordId: string,
      data?: { deleted_by?: string; change_source?: ChangeSource }
    ) =>
      apiMutate<{ success: boolean; message: string }>(
        `/records/${table}/${recordId}/soft-delete`,
        'POST',
        { tenant_id: tenantId, ...(data || {}) }
      ),

    restoreDeleted: (
      tenantId: string | null,
      table: VersionedTable,
      recordId: string,
      data?: { restored_by?: string; change_source?: ChangeSource }
    ) =>
      apiMutate<{ success: boolean; message: string }>(
        `/records/${table}/${recordId}/restore`,
        'POST',
        { tenant_id: tenantId, ...(data || {}) }
      ),

    getDeleted: (
      tenantId: string | null,
      table: VersionedTable,
      opts?: { limit?: number; offset?: number }
    ) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (opts?.limit) params.limit = String(opts.limit);
      if (opts?.offset) params.offset = String(opts.offset);
      return apiFetch<DeletedRecordsResponse>(
        `/records/${table}/deleted`,
        Object.keys(params).length > 0 ? params : undefined
      );
    },

    copyFields: (
      tenantId: string | null,
      table: VersionedTable,
      data: {
        source_record_id: string;
        target_record_id: string;
        fields: string[];
        copied_by?: string;
        change_source?: ChangeSource;
      }
    ) =>
      apiMutate<{ success: boolean; data: Record<string, unknown>; message: string }>(
        `/records/${table}/copy-fields`,
        'POST',
        { tenant_id: tenantId, ...data }
      ),

    getRecentChanges: (
      tenantId: string | null,
      opts?: {
        limit?: number;
        offset?: number;
        table?: VersionedTable;
        change_type?: string;
        change_source?: ChangeSource;
      }
    ) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (opts?.limit) params.limit = String(opts.limit);
      if (opts?.offset) params.offset = String(opts.offset);
      if (opts?.table) params.table = opts.table;
      if (opts?.change_type) params.change_type = opts.change_type;
      if (opts?.change_source) params.change_source = opts.change_source;
      return apiFetch<RecentChangesResponse>(
        `/records/recent-changes`,
        Object.keys(params).length > 0 ? params : undefined
      );
    },
  },

  communications: {
    history: (
      tenantId: string | null,
      opts?: {
        type?: 'all' | 'sms' | 'email';
        /** Delivery-status filter (backend default 'all') — 'failed' powers the failed-delivery drill-down. */
        status?: 'all' | 'sent' | 'failed' | 'queued';
        limit?: number;
        offset?: number;
      }
    ) => {
      const params: Record<string, string> = {};
      if (tenantId) params.tenant_id = tenantId;
      if (opts?.type) params.type = opts.type;
      if (opts?.status) params.status = opts.status;
      if (opts?.limit != null) params.limit = String(opts.limit);
      if (opts?.offset != null) params.offset = String(opts.offset);
      return apiFetch<{
        success: boolean;
        history: Array<{
          communications_history_id: number;
          customer_id: string | null;
          channel: 'sms' | 'email';
          direction: string;
          recipient: string;
          subject: string | null;
          body: string;
          status: string;
          provider_message_id: string | null;
          error: string | null;
          created_at: string;
        }>;
        total: number;
      }>('/communications/history', Object.keys(params).length > 0 ? params : undefined);
    },
  },
};
