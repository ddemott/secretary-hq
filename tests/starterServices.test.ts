/**
 * T-015: the starter-service catalogue's rules, enforced.
 *
 * WHO: an owner picking their business type in the setup wizard.
 * WHAT: they get 2–4 bookable starters that a caller would actually say, with a
 *       description on the ones a caller cannot name, and exactly one marked as
 *       the fallthrough.
 * WHEN: every CI run — this file is the guard on shared/starterServices.ts.
 * WHERE: shared/starterServices.ts → supabase/{seed.sql,migrations/…} via
 *        scripts/generate-starter-services-sql.ts.
 * WHY: `example_services` was empty for all 31 live business types, so Step 1
 *      asked "What service do you offer?" against a blank list. Refilling it is
 *      only half the job — the content has rules, and the rules are what stop
 *      the refill from being worse than the emptiness. A seeded "Brake Service"
 *      lets the agent book a named repair off "there's a noise"; a seeded
 *      "Bay 1" lets it book a caller into a parking space.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STARTER_SERVICES,
  defaultStarterFor,
  starterResourcesFor,
} from '../shared/starterServices';

const SEED = readFileSync(path.resolve(__dirname, '../supabase/seed.sql'), 'utf-8');

/** business_type values that seed.sql actually creates a template row for. */
function liveBusinessTypes(): Set<string> {
  const types = new Set<string>();
  const row = /\(\s*'([a-z-]+)',\s*'(?:[^']|'')*',\s*'(?:[^']|'')*',\s*\d+,/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(SEED)) !== null) types.add(m[1]);
  return types;
}

const ALL = Object.entries(STARTER_SERVICES);

