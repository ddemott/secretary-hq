export const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://localhost:4400';

// Pagination defaults
export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 1000;

// Timezone
export const DEFAULT_TIMEZONE = 'America/New_York';

// File upload
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Error messages — backend routes
export const ERR = {
  TENANT_NOT_FOUND: 'Tenant not found',
  TENANT_ID_REQUIRED: 'tenant_id is required',
  VALIDATION_FAILED: 'Validation failed',
  BILLING_NOT_CONFIGURED: 'Billing not configured',
  PROVISIONING_NOT_CONFIGURED:
    'Phone provisioning not configured (missing TELNYX_API_KEY or TELNYX_SIP_CONNECTION_ID)',
  PHONE_ALREADY_ACTIVE: 'Phone is already active for this tenant',
  PHONE_PROVISIONING_IN_PROGRESS: 'Phone provisioning is already in progress',
  PHONE_PROVISIONING_FAILED: 'Phone provisioning failed',
  NO_AVAILABLE_SLOTS: 'No available resource/employee combination found for the requested time',
} as const;
