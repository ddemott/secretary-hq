/**
 * Caller preferences — remember_preference and the call's memory
 * (owner decision 2026-09-25).
 *
 * WHO: a caller who mentions a lasting preference ("I always see Maria").
 * WHAT: the model calls remember_preference with a key from this business's
 *       catalog; the HOST holds it and writes it to the caller's profile once
 *       there is a profile this caller owns — immediately for a recognized
 *       returning caller, after identify_caller for a new one, after
 *       verify_phone_code for a proven spoken number — and never into a
 *       profile the caller only CLAIMED.
 * WHY: preferences are said whenever the caller thinks of them, usually before
 *      we know who they are; a prompt asking the model to "save it later" is a
 *      request, host code holding it is a guarantee.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createChecklistTools,
  PREFERENCE_FLUSH_MAX_MS,
  type ChecklistToolDeps,
} from './checklistTools.js';
import { ChecklistTracker } from './tracker.js';
import { PLATFORM_TREE_LIBRARY } from './trees.js';
import type { ToolMap } from '../tools.js';
import type { PreferenceTypeConfig } from '../tenantConfig.js';

type Exec = (args: unknown, ctx: unknown) => Promise<unknown>;
const call = async (tools: ToolMap, name: string, args: unknown = {}): Promise<string> =>
  (await (tools[name] as unknown as { execute: Exec }).execute(args, undefined)) as string;

const fakeTool = (result: string) => ({
  description: 'fake',
  parameters: { type: 'object', properties: {} },
  execute: vi.fn(async (_args?: unknown, _ctx?: unknown) => result),
});
const ok = (fields: Record<string, unknown>): string =>
  JSON.stringify({ success: true, ...fields });

const SALON_CATALOG: PreferenceTypeConfig[] = [
  { key: 'usual_service', label: 'Usual service', hint: 'Cut, color, balayage.' },
  { key: 'preferred_staff', label: 'Preferred staff member', hint: 'A person they want.' },
  { key: 'preferred_time_of_day', label: 'Preferred time of day', hint: 'Mornings, evenings.' },
  { key: 'notes', label: 'Other notes', hint: 'Anything else lasting.' },
];

function makeKit(
  overrides: Partial<ChecklistToolDeps> = {},
  identifyResult = ok({ saved: true, returning_customer: false })
) {
  const fakes = {
    take_message: fakeTool(ok({ message_id: 'msg_1' })),
    identify_caller: fakeTool(identifyResult),
    get_company_policy_answer: fakeTool(ok({ answer: 'x' })),
    get_customer_context: fakeTool(ok({ name: 'Camille', preferences: {}, history: '' })),
    send_verification_code: fakeTool(ok({ sent: true })),
    verify_phone_code: fakeTool(ok({ verified: true, phone: '+15557654321' })),
    save_customer_preference: fakeTool(ok({ saved: true })),
  };
  const tracker = new ChecklistTracker(PLATFORM_TREE_LIBRARY);
  const closeCall = vi.fn(async () => {});
  const toolkit = createChecklistTools({
    tracker,
    library: PLATFORM_TREE_LIBRARY,
    realTools: fakes as unknown as ToolMap,
    onSelectionChanged: vi.fn(),
    closeCall,
    preferenceCatalog: SALON_CATALOG,
    ...overrides,
  });
  return { toolkit, tracker, fakes, closeCall };
}

const savedCalls = (fakes: ReturnType<typeof makeKit>['fakes']) =>
  fakes.save_customer_preference.execute.mock.calls.map((c) => c[0] as Record<string, string>);

describe('remember_preference — offered on every call, keys from the business catalog', () => {
  it('HAPPY: present before any purpose is set, with the catalog keys as its only choices', () => {
    const { toolkit } = makeKit();
    const tool = toolkit.selectedTools()['remember_preference'] as unknown as {
      description: string;
      parameters: { properties: { key: { enum: string[] } } };
    };
    expect(tool).toBeDefined();
    expect(tool.parameters.properties.key.enum).toEqual([
      'usual_service',
      'preferred_staff',
      'preferred_time_of_day',
      'notes',
    ]);
    // Each key's hint is in the description, so the model knows what to listen for.
    expect(tool.description).toContain('- usual_service: Cut, color, balayage.');
    expect(tool.description).toMatch(/do NOT tell the caller/i);
  });

  it('HAPPY: the owner guidance from the AI Persona page is included', () => {
    const { toolkit } = makeKit({ preferencesInstructions: 'Always note their color formula.' });
    const tool = toolkit.selectedTools()['remember_preference'] as unknown as {
      description: string;
    };
    expect(tool.description).toContain('The business says: Always note their color formula.');
  });

  it('SAD: not offered when the owner switched preferences off', () => {
    const { toolkit } = makeKit({ savePreferencesEnabled: false });
    expect(toolkit.selectedTools()['remember_preference']).toBeUndefined();
  });

  it('SAD: not offered without a catalog (older backend) — no fallback to invented keys', () => {
    const { toolkit } = makeKit({ preferenceCatalog: [] });
    expect(toolkit.selectedTools()['remember_preference']).toBeUndefined();
  });

  it('SAD: a key outside the catalog or an empty value is refused and never saved', async () => {
    const { toolkit, fakes } = makeKit({
      knownCallerName: 'Camille',
      callerPhone: '+15551234567',
    });
    const r1 = await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'favorite_color',
      value: 'blue',
    });
    const r2 = await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: '   ',
    });
    expect(r1).toMatch(/Not remembered/);
    expect(r2).toMatch(/Not remembered/);
    expect(fakes.save_customer_preference.execute).not.toHaveBeenCalled();
  });
});

describe('when the preference is written to the profile', () => {
  it('HAPPY: a returning caller recognized by caller-ID — saved immediately', async () => {
    const { toolkit, fakes } = makeKit({
      knownCallerName: 'Camille',
      callerPhone: '+15551234567',
    });

    const res = await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });

    expect(res).toMatch(/Do not mention it/);
    await vi.waitFor(() =>
      expect(savedCalls(fakes)).toEqual([
        { phone: '+15551234567', key: 'preferred_staff', value: 'Maria' },
      ])
    );
  });

  it('HAPPY: a new caller — held in the call’s memory, then saved the moment their profile is created', async () => {
    const { toolkit, fakes } = makeKit({ callerPhone: '+15550001111' });

    // Mentioned before we know who they are.
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_time_of_day',
      value: 'mornings',
    });
    expect(fakes.save_customer_preference.execute).not.toHaveBeenCalled();

    // Name + number arrive → host-code identify_caller creates the profile.
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    await call(toolkit.selectedTools(), 'record_answer', { node_id: 'caller_name', value: 'Sue' });

    await vi.waitFor(() =>
      expect(savedCalls(fakes)).toEqual([
        { phone: '+15550001111', key: 'preferred_time_of_day', value: 'mornings' },
      ])
    );
  });

  it('SECURITY: a CLAIMED number that belongs to an existing customer never receives the preference', async () => {
    // identify_caller answers requires_verification: the spoken number is a
    // real customer's, unproven. Writing this caller's preference there would
    // let anyone edit a stranger's profile by saying their number.
    const { toolkit, fakes } = makeKit(
      {},
      ok({ saved: true, returning_customer: false, requires_verification: true })
    );
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    await call(toolkit.selectedTools(), 'record_answer', { node_id: 'caller_name', value: 'Sue' });
    await call(toolkit.selectedTools(), 'record_answer', {
      node_id: 'caller_phone',
      value: '555 123 4567',
    });
    await vi.waitFor(() => expect(fakes.identify_caller.execute).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(fakes.save_customer_preference.execute).not.toHaveBeenCalled();
  });

  it('HAPPY: …but once the caller PROVES the number (verify_phone_code), it is saved to that profile', async () => {
    const { toolkit, fakes } = makeKit(
      {},
      ok({ saved: true, returning_customer: false, requires_verification: true })
    );
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'usual_service',
      value: 'balayage',
    });
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    expect(fakes.save_customer_preference.execute).not.toHaveBeenCalled();

    await call(toolkit.selectedTools(), 'verify_phone_code', {
      phone: '555 765 4321',
      code: '1234',
    });

    await vi.waitFor(() =>
      expect(savedCalls(fakes)).toEqual([
        { phone: '+15557654321', key: 'usual_service', value: 'balayage' },
      ])
    );
  });

  it('SECURITY: a NEW profile made from a SPOKEN number gets nothing until the number is proven by text', async () => {
    // Owner decision 2026-09-25: spoken numbers are validated by text code.
    // Forwarded/blocked line (no caller-ID); the number has no profile yet, so
    // identify_caller creates one — on the caller's word alone.
    const { toolkit, fakes } = makeKit({ callerPhone: null });
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    await call(toolkit.selectedTools(), 'record_answer', { node_id: 'caller_name', value: 'Sue' });
    await call(toolkit.selectedTools(), 'record_answer', {
      node_id: 'caller_phone',
      value: '555 765 4321',
    });
    await vi.waitFor(() => expect(fakes.identify_caller.execute).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes.save_customer_preference.execute).not.toHaveBeenCalled();

    // Proven by the texted code → now it is theirs.
    await call(toolkit.selectedTools(), 'verify_phone_code', {
      phone: '555 765 4321',
      code: '1234',
    });
    await vi.waitFor(() =>
      expect(savedCalls(fakes)).toEqual([
        { phone: '+15557654321', key: 'preferred_staff', value: 'Maria' },
      ])
    );
  });

  it('SECURITY: with caller-ID present, a DIFFERENT number the caller speaks is still only a claim', async () => {
    // Caller-ID says +15550001111; the caller says "put it under 555 222 3333".
    // The spoken number is unproven, so a preference mentioned AFTER it must not
    // be written to it (it may go to the caller-ID line, which the carrier vouches for).
    const { toolkit, fakes } = makeKit({ callerPhone: '+15550001111' });
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    await call(toolkit.selectedTools(), 'record_answer', { node_id: 'caller_name', value: 'Sue' });
    await call(toolkit.selectedTools(), 'record_answer', {
      node_id: 'caller_phone',
      value: '555 222 3333',
    });
    await vi.waitFor(() =>
      expect(
        fakes.identify_caller.execute.mock.calls.some((c) =>
          JSON.stringify(c[0]).includes('555 222 3333')
        )
      ).toBe(true)
    );
    await new Promise((r) => setTimeout(r, 20));

    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(
      savedCalls(fakes).filter((c) => c.phone.replace(/\D/g, '').endsWith('5552223333'))
    ).toEqual([]);
  });

  it('HAPPY: a correction replaces the earlier value (one entry per key)', async () => {
    const { toolkit, fakes } = makeKit({ callerPhone: '+15550001111' });
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_time_of_day',
      value: 'mornings',
    });
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_time_of_day',
      value: 'actually, afternoons',
    });
    await call(toolkit.selectedTools(), 'set_purpose', { trees: ['identity', 'message'] });
    await call(toolkit.selectedTools(), 'record_answer', { node_id: 'caller_name', value: 'Sue' });

    await vi.waitFor(() => expect(fakes.save_customer_preference.execute).toHaveBeenCalled());
    expect(savedCalls(fakes)).toEqual([
      { phone: '+15550001111', key: 'preferred_time_of_day', value: 'actually, afternoons' },
    ]);
  });

  it('REGRESSION: a correction made while the first save is in flight is not lost', async () => {
    // Found in risk review of this feature's first version: the flush deleted the key
    // unconditionally after a successful save, so "mornings" (in flight) was
    // stored and "actually, afternoons" (said meanwhile) vanished.
    const { toolkit, fakes } = makeKit({
      knownCallerName: 'Camille',
      callerPhone: '+15551234567',
    });
    let releaseFirst: (v: string) => void = () => {};
    fakes.save_customer_preference.execute
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValue(ok({ saved: true }));

    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_time_of_day',
      value: 'mornings',
    });
    await vi.waitFor(() => expect(fakes.save_customer_preference.execute).toHaveBeenCalledTimes(1));
    // Caller corrects themselves while "mornings" is still being saved.
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_time_of_day',
      value: 'actually, afternoons',
    });
    releaseFirst(ok({ saved: true }));

    await vi.waitFor(() =>
      expect(savedCalls(fakes).map((c) => c.value)).toEqual(['mornings', 'actually, afternoons'])
    );
  });

  it('SAD: a save that does not stick stays in the call’s memory and is retried on the next trigger', async () => {
    const { toolkit, fakes } = makeKit({
      knownCallerName: 'Camille',
      callerPhone: '+15551234567',
    });
    fakes.save_customer_preference.execute
      .mockResolvedValueOnce(ok({ saved: false, message: 'No existing customer' }))
      .mockResolvedValue(ok({ saved: true }));

    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });
    await vi.waitFor(() => expect(fakes.save_customer_preference.execute).toHaveBeenCalledTimes(1));

    // The next preference triggers a flush that retries the first one too.
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'usual_service',
      value: 'cut',
    });
    await vi.waitFor(() =>
      expect(savedCalls(fakes).map((c) => c.key)).toEqual([
        'preferred_staff',
        'preferred_staff',
        'usual_service',
      ])
    );
  });

  it('HAPPY: finish_call makes one last save attempt before the goodbye', async () => {
    const { toolkit, fakes, closeCall } = makeKit({
      knownCallerName: 'Camille',
      callerPhone: '+15551234567',
    });
    fakes.save_customer_preference.execute
      .mockResolvedValueOnce(ok({ saved: false }))
      .mockResolvedValue(ok({ saved: true }));
    await call(toolkit.selectedTools(), 'remember_preference', {
      key: 'preferred_staff',
      value: 'Maria',
    });
    await vi.waitFor(() => expect(fakes.save_customer_preference.execute).toHaveBeenCalledTimes(1));

    await call(toolkit.selectedTools(), 'finish_call', {});

    expect(fakes.save_customer_preference.execute).toHaveBeenCalledTimes(2);
    const lastSave = fakes.save_customer_preference.execute.mock.invocationCallOrder[1];
    expect(lastSave).toBeLessThan(closeCall.mock.invocationCallOrder[0]);
  });

  it('SAD: a slow save cannot hold the conversation or the goodbye', async () => {
    vi.useFakeTimers();
    try {
      const { toolkit, fakes, closeCall } = makeKit({
        knownCallerName: 'Camille',
        callerPhone: '+15551234567',
      });
      // The save hangs forever.
      fakes.save_customer_preference.execute.mockImplementation(() => new Promise(() => {}));

      // The tool answers at once — no dead air while the caller is talking.
      const res = await call(toolkit.selectedTools(), 'remember_preference', {
        key: 'notes',
        value: 'prefers text reminders',
      });
      expect(res).toMatch(/Do not mention it/);

      // And the goodbye still happens, after at most PREFERENCE_FLUSH_MAX_MS.
      const finishing = call(toolkit.selectedTools(), 'finish_call', {});
      await vi.advanceTimersByTimeAsync(PREFERENCE_FLUSH_MAX_MS + 50);
      await finishing;
      expect(closeCall).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