describe('starter services — catalogue rules', () => {
  it('HAPPY: covers every live business template, and invents none', () => {
    const live = liveBusinessTypes();
    // 30 since 2026-09-25: med-spa removed (HIPAA-adjacent).
    expect(live.size).toBeGreaterThanOrEqual(30);

    const missing = [...live].filter((t) => !STARTER_SERVICES[t]).sort();
    expect(
      missing,
      `these business types have a template row but no starters, so their wizard Step 1 is blank: ${missing.join(', ')}`
    ).toEqual([]);

    const invented = Object.keys(STARTER_SERVICES)
      .filter((t) => !live.has(t))
      .sort();
    expect(
      invented,
      `these have starters but no business_templates row, so nothing can ever reach them: ${invented.join(', ')}`
    ).toEqual([]);
  });

  it('HAPPY: 2–4 starters each — no vertical ships one, and none ships a menu', () => {
    // The rule is 2–4, and it is now true without exception.
    //
    // It briefly was not. med-spa and law-firm shipped ONE, because the work
    // order's RULE said 2–4 while its reference LIST said "Aesthetic
    // consultation only" and "Consultation only" for those two. That is a
    // conflict inside the work order, and it was resolved silently by loosening
    // the test floor to 1 — which made the catalogue header, the roadmap, and
    // the tests disagree with each other about what the rule even was.
    //
    // Resolved the other way instead: each of those two gained a second starter
    // that is defensible on its own terms (med-spa "Follow-up visit",
    // law-firm "Case status call" — both real inbound bookings that presume
    // nothing about an unassessed treatment or an untaken case). The rule is one
    // number again, and it is the number the work order stated.
    for (const [businessType, list] of ALL) {
      expect(
        list.length,
        `${businessType} has ${list.length} starter(s); the rule is 2–4`
      ).toBeGreaterThanOrEqual(2);
      expect(
        list.length,
        `${businessType} has ${list.length} starters; more than 4 is a department menu`
      ).toBeLessThanOrEqual(4);
    }
  });

  it('HAPPY: exactly one default per vertical, and it is a real row', () => {
    for (const [businessType, list] of ALL) {
      const defaults = list.filter((s) => s.is_default);
      expect(
        defaults.length,
        `${businessType} has ${defaults.length} rows marked is_default — it must have exactly 1, ` +
          `because this is the single service every unmatched call falls through to`
      ).toBe(1);
      expect(defaultStarterFor(businessType)?.name).toBe(defaults[0].name);
    }
  });

  it('HAPPY: every look-first starter carries a description', () => {
    // Not stylistic. resolveServiceForBooking's semantic step embeds
    // concat_ws('. ', name, subtitle, description). A look-first row exists
    // precisely because the caller CANNOT name it, so the name is the one thing
    // that will never match — the description is the whole mechanism.
    for (const [businessType, list] of ALL) {
      for (const s of list.filter((x) => x.look_first)) {
        expect(
          (s.description ?? '').trim().length,
          `${businessType} → "${s.name}" is look_first with no description, so "there's a noise" ` +
            `has nothing to match against and the call falls through to the default`
        ).toBeGreaterThan(20);
      }
    }
  });

  it('HAPPY: repair-heavy verticals default to a look-first row', () => {
    // The caller who cannot say what they need IS the caller who falls through.
    // On these trades the honest default is the visit, not a named repair.
    const repairHeavy = [
      'auto-shop',
      'body-shop',
      'plumber',
      'hvac',
      'electrician',
      'garage-door',
      'locksmith',
      'pest-control',
    ];
    for (const businessType of repairHeavy) {
      const def = defaultStarterFor(businessType);
      expect(def, `${businessType} has no default starter`).toBeTruthy();
      expect(
        def?.look_first,
        `${businessType} defaults to "${def?.name}", which is a named SKU. A caller who says ` +
          `"it's making a noise" would be booked straight into it.`
      ).toBe(true);
    }
  });

  it('HAPPY: specialty-SKU verticals default to the named SKU, not a consult', () => {
    // The mirror of the rule above: where the caller genuinely can name it,
    // defaulting to a consultation adds a step to every single call.
    for (const businessType of ['oil-change', 'nail-salon', 'car-wash', 'barbershop']) {
      const def = defaultStarterFor(businessType);
      expect(def?.look_first ?? false, `${businessType} defaults to a look-first row`).toBe(false);
    }
  });

  it('SAD: never seeds a HIPAA vertical', () => {
    // Permanently excluded product policy. The old populating migration
    // (20260317000004) still contains dentist / vet-clinic / chiropractor rows;
    // this asserts none of them came back with the refill.
    for (const banned of ['dentist', 'vet-clinic', 'chiropractor', 'optometry', 'veterinary']) {
      expect(STARTER_SERVICES[banned], `${banned} is a HIPAA vertical`).toBeUndefined();
    }
  });

  it('SAD: never seeds an emergency SKU, a membership, or message-taking', () => {
    // - "Emergency fix" as a catalog row oversells: urgency is a property of a
    //   CALL, and the agent has no live-transfer path, so a bookable emergency
    //   slot promises a response nobody committed to.
    // - A membership is billing, not a bookable half hour.
    // - Taking a message is a TOOL the agent already has. As a service it would
    //   appear in the spoken menu and callers would "book" one.
    const banned = /\b(emergency|urgent|membership|subscription|message taking|take a message)\b/i;
    for (const [businessType, list] of ALL) {
      for (const s of list) {
        expect(
          banned.test(s.name),
          `${businessType} → "${s.name}" matches a banned starter shape`
        ).toBe(false);
      }
    }
  });

  it('SAD: never seeds a resource name as a service', () => {
    // "Bay 1" seeded as a SERVICE becomes a bookable slot type the agent can
    // offer, so a caller gets booked for a parking space instead of an oil
    // change. Resources are a separate column for exactly this reason.
    const resourceish =
      /^(bay|van|chair|room|station|lane|booth|studio|office|counter|team|crew|truck|line|kitchen|treatment room|detail bay|wash bay)\s*[a-z0-9]?$/i;
    for (const [businessType, list] of ALL) {
      for (const s of list) {
        expect(
          resourceish.test(s.name.trim()),
          `${businessType} → "${s.name}" looks like a RESOURCE, not a service`
        ).toBe(false);
      }
    }
  });

  it('SAD: never seeds the event itself as a bookable slot', () => {
    // A wedding reception is the JOB — days of work and a venue. Booking it as
    // a 30-minute calendar row is a lie the owner discovers on the day.
    const eventish = /\b(wedding reception|reception|banquet|full event|the event)\b/i;
    for (const [businessType, list] of ALL) {
      for (const s of list) {
        expect(
          eventish.test(s.name),
          `${businessType} → "${s.name}" is the event, not a slot`
        ).toBe(false);
      }
    }
  });

  it('HAPPY: example resources are shape-only names derived from the resource label', () => {
    expect(starterResourcesFor('Bay')).toEqual(['Bay 1', 'Bay 2']);
    expect(starterResourcesFor('Van')).toEqual(['Van 1', 'Van 2']);
    // A blank label must still produce something nameable rather than " 1".
    expect(starterResourcesFor('  ')).toEqual(['Resource 1', 'Resource 2']);
  });

  it('HAPPY: the generated SQL on disk still matches this catalogue', () => {
    // The seed and the migration are DERIVED. If someone hand-edits the SQL it
    // becomes a second source of truth, which is the exact failure that emptied
    // this column: three copies of one list, only one of them maintained.
    for (const [businessType, list] of ALL) {
      const json = JSON.stringify(
        list.map((s) => ({
          name: s.name,
          ...(s.description ? { description: s.description } : {}),
          ...(s.look_first ? { look_first: true } : {}),
          ...(s.is_default ? { is_default: true } : {}),
        }))
      ).replace(/'/g, "''");
      expect(
        SEED.includes(json),
        `supabase/seed.sql is stale for '${businessType}'. Run: npx tsx scripts/generate-starter-services-sql.ts`
      ).toBe(true);
    }
  });
});
