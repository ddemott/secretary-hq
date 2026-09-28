/**
 * Maintenance purge — the ONLY thing in this codebase that destroys data.
 *
 * The application never hard-deletes a tenant. `DELETE /tenants/:id` and the
 * tutorial-expiry reaper both flip `tenants.is_deleted` instead (2026-07-13), because:
 *
 *   1. A cascading DELETE obliterates a business — every appointment, customer, call
 *      recording, transcript, consent record — irreversibly, from one call, with no
 *      undo. Every other entity in this schema was already soft-deleted; tenants was
 *      the outlier, and the most destructive one.
 *   2. The cascade DEADLOCKS against fire-and-forget reminder seeding (FK locks in
 *      opposite orders; Postgres kills one side at random — PR #242). The tutorial reaper
 *      runs every 60 seconds in production, so this is a live hazard, not a theory.
 *
 * So destruction becomes a deliberate, human, maintenance-window act. That is what
 * this script is.
 *
 * DEFAULT IS A DRY RUN. It reports what it *would* delete and exits. You must pass
 * --execute to actually destroy anything, and --yes to skip the confirmation.
 *
 * USAGE
 *   npx tsx scripts/purge-soft-deleted.ts                      # dry run (default)
 *   npx tsx scripts/purge-soft-deleted.ts --older-than 30      # only 30+ days deleted
 *   npx tsx scripts/purge-soft-deleted.ts --execute --yes      # actually purge
 *   npx tsx scripts/purge-soft-deleted.ts --db "postgres://…"  # target a specific DB
 *
 * It also reports ORPHANS — rows whose parent is gone — because a soft-delete world
 * accumulates them and nothing else is looking.
 */
import { Client } from 'pg';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const EXECUTE = has('--execute');
const SKIP_CONFIRM = has('--yes');
/**
 * Age guard for the purge. THIS SCRIPT HARD-DELETES; a dropped guard is not a
 * degraded run, it is a bigger blast radius than the operator asked for.
 *
 * `Number(valueOf('--older-than') ?? 0)` silently produced NaN for a
 * non-numeric value, and `NaN > 0` is false, so the `AND deleted_at < …`
 * clause was omitted entirely — `--older-than abc --execute --yes` purged
 * EVERY soft-deleted tenant, including one deleted a minute ago, while the
 * operator believed they had asked for a 30-day floor. A mistyped guard must
 * stop the run, never quietly widen it.
 *
 * PRESENCE and VALUE are separate questions, and conflating them re-creates the
 * same bug one step over: `valueOf` returns `undefined` both when the flag was
 * never passed AND when it was passed last with nothing after it, so
 * `purge --execute --yes --older-than` would have read as "no guard requested"
 * and purged everything — an operator who typed the flag getting the behaviour
 * of one who did not. `has()` answers presence; only then is the value parsed.
 */
const OLDER_THAN_REQUESTED = has('--older-than');
const olderThanRaw = valueOf('--older-than');
if (OLDER_THAN_REQUESTED && (olderThanRaw === undefined || olderThanRaw.startsWith('--'))) {
  // Passed last (nothing follows) or immediately followed by another flag, which
  // `valueOf` would otherwise hand back as the "value".
  console.error(
    'FATAL: --older-than was passed with no value. ' +
      'Refusing to run — a guard the operator asked for must never be silently dropped.'
  );
  process.exit(1);
}
const OLDER_THAN_DAYS = OLDER_THAN_REQUESTED ? Number(olderThanRaw) : 0;
if (!Number.isFinite(OLDER_THAN_DAYS) || OLDER_THAN_DAYS < 0) {
  console.error(
    `FATAL: --older-than expects a non-negative number of days, got "${olderThanRaw}". ` +
      'Refusing to run — an unparseable age guard would silently purge everything.'
  );
  process.exit(1);
}
const DB_URL = valueOf('--db') ?? process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('FATAL: no database. Pass --db "postgres://…" or set DATABASE_URL.');
  process.exit(1);
}

/**
 * Orphan checks. Each is a row whose parent no longer exists — the residue a
 * soft-delete world accumulates, plus any FK gap that predates it.
 *
 * These are REPORTED, never auto-deleted: an orphan usually means a bug upstream,
 * and silently reaping the evidence would hide it.
 */
