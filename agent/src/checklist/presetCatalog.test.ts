import { describe, expect, it } from 'vitest';
import type { VerticalPresetDef } from './blockTypes.js';
import { compileRuntimeConfig } from './blockCompiler.js';
import { verticalPresetSchema } from './blockSchemas.js';
import {
  AUTO_SHOP_PRESET,
  LAW_FIRM_PRESET,
  LOCAL_SERVICE_PRESET,
  OWNER_FOR_HIRE_PRESET,
  PRESET_LIBRARY,
  SALON_PRESET,
  getPresetById,
} from './presets.js';
import { PLATFORM_TREE_LIBRARY } from './trees.js';
import { materializeRuntimeConfig } from './runtimeConfig.js';

describe('preset catalog', () => {
  // The five original presets, followed by the 28 vertical front-desk presets
  // added with the per-vertical intake trees (auto_shop and salon keep their
  // original slots — their intake block is wired in directly, not via the new
  // batch). The exact list is asserted so an accidental add/drop/reorder fails
  // here, and so this stays the single readable inventory of the catalog.
  it('contains the shipped vertical presets', () => {
    expect(PRESET_LIBRARY.map((preset) => preset.preset_id)).toEqual([
      'auto_shop_front_desk',
      'salon_front_desk',
      'local_service_front_desk',
      'owner_for_hire_front_desk',
      'law_firm_front_desk',
      'mobile_tire_front_desk',
      'car_detailing_front_desk',
      'body_shop_front_desk',
      'oil_change_front_desk',
      'car_wash_front_desk',
      'barbershop_front_desk',
      'nail_salon_front_desk',
      'spa_front_desk',
      'lash_studio_front_desk',
      'plumber_front_desk',
      'electrician_front_desk',
      'hvac_front_desk',
      'pest_control_front_desk',
      'cleaning_front_desk',
      'landscaping_front_desk',
      'garage_door_front_desk',
      'locksmith_front_desk',
      'personal_trainer_front_desk',
      'yoga_studio_front_desk',
      'tax_prep_front_desk',
      'tutoring_front_desk',
      'photography_front_desk',
      'real_estate_front_desk',
      'insurance_front_desk',
      'answering_service_front_desk',
      'bakery_front_desk',
      'catering_front_desk',
    ]);
  });

  // THE GUARD THAT WOULD HAVE CAUGHT 2026-08-13. `job` sat in forbidden_trees on
  // every preset while overrides could only SUBTRACT blocks, so the tree existed
  // in the library and no tenant on earth could select it. Two recruiter calls
  // produced zero job_inquiries rows and the failure was invisible until a
  // postmortem replayed the config by hand. A tree the product ships and no
  // preset can reach is dead code that still costs a live call — either a preset
  // offers it, or it is deliberately parked and named here.
  it('every platform tree is reachable from at least one preset', () => {
    const reachable = new Set(PRESET_LIBRARY.flatMap((preset) => preset.conversation_blocks));
    // Parked on purpose — no call has asked for it yet ("test it or delete it").
    // Moving a tree into this list is a decision someone must type.
    const deliberatelyUnreachable = new Set(['fix_computer']);
    const orphans = PLATFORM_TREE_LIBRARY.map((tree) => tree.tree_id).filter(
      (id) => !reachable.has(id) && !deliberatelyUnreachable.has(id)
    );
    expect(orphans).toEqual([]);
  });

  it('offers the job tree to the vertical whose primary traffic is job calls', () => {
    expect(OWNER_FOR_HIRE_PRESET.conversation_blocks).toContain('job');
    expect(OWNER_FOR_HIRE_PRESET.forbidden_trees).not.toContain('job');
  });

  // Same guarantee as the job assertion above, for the same reason. A law firm
  // whose preset omits case_intake cannot capture a matter at all: overrides can
  // only SUBTRACT, so the tree would be unreachable and every prospective client
  // would land as a plain message with none of the facts (statute date,
  // jurisdiction, existing counsel, opposing names) that decide take-or-decline.
  it('offers the case-intake tree to the law-firm vertical', () => {
    expect(LAW_FIRM_PRESET.conversation_blocks).toContain('case_intake');
    expect(LAW_FIRM_PRESET.forbidden_trees).not.toContain('case_intake');
  });

  // A law firm's line does not field recruiters and does not sell this product.
  it('keeps the law-firm preset off the trees that belong to other verticals', () => {
    expect(LAW_FIRM_PRESET.conversation_blocks).not.toContain('job');
    expect(LAW_FIRM_PRESET.conversation_blocks).not.toContain('buy_service');
  });

  it('compiles the law firm preset into case intake, booking, message, qa, and schedule change', () => {
    const runtime = materializeRuntimeConfig(LAW_FIRM_PRESET);
    expect(compileRuntimeConfig(runtime).map((tree) => tree.tree_id)).toEqual([
      'identity',
      'booking',
      'message',
      'generic_subject',
      'qa',
      'case_intake',
      'schedule_change',
    ]);
  });

  it('validates each shipped preset against the canonical schema', () => {
    for (const preset of PRESET_LIBRARY) {
      const typedPreset: VerticalPresetDef = preset;
      expect(verticalPresetSchema.parse(typedPreset)).toEqual(typedPreset);
    }
  });

  it('looks up presets by id', () => {
    expect(getPresetById('auto_shop_front_desk')).toEqual(AUTO_SHOP_PRESET);
    expect(getPresetById('salon_front_desk')).toEqual(SALON_PRESET);
    expect(getPresetById('local_service_front_desk')).toEqual(LOCAL_SERVICE_PRESET);
    expect(getPresetById('missing_preset')).toBeUndefined();
  });

  it('materializes each preset into a runtime config with the same selected blocks', () => {
    const runtime = materializeRuntimeConfig(AUTO_SHOP_PRESET, { booking_mode: 'offer_once' }, 3);

    expect(runtime).toEqual({
      preset_id: 'auto_shop_front_desk',
      enabled_conversation_blocks: AUTO_SHOP_PRESET.conversation_blocks,
      enabled_policy_blocks: AUTO_SHOP_PRESET.policy_blocks,
      enabled_knowledge_blocks: AUTO_SHOP_PRESET.knowledge_blocks,
      enabled_outcome_blocks: AUTO_SHOP_PRESET.outcome_blocks,
      overrides: { booking_mode: 'offer_once' },
      version: 3,
    });
  });

  it('compiles auto shop preset into vehicle intake, booking, message, qa, and schedule-change capabilities', () => {
    const runtime = materializeRuntimeConfig(AUTO_SHOP_PRESET);
    expect(compileRuntimeConfig(runtime).map((tree) => tree.tree_id)).toEqual([
      'identity',
      'auto_shop_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ]);
  });

  it('compiles salon preset into service intake, booking, message, qa, and schedule-change capabilities', () => {
    const runtime = materializeRuntimeConfig(SALON_PRESET);
    expect(compileRuntimeConfig(runtime).map((tree) => tree.tree_id)).toEqual([
      'identity',
      'salon_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ]);
  });

  it('compiles local service preset into selling, booking, message, qa, generic-subject, and schedule-change capabilities', () => {
    const runtime = materializeRuntimeConfig(LOCAL_SERVICE_PRESET);
    expect(compileRuntimeConfig(runtime).map((tree) => tree.tree_id)).toEqual([
      'identity',
      'booking',
      'message',
      'generic_subject',
      'qa',
      'buy_service',
      'schedule_change',
    ]);
  });

  it('never enables a tree the preset itself forbids', () => {
    for (const preset of PRESET_LIBRARY) {
      const enabled = new Set(preset.conversation_blocks);
      for (const forbidden of preset.forbidden_trees) {
        expect(enabled.has(forbidden)).toBe(false);
      }
    }
  });

  // Auto shop and salon now each carry their OWN intake tree (auto_shop_intake /
  // salon_intake) right after identity — that is the whole point of the
  // per-vertical intake work. What they still share is the front-desk backbone
  // (identity + booking + message + qa + schedule_change) and their
  // forbidden_trees. This asserts both halves: the intake differs, the rest is
  // identical. (The old test asserted the two presets were byte-identical,
  // which encoded "no unique vertical trees yet" — an invariant this feature
  // deliberately retires.)
  it('auto shop and salon share the front-desk backbone but each carry their own intake', () => {
    expect(AUTO_SHOP_PRESET.conversation_blocks).toContain('auto_shop_intake');
    expect(SALON_PRESET.conversation_blocks).toContain('salon_intake');
    expect(AUTO_SHOP_PRESET.conversation_blocks).not.toContain('salon_intake');
    expect(SALON_PRESET.conversation_blocks).not.toContain('auto_shop_intake');

    const backbone = (blocks: string[]) => blocks.filter((b) => !b.endsWith('_intake'));
    expect(backbone(AUTO_SHOP_PRESET.conversation_blocks)).toEqual([
      'identity',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ]);
    expect(backbone(AUTO_SHOP_PRESET.conversation_blocks)).toEqual(
      backbone(SALON_PRESET.conversation_blocks)
    );
    expect(AUTO_SHOP_PRESET.forbidden_trees).toEqual(SALON_PRESET.forbidden_trees);
  });

  it('ships required defaults for booking mode and primary intake', () => {
    for (const preset of PRESET_LIBRARY) {
      expect(preset.defaults.booking_mode).toBe('offer_once');
      expect(typeof preset.defaults.primary_intake).toBe('string');
    }
  });
});
