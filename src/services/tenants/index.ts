/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Tenant Configuration Service.
 * Database-backed implementation for communications and reminder services.
 *
 * Reads tenant configuration from the existing `tenants` table.
 *
 * All methods are async. Earlier shapes mixed sync (cache-only) and async
 * (DB-backed) variants on the interface — every real caller already
 * `await`'d the sync methods anyway, and the cache-only path silently
 * returned null when the cache was cold. Consolidated 2026-05-13 to a
 * single async surface that always reads through the cache; the
 * Postgres impl caches per-tenant for 1 minute to keep email/reminder
 * hot paths off the DB without forcing callers to think about warm-up.
 */

import { type Pool, type PoolClient } from 'pg';
import { getPool } from '../../database/index.js';

/**
 * Tenant configuration interface.
 *
 * Field set mirrors the real `tenants` table schema. There is no separate
 * `business_name` or `owner_email` column today — `name` is the business's
 * display name. Two phone fields live at tenant level: `owner_phone` (the
 * owner's personal number, surfaced as `phone`) and `inbound_phone` (the
 * Telnyx-provisioned PSTN number, surfaced as `inboundPhone`). Adding email
 * would require a schema migration AND a UI; until that ships, omitting it
 * here is the honest shape.
 */
export interface TenantConfig {
  tenantId: string | number;
  name: string;
  phone?: string;
  inboundPhone?: string;
  timezone?: string;
  /** Owner-supplied logo image URL, rendered in tenant-to-customer email
   *  headers (emailService.ts). No upload/storage — a plain URL the owner
   *  pastes on Business Settings. undefined/blank = no logo (default). */
  logoUrl?: string;
  settings?: {
    smsEnabled?: boolean;
    emailEnabled?: boolean;
    reminderHours?: number[];
    defaultProvider?: string;
  };
}

/**
 * Notification preferences for a tenant.
 *
 * `contactInfo.email` is omitted: the schema has no tenant-level email
 * column (a tenant's owner email is stored on the `users` table, not
 * `tenants`). If a future product call introduces a tenant-level reply-to
 * address, add the column + the field together so the type stays honest.
 */
export interface NotificationPreferences {
  smsEnabled: boolean;
  emailEnabled: boolean;
  reminderHours: number[];
  contactInfo?: {
    phone?: string;
    address?: string;
  };
}

/**
 * Interface for tenant configuration service. All methods are async —
 * the Postgres impl caches per-tenant for 1 minute to keep email/reminder
 * hot paths off the DB.
 */
export interface TenantConfigService {
  getTenantConfig(tenantId: string | number): Promise<TenantConfig | null>;
  getTenantConfigs(): Promise<TenantConfig[]>;
  updateTenantConfig(
    tenantId: string | number,
    config: Partial<TenantConfig>
  ): Promise<TenantConfig | null>;
  getBusinessName(tenantId: string | number): Promise<string>;
  getNotificationPreferences(tenantId: string | number): Promise<NotificationPreferences>;
}

/**
 * In-memory tenant configuration service implementation.
 * Used for testing and as a fallback.
 */
export class InMemoryTenantConfigService implements TenantConfigService {
  private configs: Map<string, TenantConfig> = new Map();

  constructor(initialConfigs?: TenantConfig[]) {
    if (initialConfigs) {
      for (const config of initialConfigs) {
        this.configs.set(String(config.tenantId), config);
      }
    }
  }

  getTenantConfig(tenantId: string | number): Promise<TenantConfig | null> {
    return Promise.resolve(this.configs.get(String(tenantId)) || null);
  }

  getTenantConfigs(): Promise<TenantConfig[]> {
    return Promise.resolve(Array.from(this.configs.values()));
  }

  updateTenantConfig(
    tenantId: string | number,
    updates: Partial<TenantConfig>
  ): Promise<TenantConfig | null> {
    const existing = this.configs.get(String(tenantId));
    if (!existing) {
      return Promise.resolve(null);
    }
    const updated = { ...existing, ...updates };
    this.configs.set(String(tenantId), updated);
    return Promise.resolve(updated);
  }

  /**
   * Add a tenant configuration
   */
  addTenantConfig(config: TenantConfig): void {
    this.configs.set(String(config.tenantId), config);
  }

  /**
   * Remove a tenant configuration
   */
  removeTenantConfig(tenantId: string | number): boolean {
    return this.configs.delete(String(tenantId));
  }

  async getBusinessName(tenantId: string | number): Promise<string> {
    const config = await this.getTenantConfig(tenantId);
    return config?.name || 'Business';
  }

  async getNotificationPreferences(tenantId: string | number): Promise<NotificationPreferences> {
    const config = await this.getTenantConfig(tenantId);
    return {
      smsEnabled: config?.settings?.smsEnabled ?? true,
      emailEnabled: config?.settings?.emailEnabled ?? true,
      reminderHours: config?.settings?.reminderHours ?? [72, 24, 2],
      contactInfo: {
        phone: config?.phone,
      },
    };
  }
}

