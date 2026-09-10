import { describe, expect, it } from 'vitest';
import {
  buildChecklistPrompt,
  ChecklistAgent,
  resolveChecklistLibrary,
  resolveSelectableTreeIds,
} from './checklistAgent.js';
import { AUTO_SHOP_PRESET, LOCAL_SERVICE_PRESET, SALON_PRESET } from './presets.js';
import { materializeRuntimeConfig } from './runtimeConfig.js';
import {
  BOOKING_TREE,
  IDENTITY_TREE,
  JOB_TREE,
  MESSAGE_TREE,
  PLATFORM_TREE_LIBRARY,
} from './trees.js';

describe('resolveChecklistLibrary', () => {
  it('keeps the full live library available for tracker invariants', () => {
    const library = resolveChecklistLibrary({
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity', 'job', 'booking', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });

    expect(library).toEqual(PLATFORM_TREE_LIBRARY);
  });

  it('compiles tenant runtime config into selectable live-tree ids', () => {
    const ids = resolveSelectableTreeIds({
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity', 'job', 'booking', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });

    expect(ids).toEqual(
      [IDENTITY_TREE, JOB_TREE, BOOKING_TREE, MESSAGE_TREE].map((tree) => tree.tree_id)
    );
  });

  /**
   * REPLACES a test that asserted passing both library and runtimeConfig THREW.
   *
   * That refusal was correct while `library` was a test-only override and
   * runtimeConfig was the production path — passing both meant confusion about
   * which governed. Per-tenant question trees (2026-08-14) make the pair the
   * normal production case: the tenant's DB-copied trees are the library, and
   * their overrides still ride on top. The two answer different questions, so
   * the combination now has a defined precedence instead of an exception.
   */
  it('uses the supplied library as the base and still applies runtimeConfig overrides', () => {
    const library = resolveChecklistLibrary({
      library: [IDENTITY_TREE],
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: { optional_node_ids: ['caller_phone'] },
        version: 1,
      },
    });

    expect(library.map((tree) => tree.tree_id)).toEqual(['identity']);
    const phone = library[0].nodes.find((n) => n.node_id === 'caller_phone');
    expect(phone?.type).toBe('text');
    // The override still landed: optional_node_ids makes it listen-only.
    expect(phone && 'listen' in phone ? phone.listen : undefined).toBe(true);
  });

  /**
   * The tenant's own trees are the CEILING, but an override must keep its power
   * to subtract — otherwise moving a tenant's questions into the database would
   * silently switch back on a block they had turned off.
   */
  it('intersects the library with the runtime config, so a disabled block stays disabled', () => {
    const ids = resolveSelectableTreeIds({
      library: [IDENTITY_TREE, JOB_TREE],
      runtimeConfig: {
        preset_id: 'job_default',
        // The tenant disabled `job`; only identity remains enabled.
        enabled_conversation_blocks: ['identity'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });

    expect(ids).toEqual(['identity']);
  });
});

describe('ChecklistAgent runtimeConfig path', () => {
  const runtime = {
    currentDate: 'Tuesday, August 11, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: 'Friday, August 28, 2026',
  };

  it('uses the compiled library in both the prompt menu and set_purpose path', async () => {
    const library = resolveChecklistLibrary({
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity', 'job', 'booking', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });
    const selectableTreeIds = resolveSelectableTreeIds({
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity', 'job', 'booking', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });

    const prompt = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library,
      selectableTreeIds,
    });

    expect(prompt).toContain('- identity:');
    expect(prompt).toContain('- job:');
    expect(prompt).toContain('- booking:');
    expect(prompt).toContain('- message:');
    expect(prompt).not.toContain('- qa:');
    expect(prompt).not.toContain('- buy_service:');

    const agent = new ChecklistAgent({
      tools: {},
      persona: 'You are Piper.',
      runtime,
      runtimeConfig: {
        preset_id: 'job_default',
        enabled_conversation_blocks: ['identity', 'job', 'booking', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
    });

    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );

    const ok = await exec('set_purpose', {
      work_direction: 'caller_offers_owner_work',
      trees: ['identity', 'job'],
    });
    expect(String(ok)).toContain('Purpose set: identity + job');

    const refused = await exec('set_purpose', {
      work_direction: 'neither_or_unclear',
      trees: ['qa'],
    });
    expect(String(refused)).toContain('The "qa" intake is not enabled');
  });

  it('auto shop preset keeps booking/message/qa/schedule-change available but blocks buy_service and job', async () => {
    const runtimeConfig = materializeRuntimeConfig(AUTO_SHOP_PRESET);
    const library = resolveChecklistLibrary({ runtimeConfig });
    const selectableTreeIds = resolveSelectableTreeIds({ runtimeConfig });
    const prompt = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library,
      selectableTreeIds,
    });

    expect(prompt).toContain('- booking:');
    expect(prompt).toContain('- message:');
    expect(prompt).toContain('- qa:');
    expect(prompt).toContain('- schedule_change:');
    expect(prompt).not.toContain('- buy_service:');
    expect(prompt).not.toContain('- job:');

    const agent = new ChecklistAgent({
      tools: {},
      persona: 'You are Piper.',
      runtime,
      runtimeConfig,
    });
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );

    const ok = await exec('set_purpose', {
      work_direction: 'caller_wants_something_from_business',
      trees: ['identity', 'booking'],
    });
    expect(String(ok)).toContain('Purpose set: identity + booking');

    const refused = await exec('set_purpose', {
      work_direction: 'caller_pays_us',
      trees: ['buy_service'],
    });
    expect(String(refused)).toContain('The "buy_service" intake is not enabled');
  });

  it('salon preset keeps booking/message/qa/schedule-change available but blocks buy_service and job', async () => {
    const runtimeConfig = materializeRuntimeConfig(SALON_PRESET);
    const library = resolveChecklistLibrary({ runtimeConfig });
    const selectableTreeIds = resolveSelectableTreeIds({ runtimeConfig });
    const prompt = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library,
      selectableTreeIds,
    });

    expect(prompt).toContain('- booking:');
    expect(prompt).toContain('- message:');
    expect(prompt).toContain('- qa:');
    expect(prompt).toContain('- schedule_change:');
    expect(prompt).not.toContain('- buy_service:');
    expect(prompt).not.toContain('- job:');

    const agent = new ChecklistAgent({
      tools: {},
      persona: 'You are Piper.',
      runtime,
      runtimeConfig,
    });
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );

    const ok = await exec('set_purpose', {
      work_direction: 'caller_wants_something_from_business',
      trees: ['identity', 'booking'],
    });
    expect(String(ok)).toContain('Purpose set: identity + booking');

    const refused = await exec('set_purpose', {
      work_direction: 'caller_pays_us',
      trees: ['buy_service'],
    });
    expect(String(refused)).toContain('The "buy_service" intake is not enabled');
  });

  it('local service preset exposes buy_service and generic_subject while still blocking job', async () => {
    const runtimeConfig = materializeRuntimeConfig(LOCAL_SERVICE_PRESET);
    const library = resolveChecklistLibrary({ runtimeConfig });
    const selectableTreeIds = resolveSelectableTreeIds({ runtimeConfig });
    const prompt = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library,
      selectableTreeIds,
    });

    expect(prompt).toContain('- booking:');
    expect(prompt).toContain('- message:');
    expect(prompt).toContain('- generic_subject:');
    expect(prompt).toContain('- qa:');
    expect(prompt).toContain('- buy_service:');
    expect(prompt).toContain('- schedule_change:');
    expect(prompt).not.toContain('- job:');

    const agent = new ChecklistAgent({
      tools: {},
      persona: 'You are Piper.',
      runtime,
      runtimeConfig,
    });
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );

    const ok = await exec('set_purpose', {
      work_direction: 'caller_pays_us',
      trees: ['buy_service'],
    });
    expect(String(ok)).toContain('Purpose set: buy_service');

    const refused = await exec('set_purpose', {
      work_direction: 'caller_offers_owner_work',
      trees: ['job'],
    });
    expect(String(refused)).toContain('The "job" intake is not enabled');
  });

  it('writes booking/message policy into the live prompt', () => {
    const prompt = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      selectableTreeIds: ['identity', 'message'],
      runtimeConfig: {
        preset_id: 'salon_front_desk',
        enabled_conversation_blocks: ['identity', 'message'],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: { booking_mode: 'never', message_mode: 'fallback_only' },
        version: 1,
      },
    });
    expect(prompt).toContain('# Call policy');
    expect(prompt).toContain('Do NOT offer or book a time');
    expect(prompt).toContain('only when nothing else fits');
  });
});
