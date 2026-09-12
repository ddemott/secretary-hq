/**
 * Abandoned-test-number reaper (Wizard Phase B follow-up: "queryable, not
 * built" — this is the query).
 *
 * Each tenant's phone number costs money the moment it's provisioned,
 * whether or not anyone ever forwards a real business line to it or a real
 * caller ever dials it. `POST /provisioning/activate` search-purchases a
 * Telnyx DID and flips `tenants.phone_status` to `'active'` — a step done
 * routinely for test tenants during development, demos, and manual QA. A
 * test tenant that never went further (never set `forwarded_from_phone` to
 * make it someone's real line, never received a real call) is a number
 * quietly billing every month for nothing.
 *
 * ABANDONED, as defined here:
 *   1. `phone_status = 'active'`         — it has a real, billable Telnyx DID.
 *   2. `forwarded_from_phone IS NULL`    — it was never made into anyone's
 *      actual business line (a live tenant sets this during forwarding
 *      verification; a test tenant never does).
 *   3. no `voice_sessions` row in the last N days (default 14) — nobody has
 *      called it recently, so it isn't serving a live QA/demo purpose either.
 *   4. `is_deleted IS NOT true`          — soft-deleted tenants are a
 *      different (already-tracked) cleanup path; this reaper is for tenants
 *      that are still "active" by the app's own bookkeeping.
 *
 * REPORT ONLY. This does not release numbers or touch Telnyx — a DID
 * release is an irreversible, billable action against a real vendor account,
 * and deciding "abandoned enough to release" is a human judgment call this
 * script exists to INFORM, not make. Release manually via the Telnyx
 * dashboard (or `POST /provisioning/*` tooling) once you've reviewed the
 * list, mirroring purge-soft-deleted.ts's own dry-run-first philosophy —
 * except here there IS no --execute, because the deprovisioning path is a
 * platform-owner ops action, not something to automate blind.
 *
 * USAGE
 *   npx tsx scripts/find-abandoned-test-numbers.ts                    # 14-day window
 *   npx tsx scripts/find-abandoned-test-numbers.ts --older-than 30     # 30-day window
 *   npx tsx scripts/find-abandoned-test-numbers.ts --db "postgres://…" # target a specific DB
 */
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

export interface AbandonedTestNumberRow {
  tenant_id: string;
  name: string;
  inbound_phone: string | null;
  telnyx_phone_number_id: string | null;
  tenant_created_at: string | null;
  days_since_last_call: number | null;
}

/**
 * The query itself, shared between the CLI (below) and
 * `find-abandoned-test-numbers.realdb.test.ts` — so the test proves the exact
 * SQL that ships, not a hand-copied approximation of it.
 */
export async function findAbandonedTestNumbers(
  client: Pick<Client, 'query'>,
  days: number
): Promise<AbandonedTestNumberRow[]> {
  const res = await client.query<AbandonedTestNumberRow>(
    `SELECT
       t.tenant_id,
       t.name,
       t.inbound_phone,
       t.telnyx_phone_number_id,
       t.created_at::text AS tenant_created_at,
       (EXTRACT(EPOCH FROM (now() - MAX(vs.started_at))) / 86400)::int AS days_since_last_call
     FROM tenants t
     LEFT JOIN voice_sessions vs ON vs.tenant_id = t.tenant_id
     WHERE t.phone_status = 'active'
       -- Copilot review, PR #417: phone_status='active' alone does not prove
       -- a real Telnyx number is on file — schema does not enforce it, so a
       -- corrupt/partial row (active status, no id ever recorded) would
       -- report as "billing" with nothing to actually go release. Both
       -- columns must be present for a row to mean what this report claims.
       AND t.telnyx_phone_number_id IS NOT NULL
       AND t.inbound_phone IS NOT NULL
       AND t.forwarded_from_phone IS NULL
       AND (t.is_deleted IS NULL OR t.is_deleted = false)
     GROUP BY t.tenant_id, t.name, t.inbound_phone, t.telnyx_phone_number_id, t.created_at
     HAVING MAX(vs.started_at) IS NULL
         OR MAX(vs.started_at) < now() - ($1 || ' days')::interval
     ORDER BY days_since_last_call ASC NULLS LAST, t.name`,
    [days]
  );
  return res.rows;
}

/**
 * All CLI-only behavior (arg parsing, exiting on a bad flag, opening a real
 * connection) lives here, gated behind `invokedDirectly` below. Importing
 * this module for `findAbandonedTestNumbers` — as the real-DB test does —
 * must never parse `process.argv` or call `process.exit`; a module with
 * top-level side effects like that cannot be imported safely at all.
 */
async function runCli() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const OLDER_THAN_REQUESTED = has('--older-than');
  const olderThanRaw = valueOf('--older-than');
  if (OLDER_THAN_REQUESTED && (olderThanRaw === undefined || olderThanRaw.startsWith('--'))) {
    console.error(
      'FATAL: --older-than was passed with no value. ' +
        'Refusing to run rather than silently falling back to the default window.'
    );
    process.exit(1);
  }
  const DAYS = OLDER_THAN_REQUESTED ? Number(olderThanRaw) : 14;
  if (!Number.isFinite(DAYS) || DAYS < 0) {
    console.error(
      `FATAL: --older-than expects a non-negative number of days, got "${olderThanRaw}".`
    );
    process.exit(1);
  }

  const DB_URL = valueOf('--db') ?? process.env.DATABASE_URL;
  if (!DB_URL) {
    console.error('FATAL: no database. Pass --db "postgres://…" or set DATABASE_URL.');
    process.exit(1);
  }

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const rows = await findAbandonedTestNumbers(client, DAYS);

    if (rows.length === 0) {
      console.log(`No abandoned test numbers found (window: ${DAYS}+ days idle, or never called).`);
      return;
    }

    console.log(
      `${rows.length} candidate(s) — phone_status='active', forwarded_from_phone IS NULL, ` +
        `no voice_sessions in ${DAYS}+ days:\n`
    );
    for (const r of rows) {
      const idle =
        r.days_since_last_call === null ? 'never called' : `${r.days_since_last_call}d idle`;
      const created = r.tenant_created_at ? r.tenant_created_at.slice(0, 10) : '(unknown)';
      console.log(
        `  ${r.tenant_id}  ${(r.name ?? '(unnamed)').padEnd(30)}  ` +
          `${(r.inbound_phone ?? '(no number on file)').padEnd(16)}  ` +
          `telnyx_id=${r.telnyx_phone_number_id ?? '(none)'}  ${idle}  tenant created ${created}`
      );
    }
    console.log(
      '\nThese numbers are billing Telnyx monthly for no live purpose. Review each tenant, ' +
        'then release its DID manually (Telnyx dashboard or provisioning tooling) if it is ' +
        'genuinely a dead test/demo tenant — this script does not release anything itself.'
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