/**
 * Database-backed tenant configuration service.
 * Reads tenant config from the tenants table. Per-tenant TTL cache keeps
 * email/reminder hot paths off the DB; cache invalidates on write or
 * after 1 minute, whichever comes first.
 */
export class PostgresTenantConfigService implements TenantConfigService {
  private pool: Pool;
  private cache: Map<string, TenantConfig> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly cacheTTL = 60000; // 1 minute cache

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private isCacheValid(tenantId: string): boolean {
    const expiry = this.cacheExpiry.get(tenantId);
    return expiry !== undefined && Date.now() < expiry;
  }

  private rowToConfig(row: {
    tenant_id: string;
    name: string;
    owner_phone: string | null;
    inbound_phone: string | null;
    timezone: string | null;
    sms_enabled: boolean;
    email_enabled: boolean;
    logo_url?: string | null;
  }): TenantConfig {
    return {
      tenantId: row.tenant_id,
      name: row.name,
      phone: row.owner_phone ?? undefined,
      inboundPhone: row.inbound_phone ?? undefined,
      timezone: row.timezone || 'America/Chicago',
      logoUrl: row.logo_url ?? undefined,
      settings: {
        smsEnabled: row.sms_enabled !== false,
        emailEnabled: row.email_enabled !== false,
        reminderHours: [72, 24, 2],
        defaultProvider: 'telnyx',
      },
    };
  }

  async getTenantConfig(tenantId: string | number): Promise<TenantConfig | null> {
    const key = String(tenantId);
    if (this.isCacheValid(key)) {
      return this.cache.get(key) || null;
    }

    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT tenant_id, name, owner_phone, inbound_phone, timezone, sms_enabled, email_enabled, logo_url
         FROM tenants WHERE tenant_id = $1`,
        [tenantId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const config = this.rowToConfig(result.rows[0]);
      this.cache.set(key, config);
      this.cacheExpiry.set(key, Date.now() + this.cacheTTL);
      return config;
    });
  }

  async getTenantConfigs(): Promise<TenantConfig[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT tenant_id, name, owner_phone, inbound_phone, timezone, sms_enabled, email_enabled, logo_url
         FROM tenants ORDER BY name`
      );

      const configs = result.rows.map((row) => this.rowToConfig(row));
      for (const config of configs) {
        const key = String(config.tenantId);
        this.cache.set(key, config);
        this.cacheExpiry.set(key, Date.now() + this.cacheTTL);
      }
      return configs;
    });
  }

  async updateTenantConfig(
    tenantId: string | number,
    updates: Partial<TenantConfig>
  ): Promise<TenantConfig | null> {
    return this.withClient(async (client) => {
      const fields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        fields.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.phone !== undefined) {
        fields.push(`owner_phone = $${paramIndex++}`);
        values.push(updates.phone);
      }
      if (updates.inboundPhone !== undefined) {
        fields.push(`inbound_phone = $${paramIndex++}`);
        values.push(updates.inboundPhone);
      }
      if (updates.timezone !== undefined) {
        fields.push(`timezone = $${paramIndex++}`);
        values.push(updates.timezone);
      }
      if (updates.logoUrl !== undefined) {
        fields.push(`logo_url = $${paramIndex++}`);
        values.push(updates.logoUrl || null);
      }

      if (fields.length === 0) {
        return this.getTenantConfig(tenantId);
      }

      values.push(tenantId);
      const result = await client.query(
        `UPDATE tenants SET ${fields.join(', ')}
         WHERE tenant_id = $${paramIndex}
         RETURNING tenant_id, name, owner_phone, inbound_phone, timezone, sms_enabled, email_enabled, logo_url`,
        values
      );

      if (result.rows.length === 0) {
        return null;
      }

      const config = this.rowToConfig(result.rows[0]);
      const key = String(tenantId);
      this.cache.set(key, config);
      this.cacheExpiry.set(key, Date.now() + this.cacheTTL);
      return config;
    });
  }

  /**
   * Clear the cache (for testing)
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  async getBusinessName(tenantId: string | number): Promise<string> {
    const config = await this.getTenantConfig(tenantId);
    return config?.name || 'Business';
  }

  async getNotificationPreferences(tenantId: string | number): Promise<NotificationPreferences> {
    const config = await this.getTenantConfig(tenantId);
    return {
      smsEnabled: config?.settings?.smsEnabled ?? true,
      emailEnabled: config?.settings?.emailEnabled ?? true,
      reminderHours: config?.settings?.reminderHours ?? [72, 24, 2],
      contactInfo: {
        phone: config?.phone,
      },
    };
  }
}

// Export default instances
export const tenantConfigService = new InMemoryTenantConfigService([
  {
    tenantId: '1',
    name: 'Demo Tenant',
    timezone: 'America/New_York',
    settings: {
      smsEnabled: true,
      emailEnabled: true,
      reminderHours: [72, 24, 2],
    },
  },
]);

// Factory function for creating DB-backed service
export function createTenantConfigService(pool?: Pool): PostgresTenantConfigService {
  return new PostgresTenantConfigService(pool);
}
