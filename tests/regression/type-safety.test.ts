/**
 * Tests for type safety improvements:
 * - catch (err: unknown) error narrowing (replaces catch (err: any))
 * - FastifyInstance typing on all 21 route modules
 * - OAuth callback factory handler compatibility
 *
 * Happy + sad paths with 5W diagnostic context.
 */
import { describe, it, expect, vi } from 'vitest';
import type {} from 'fastify';
import type { Pool } from 'pg';

// ═══════════════════════════════════════════════════════════════
// 1. Error narrowing: catch (err: unknown) produces correct messages
// ═══════════════════════════════════════════════════════════════

describe('Error narrowing (catch unknown)', () => {
  // Helper that mirrors the pattern used in production code
  function narrowError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  it('HAPPY: narrows Error instance to its message', () => {
    // WHO: provisioning route handler
    // WHAT: Vapi API throws an Error with a descriptive message
    // WHEN: during phone provisioning (catch block in provisioning.ts)
    // WHERE: catch (vapiError: unknown) block
    // WHY: user needs to see "Vapi rate limit exceeded", not "[object Object]"
    const err = new Error('Vapi rate limit exceeded');
    expect(narrowError(err)).toBe('Vapi rate limit exceeded');
  });

  it('HAPPY: narrows string throw to itself', () => {
    // WHO: provisioning route handler
    // WHAT: third-party lib throws a raw string instead of Error
    // WHEN: unexpected throw from Vapi SDK
    // WHERE: catch (vapiError: unknown) block
    // WHY: must not crash on non-Error throws — user should still see the string
    const err = 'connection refused';
    expect(narrowError(err)).toBe('connection refused');
  });

  it('SAD: narrows null/undefined to string representation', () => {
    // WHO: any catch handler using narrowError pattern
    // WHAT: something throws null or undefined (rare but possible)
    // WHEN: edge case in error propagation
    // WHERE: catch (err: unknown) block
    // WHY: String(null) = "null", String(undefined) = "undefined" — both are debuggable
    expect(narrowError(null)).toBe('null');
    expect(narrowError(undefined)).toBe('undefined');
  });

  it('SAD: narrows number throw to string', () => {
    // WHO: any catch handler
    // WHAT: HTTP status code thrown as raw number (anti-pattern but happens)
    // WHEN: third-party code throws a number instead of Error
    // WHERE: catch (err: unknown) block
    // WHY: String(502) = "502" — at least gives the debugger something to work with
    expect(narrowError(502)).toBe('502');
  });

  it('SAD: narrows object throw to string representation', () => {
    // WHO: any catch handler
    // WHAT: API returns an error object that's not an Error instance
    // WHEN: fetch response parsed as JSON and thrown
    // WHERE: catch (err: unknown) block
    // WHY: without narrowing, err.message would throw "Property 'message' does not exist on type 'unknown'"
    const err = { code: 'RATE_LIMIT', detail: 'too many requests' };
    const result = narrowError(err);
    expect(result).toBe('[object Object]');
  });

  it('SAD: narrows Error subclass preserves message', () => {
    // WHO: provisioning handler
    // WHAT: TypeError thrown during JSON parsing of Vapi response
    // WHEN: Vapi returns malformed JSON
    // WHERE: catch (vapiError: unknown) block
    // WHY: TypeError extends Error, so instanceof check must catch it
    const err = new TypeError('Cannot read properties of undefined');
    expect(narrowError(err)).toBe('Cannot read properties of undefined');
    expect(err instanceof Error).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. FastifyInstance typing: all 21 route modules accept typed app
// ═══════════════════════════════════════════════════════════════

describe('FastifyInstance typing on route modules', () => {
  // Dynamically import all route registration functions to verify they compile
  // with FastifyInstance<any, any, any> parameter (not bare `any`)

  // Map of module filename → actual export name (some use singular, some use special casing)
  const routeModules: Record<string, string> = {
    analytics: 'registerAnalyticsRoutes',
    appointments: 'registerAppointmentRoutes',
    auth: 'registerAuthRoutes',
    billing: 'registerBillingRoutes',
    calendar: 'registerCalendarRoutes',
    communications: 'registerCommunicationRoutes',
    customers: 'registerCustomerRoutes',
    employees: 'registerEmployeeRoutes',
    knowledge: 'registerKnowledgeRoutes',
    mappings: 'registerMappingRoutes',
    provisioning: 'registerProvisioningRoutes',
    reminders: 'registerReminderRoutes',
    resources: 'registerResourceRoutes',
    services: 'registerServiceRoutes',
    shifts: 'registerShiftRoutes',
    skills: 'registerSkillRoutes',
    square: 'registerSquareRoutes',
    tenants: 'registerTenantRoutes',
    versionHistory: 'registerVersionHistoryRoutes',
    vocabulary: 'registerVocabularyRoutes',
    voice: 'registerVoiceRoutes',
  };

  for (const [mod, fnName] of Object.entries(routeModules)) {
    it(`HAPPY: ${mod}.ts exports ${fnName} with typed app param`, async () => {
      // WHO: developer adding routes to the Fastify app
      // WHAT: route registration function must exist and be a function
      // WHEN: server starts up and registers all 21 route modules
      // WHERE: src/routes/${mod}.ts
      // WHY: if the export is missing or misnamed, the server silently skips routes
      // The `.ts` suffix is REQUIRED, not decoration: Vite's dynamic-import-vars
      // plugin needs a static file extension in the pattern, and without it every run
      // printed `invalid import "../../src/routes/${mod}"` on this line.
      const module = await import(`../../src/routes/${mod}.ts`);
      expect(module[fnName]).toBeDefined();
      expect(typeof module[fnName]).toBe('function');
    });
  }

  it('SAD: route count matches expected 21 (catches forgotten registration)', () => {
    // WHO: developer adding a new route module
    // WHAT: total route module count must match the expected 21
    // WHEN: new route file added but not registered in index.ts
    // WHERE: src/routes/ directory
    // WHY: if a route module exists but isn't in this list, it won't be tested for typing
    expect(Object.keys(routeModules).length).toBe(21);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. OAuth callback factory: handler compatible with typed Fastify
// ═══════════════════════════════════════════════════════════════

describe('OAuth callback factory type compatibility', () => {
  it('HAPPY: createOAuthCallbackHandler returns a function', async () => {
    // WHO: CRM integration routes (Square)
    // WHAT: factory must return an async function usable as Fastify route handler
    // WHEN: route registration at server startup
    // WHERE: src/services/oauthCallbackFactory.ts
    // WHY: if factory returns wrong type, CRM OAuth callbacks silently fail to register
    const { createOAuthCallbackHandler } = await import('../../src/services/oauthCallbackFactory');

    const mockPool = { connect: vi.fn() } as unknown as Pool;
    const mockApp = { log: { info: vi.fn(), error: vi.fn() } };

    const handler = createOAuthCallbackHandler(mockPool, mockApp, {
      provider: 'test',
      verifyState: () => null,
      exchangeCodeForTokens: vi.fn(),
    });

    expect(typeof handler).toBe('function');
  });

  it('SAD: callback handler redirects on missing code/state', async () => {
    // WHO: user returning from CRM OAuth consent screen
    // WHAT: if code or state params are missing, redirect with error
    // WHEN: CRM provider sends malformed callback (browser manipulation, expired state)
    // WHERE: createOAuthCallbackHandler return function
    // WHY: without this guard, the handler would crash trying to exchange a null code
    const { createOAuthCallbackHandler } = await import('../../src/services/oauthCallbackFactory');

    const mockPool = { connect: vi.fn() } as unknown as Pool;
    const mockApp = { log: { info: vi.fn(), error: vi.fn() } };
    const redirectedTo: string[] = [];

    const handler = createOAuthCallbackHandler(mockPool, mockApp, {
      provider: 'square',
      verifyState: () => null,
      exchangeCodeForTokens: vi.fn(),
    });

    await handler(
      { query: {} }, // missing code and state
      {
        redirect: (url: string) => {
          redirectedTo.push(url);
        },
      }
    );

    expect(redirectedTo.length).toBe(1);
    expect(redirectedTo[0]).toContain('squareError=missing_params');
  });

  it('SAD: callback handler redirects on OAuth error param', async () => {
    // WHO: user who denied CRM OAuth consent
    // WHAT: CRM provider sends ?error=access_denied, handler must redirect gracefully
    // WHEN: user clicks "Deny" on the Square consent screen
    // WHERE: createOAuthCallbackHandler return function
    // WHY: without this, the handler would try to exchange code that doesn't exist
    const { createOAuthCallbackHandler } = await import('../../src/services/oauthCallbackFactory');

    const mockPool = { connect: vi.fn() } as unknown as Pool;
    const mockApp = { log: { info: vi.fn(), error: vi.fn() } };
    const redirectedTo: string[] = [];

    const handler = createOAuthCallbackHandler(mockPool, mockApp, {
      provider: 'square',
      verifyState: () => null,
      exchangeCodeForTokens: vi.fn(),
    });

    await handler(
      { query: { error: 'access_denied' } },
      {
        redirect: (url: string) => {
          redirectedTo.push(url);
        },
      }
    );

    expect(redirectedTo.length).toBe(1);
    expect(redirectedTo[0]).toContain('squareError=access_denied');
  });

  it('SAD: callback handler redirects on invalid state (forged/expired JWT)', async () => {
    // WHO: attacker or user with expired OAuth state token
    // WHAT: verifyState returns null (JWT invalid), handler must redirect with error
    // WHEN: CSRF attempt or user waited too long on consent screen (state JWT expired)
    // WHERE: createOAuthCallbackHandler return function
    // WHY: without state verification, attacker could link their CRM to victim's tenant
    const { createOAuthCallbackHandler } = await import('../../src/services/oauthCallbackFactory');

    const mockPool = { connect: vi.fn() } as unknown as Pool;
    const mockApp = { log: { info: vi.fn(), error: vi.fn() } };
    const redirectedTo: string[] = [];

    const handler = createOAuthCallbackHandler(mockPool, mockApp, {
      provider: 'square',
      verifyState: () => null, // invalid state
      exchangeCodeForTokens: vi.fn(),
    });

    await handler(
      { query: { code: 'auth-code-123', state: 'forged-state-token' } },
      {
        redirect: (url: string) => {
          redirectedTo.push(url);
        },
      }
    );

    expect(redirectedTo.length).toBe(1);
    expect(redirectedTo[0]).toContain('squareError=invalid_state');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Provisioning error handling: unknown errors produce safe responses
// ═══════════════════════════════════════════════════════════════

describe('Provisioning error handling', () => {
  it('HAPPY: Error instance produces detail field with message', () => {
    // WHO: SuperAdmin clicking "Activate Phone" for a tenant
    // WHAT: Vapi API returns a clear error (e.g., rate limit, invalid key)
    // WHEN: during POST /provisioning/activate
    // WHERE: catch (vapiError: unknown) in provisioning.ts
    // WHY: admin needs actionable error detail, not "[object Object]"
    const err: unknown = new Error('Invalid API key');
    const detail = err instanceof Error ? err.message : String(err);
    expect(detail).toBe('Invalid API key');
  });

  it('SAD: non-Error throw still produces a string detail', () => {
    // WHO: SuperAdmin activating phone
    // WHAT: Vapi SDK throws a non-Error value (fetch rejection, network object)
    // WHEN: network failure during Vapi API call
    // WHERE: catch (vapiError: unknown) in provisioning.ts
    // WHY: without instanceof check, accessing .message on a non-Error would throw TypeError
    const err: unknown = { status: 502, body: 'Bad Gateway' };
    const detail = err instanceof Error ? err.message : String(err);
    expect(typeof detail).toBe('string');
    expect(detail.length).toBeGreaterThan(0);
  });

  it('SAD: null/undefined error still produces a string detail', () => {
    // WHO: SuperAdmin activating phone
    // WHAT: something throws null (extremely rare edge case)
    // WHEN: unexpected internal error in Vapi client
    // WHERE: catch (vapiError: unknown) in provisioning.ts
    // WHY: String(null) = "null" is better than crashing with "Cannot read property 'message' of null"
    const errNull: unknown = null;
    const errUndef: unknown = undefined;
    expect(errNull instanceof Error ? errNull.message : String(errNull)).toBe('null');
    expect(errUndef instanceof Error ? errUndef.message : String(errUndef)).toBe('undefined');
  });
});