const ORPHAN_CHECKS: { label: string; sql: string }[] = [
  {
    label: 'appointments whose customer is soft-deleted',
    sql: `SELECT COUNT(*)::int AS n FROM appointments a
           JOIN customers c ON c.customer_id = a.customer_id
          WHERE c.is_deleted = true AND a.status = 'scheduled' AND a.start_time > now()`,
  },
  {
    label: 'reminder_schedules for a soft-deleted tenant (would text a dead business)',
    sql: `SELECT COUNT(*)::int AS n FROM reminder_schedules rs
           JOIN tenants t ON t.tenant_id = rs.tenant_id
          WHERE t.is_deleted = true AND rs.status = 'scheduled'`,
  },
  {
    label: 'employee_schedule rows for an inactive employee (phantom capacity)',
    sql: `SELECT COUNT(*)::int AS n FROM employee_schedule es
           JOIN employees e ON e.employee_id = es.employee_id
          WHERE e.is_active = false AND es.shift_date >= CURRENT_DATE`,
  },
  {
    label: 'voice_sessions pointing at an appointment that no longer exists',
    sql: `SELECT COUNT(*)::int AS n FROM voice_sessions vs
          WHERE vs.appointment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.appointment_id = vs.appointment_id)`,
  },
];

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    const cutoff =
      OLDER_THAN_DAYS > 0 ? `AND deleted_at < now() - interval '${OLDER_THAN_DAYS} days'` : '';

    const { rows: candidates } = await client.query<{
      tenant_id: string;
      name: string;
      deleted_at: string | null;
      is_tutorial: boolean;
    }>(
      `SELECT tenant_id, name, deleted_at, is_tutorial
         FROM tenants
        WHERE is_deleted = true ${cutoff}
        ORDER BY deleted_at NULLS FIRST`
    );

    console.log('\n══ SOFT-DELETED TENANTS ══');
    if (candidates.length === 0) {
      console.log('  none.');
    }
    for (const t of candidates) {
      // Show the blast radius BEFORE destroying it. A count of "0 appointments" and
      // a count of "4,000 appointments" deserve very different levels of nerve.
      const { rows } = await client.query<{ table_name: string; n: number }>(
        `SELECT 'appointments' AS table_name, COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1
         UNION ALL SELECT 'customers',        COUNT(*)::int FROM customers        WHERE tenant_id = $1
         UNION ALL SELECT 'voice_sessions',   COUNT(*)::int FROM voice_sessions   WHERE tenant_id = $1
         UNION ALL SELECT 'consent_records',  COUNT(*)::int FROM consent_records  WHERE tenant_id = $1
         UNION ALL SELECT 'opt_out_records',  COUNT(*)::int FROM opt_out_records  WHERE tenant_id = $1`,
        [t.tenant_id]
      );
      const radius = rows
        .filter((r) => r.n > 0)
        .map((r) => `${r.n} ${r.table_name}`)
        .join(', ');
      console.log(
        `  ${t.name}${t.is_tutorial ? ' [tutorial]' : ''}  deleted=${t.deleted_at ?? '?'}\n` +
          `      would destroy: ${radius || '(nothing but the tenant row)'}`
      );

      // Opt-out records are the one thing worth a second thought. A purge erases the
      // proof that someone said STOP. If they are ever re-added as a customer, we
      // have no record they opted out — a TCPA problem, not a data-hygiene one.
      const optOuts = rows.find((r) => r.table_name === 'opt_out_records')?.n ?? 0;
      if (optOuts > 0) {
        console.log(
          `      ⚠️  ${optOuts} OPT-OUT RECORD(S) — purging destroys the proof these people said STOP.`
        );
      }
    }

    console.log('\n══ ORPHANS (reported, never auto-deleted) ══');
    for (const check of ORPHAN_CHECKS) {
      const { rows } = await client.query<{ n: number }>(check.sql);
      const n = rows[0]?.n ?? 0;
      console.log(`  ${n > 0 ? '⚠️ ' : '  '}${String(n).padStart(5)}  ${check.label}`);
    }

    if (!EXECUTE) {
      console.log(
        '\nDRY RUN — nothing was changed. Re-run with --execute --yes to actually purge.\n'
      );
      return;
    }

    if (candidates.length === 0) {
      console.log('\nNothing to purge.\n');
      return;
    }

    if (!SKIP_CONFIRM) {
      console.error(
        '\nRefusing to purge without --yes. This is irreversible and cascades to every\n' +
          'appointment, customer, call recording and consent record of these tenants.\n'
      );
      process.exit(1);
    }

    console.log('\n══ PURGING ══');
    for (const t of candidates) {
      // Retry on deadlock (40P01). The cascade can still race an in-flight
      // fire-and-forget reminder insert if the app is up — which is exactly why this
      // is a MAINTENANCE-WINDOW script. Retry anyway: being killed by the scheduler is
      // transient, and the statement is valid the instant it is retried.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await client.query('DELETE FROM tenants WHERE tenant_id = $1', [t.tenant_id]);
          console.log(`  ✔ purged ${t.name}`);
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== '40P01' || attempt === 5) throw err;
          console.log(`  … deadlock on ${t.name}, retry ${attempt}`);
          await new Promise((r) => setTimeout(r, 100 * attempt));
        }
      }
    }
    console.log(`\nPurged ${candidates.length} tenant(s).\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('purge failed:', err);
  process.exit(1);
});
