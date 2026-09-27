import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getRootClient,
  clearDB,
  setupBasicTenant,
  createTenant,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';

describe('Business Vocabulary System', () => {
  let client: Client;
  let tenantId: string;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      await clearDB(client);
      const setup = await setupBasicTenant(client);
      tenantId = setup.tenantId;
    } catch (err) {
      dbAvailable = false;
      console.warn('[vocabulary.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) {
      await client.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    await rollbackTestTransaction(client);
  });

  describe('business_templates vocabulary columns', () => {
    it('should have vocabulary columns on business_templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'business_templates'
                AND column_name IN ('resource_label', 'resource_plural', 'employee_label', 'employee_plural', 'booking_label', 'example_services')
                ORDER BY column_name
            `);
      expect(res.rows.map((r) => r.column_name)).toEqual([
        'booking_label',
        'employee_label',
        'employee_plural',
        'example_services',
        'resource_label',
        'resource_plural',
      ]);
    });

    it('should have vocabulary populated for mobile-tire template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM business_templates WHERE business_type = 'mobile-tire'"
      );
      expect(res.rows[0]).toEqual({
        resource_label: 'Truck',
        resource_plural: 'Trucks',
        employee_label: 'Technician',
        employee_plural: 'Technicians',
        booking_label: 'Appointment',
      });
    });

    it('should have vocabulary populated for salon template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM business_templates WHERE business_type = 'salon'"
      );
      expect(res.rows[0]).toEqual({
        resource_label: 'Chair',
        resource_plural: 'Chairs',
        employee_label: 'Stylist',
        employee_plural: 'Stylists',
        booking_label: 'Appointment',
      });
    });

    it('should have vocabulary populated for auto-shop template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM business_templates WHERE business_type = 'auto-shop'"
      );
      expect(res.rows[0]).toEqual({
        resource_label: 'Bay',
        resource_plural: 'Bays',
        employee_label: 'Mechanic',
        employee_plural: 'Mechanics',
        booking_label: 'Appointment',
      });
    });

    it('should have vocabulary populated for barbershop template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM business_templates WHERE business_type = 'barbershop'"
      );
      expect(res.rows[0]).toEqual({
        resource_label: 'Chair',
        resource_plural: 'Chairs',
        employee_label: 'Barber',
        employee_plural: 'Barbers',
        booking_label: 'Appointment',
      });
    });

    it('should have default fallback values for columns', async () => {
      if (!dbAvailable) return;
      // Insert a template with no vocabulary specified
      await client.query(`
                INSERT INTO business_templates (business_type, display_name, system_prompt_template, first_message, default_resource_name)
                VALUES ('test-type', 'Test', 'prompt', 'hello', 'Room 1')
                ON CONFLICT (business_type) DO UPDATE SET display_name = 'Test',
                    resource_label = DEFAULT, resource_plural = DEFAULT,
                    employee_label = DEFAULT, employee_plural = DEFAULT,
                    booking_label = DEFAULT
            `);
      const res = await client.query(
        "SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM business_templates WHERE business_type = 'test-type'"
      );
      expect(res.rows[0]).toEqual({
        resource_label: 'Resource',
        resource_plural: 'Resources',
        employee_label: 'Employee',
        employee_plural: 'Employees',
        booking_label: 'Appointment',
      });
    });
  });

  describe('all business type templates', () => {
    const EXPECTED_TYPES = [
      'mobile-tire',
      'salon',
      'auto-shop',
      'barbershop',
      'nail-salon',
      'car-detailing',
      'body-shop',
      'oil-change',
      'car-wash',
      'lash-studio',
      'garage-door',
      'locksmith',
      'real-estate',
      'insurance',
      'bakery',
      'catering',
      'spa',
      'plumber',
      'electrician',
      'hvac',
      'pest-control',
      'cleaning',
      'landscaping',
      'personal-trainer',
      'yoga-studio',
      'tax-prep',
      'tutoring',
      'photography',
    ];

    it('should have all expected business type templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT business_type FROM business_templates ORDER BY business_type'
      );
      const types = res.rows.map((r) => r.business_type);
      for (const t of EXPECTED_TYPES) {
        expect(types).toContain(t);
      }
      expect(types.length).toBeGreaterThanOrEqual(29);
    });

    it('should have non-empty vocabulary on all templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT business_type, resource_label, employee_label, booking_label FROM business_templates WHERE business_type = ANY($1)',
        [EXPECTED_TYPES]
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(17);
      for (const row of res.rows) {
        expect(row.resource_label).toBeTruthy();
        expect(row.employee_label).toBeTruthy();
        expect(row.booking_label).toBeTruthy();
      }
    });

    it('should have example_services populated on all 20 templates', async () => {
      // T-015 changed what this asserts, so the bound moved from 3 to 2.
      //
      // It used to demand >= 3, which encoded the old 5-item department menus
      // ("Oil Change, Brake Service, Engine Diagnostic, Tire Rotation, State
      // Inspection"). The starter catalogue is 2–4 caller-language rows per
      // vertical, so 2 is the floor.
      //
      // CORRECTION, recorded because the wrong version was committed first: this
      // comment previously said the floor was 1 and that "the work order's
      // product rule changed". That was false. The work order's rule always said
      // 2–4; its reference LIST said "consultation only" for med-spa and
      // law-firm, which is a conflict inside the work order — not permission to
      // ship one. Loosening this floor to 1 hid that conflict and left the
      // catalogue header, the roadmap, and this test disagreeing. Those two
      // verticals now carry a second defensible starter and the floor is 2.
      //
      // The assertion also got STRONGER, not weaker: it caps the list at 4,
      // asserts every expected template was actually found, and checks each entry
      // is an object with a non-empty name rather than counting entries of any
      // shape. That last part matters because the column changed from text[] to
      // jsonb, and a silent shape regression would sail through a length check.
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT business_type, example_services FROM business_templates WHERE business_type = ANY($1)',
        [EXPECTED_TYPES]
      );
      expect(res.rows.length).toBe(EXPECTED_TYPES.length);
      for (const row of res.rows) {
        const starters = row.example_services as Array<{ name?: string }>;
        expect(
          Array.isArray(starters),
          `${row.business_type} example_services is not an array`
        ).toBe(true);
        expect(
          starters.length,
          `${row.business_type} has ${starters.length} starter(s) — the rule is 2–4, and a blank ` +
            `or single-row Step 1 is what T-015 exists to prevent`
        ).toBeGreaterThanOrEqual(2);
        expect(
          starters.length,
          `${row.business_type} has ${starters.length} starters; 2–4 is the rule, more is a menu`
        ).toBeLessThanOrEqual(4);
        for (const starter of starters) {
          expect(
            typeof starter?.name === 'string' && starter.name.length > 0,
            `${row.business_type} has a starter with no name: ${JSON.stringify(starter)}`
          ).toBe(true);
        }
      }
    });

    it('should have a category assigned to every template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT business_type, category FROM business_templates WHERE category IS NULL OR category = ''"
      );
      expect(res.rows.length).toBe(0);
    });

    it('should have at least 5 categories', async () => {
      if (!dbAvailable) return;
      const res = await client.query('SELECT DISTINCT category FROM business_templates');
      expect(res.rows.length).toBeGreaterThanOrEqual(5);
    });

    it('should have system_prompt_template with business_name placeholder on all templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT business_type, system_prompt_template FROM business_templates WHERE business_type = ANY($1)',
        [EXPECTED_TYPES]
      );
      for (const row of res.rows) {
        expect(row.system_prompt_template).toContain('{{business_name}}');
      }
    });
  });

  describe('vocabulary resolution query', () => {
    it('should resolve vocabulary for a tenant with template but no overrides', async () => {
      if (!dbAvailable) return;
      // Create a salon tenant
      const salonId = await createTenant(client, 'Test Salon', 'salon');

      const res = await client.query(
        `
                SELECT
                    COALESCE(t.resource_label, bt.resource_label, 'Resource') AS resource_label,
                    COALESCE(t.resource_plural, bt.resource_plural, 'Resources') AS resource_plural,
                    COALESCE(t.employee_label, bt.employee_label, 'Employee') AS employee_label,
                    COALESCE(t.employee_plural, bt.employee_plural, 'Employees') AS employee_plural,
                    COALESCE(t.booking_label, bt.booking_label, 'Appointment') AS booking_label
                FROM tenants t
                LEFT JOIN business_templates bt ON bt.business_type = t.business_type
                WHERE t.tenant_id = $1
            `,
        [salonId]
      );

      expect(res.rows[0]).toEqual({
        resource_label: 'Chair',
        resource_plural: 'Chairs',
        employee_label: 'Stylist',
        employee_plural: 'Stylists',
        booking_label: 'Appointment',
      });
    });
  });

  describe('tenants vocabulary override columns', () => {
    it('should have vocabulary override columns on tenants', async () => {
      if (!dbAvailable) return;
      const res = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'tenants'
                AND column_name IN ('resource_label', 'resource_plural', 'employee_label', 'employee_plural', 'booking_label')
                ORDER BY column_name
            `);
      expect(res.rows.map((r) => r.column_name)).toEqual([
        'booking_label',
        'employee_label',
        'employee_plural',
        'resource_label',
        'resource_plural',
      ]);
    });

    it('should default tenant vocabulary overrides to NULL', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT resource_label, resource_plural, employee_label, employee_plural, booking_label FROM tenants WHERE tenant_id = $1',
        [tenantId]
      );
      expect(res.rows[0].resource_label).toBeNull();
      expect(res.rows[0].resource_plural).toBeNull();
      expect(res.rows[0].employee_label).toBeNull();
      expect(res.rows[0].employee_plural).toBeNull();
      expect(res.rows[0].booking_label).toBeNull();
    });

    it('should allow tenant to override vocabulary', async () => {
      if (!dbAvailable) return;
      await client.query(
        "UPDATE tenants SET resource_label = 'Stall', resource_plural = 'Stalls' WHERE tenant_id = $1",
        [tenantId]
      );
      const res = await client.query(
        'SELECT resource_label, resource_plural FROM tenants WHERE tenant_id = $1',
        [tenantId]
      );
      expect(res.rows[0].resource_label).toBe('Stall');
      expect(res.rows[0].resource_plural).toBe('Stalls');
    });

    it('should resolve vocabulary with 3-tier fallback (tenant > template > hardcoded)', async () => {
      if (!dbAvailable) return;

      // Create a tenant with business_type = 'auto-shop' and partial override
      const shopId = await createTenant(client, 'Test Shop', 'auto-shop');
      await client.query(
        "UPDATE tenants SET resource_label = 'Stall', resource_plural = 'Stalls' WHERE tenant_id = $1",
        [shopId]
      );

      // 3-tier COALESCE query
      const res = await client.query(
        `
                SELECT
                    COALESCE(t.resource_label, bt.resource_label, 'Resource') AS resource_label,
                    COALESCE(t.resource_plural, bt.resource_plural, 'Resources') AS resource_plural,
                    COALESCE(t.employee_label, bt.employee_label, 'Employee') AS employee_label,
                    COALESCE(t.employee_plural, bt.employee_plural, 'Employees') AS employee_plural,
                    COALESCE(t.booking_label, bt.booking_label, 'Appointment') AS booking_label
                FROM tenants t
                LEFT JOIN business_templates bt ON bt.business_type = t.business_type
                WHERE t.tenant_id = $1
            `,
        [shopId]
      );

      // resource_label/plural come from tenant override (Stall/Stalls)
      expect(res.rows[0].resource_label).toBe('Stall');
      expect(res.rows[0].resource_plural).toBe('Stalls');
      // employee_label/plural fall through to template default (Mechanic/Mechanics)
      expect(res.rows[0].employee_label).toBe('Mechanic');
      expect(res.rows[0].employee_plural).toBe('Mechanics');
      // booking_label falls through to template default (Appointment)
      expect(res.rows[0].booking_label).toBe('Appointment');
    });

    it('should fall back to hardcoded when no template exists', async () => {
      if (!dbAvailable) return;

      // Tenant with unknown business_type (no matching template)
      const bizId = await createTenant(client, 'Mystery Biz', 'unknown-type');

      const res = await client.query(
        `
                SELECT
                    COALESCE(t.resource_label, bt.resource_label, 'Resource') AS resource_label,
                    COALESCE(t.resource_plural, bt.resource_plural, 'Resources') AS resource_plural,
                    COALESCE(t.employee_label, bt.employee_label, 'Employee') AS employee_label,
                    COALESCE(t.employee_plural, bt.employee_plural, 'Employees') AS employee_plural,
                    COALESCE(t.booking_label, bt.booking_label, 'Appointment') AS booking_label
                FROM tenants t
                LEFT JOIN business_templates bt ON bt.business_type = t.business_type
                WHERE t.tenant_id = $1
            `,
        [bizId]
      );

      expect(res.rows[0].resource_label).toBe('Resource');
      expect(res.rows[0].resource_plural).toBe('Resources');
      expect(res.rows[0].employee_label).toBe('Employee');
      expect(res.rows[0].employee_plural).toBe('Employees');
      expect(res.rows[0].booking_label).toBe('Appointment');
    });
  });

  // ── Template Categories (moved from coverage-gaps.test.ts) ────────

  describe('Template Categories', () => {
    it('should have a non-empty category on all templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT business_type, category FROM business_templates WHERE category IS NULL OR category = ''"
      );
      expect(res.rows.length).toBe(0);
    });

    it('should have at least 5 distinct categories', async () => {
      if (!dbAvailable) return;
      const res = await client.query('SELECT DISTINCT category FROM business_templates');
      expect(res.rows.length).toBeGreaterThanOrEqual(5);
    });

    it('should include Auto & Vehicle, Beauty & Personal Care, and Home Services categories', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT DISTINCT category FROM business_templates ORDER BY category'
      );
      const categories = res.rows.map((r: { category: string }) => r.category);
      expect(categories).toContain('Auto & Vehicle');
      expect(categories).toContain('Beauty & Personal Care');
      expect(categories).toContain('Home Services');
    });

    it('should have sort_order set (not null) for all templates', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        'SELECT business_type, sort_order FROM business_templates WHERE sort_order IS NULL'
      );
      expect(res.rows.length).toBe(0);
    });
  });

  // ── HIPAA Template Exclusion (moved from coverage-gaps.test.ts) ───

  describe('HIPAA Template Exclusion', () => {
    it('should NOT have a dentist template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT business_type FROM business_templates WHERE business_type = 'dentist'"
      );
      expect(res.rows.length).toBe(0);
    });

    it('should NOT have a chiropractor template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT business_type FROM business_templates WHERE business_type = 'chiropractor'"
      );
      expect(res.rows.length).toBe(0);
    });

    it('should NOT have a vet-clinic template', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        "SELECT business_type FROM business_templates WHERE business_type = 'vet-clinic'"
      );
      expect(res.rows.length).toBe(0);
    });
  });
});
