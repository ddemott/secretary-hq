/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Reminder Scheduler Worker
 *
 * Background worker that processes due reminders.
 * Runs on an interval (default: every minute) to check for
 * reminders that need to be sent.
 *
 * Usage:
 *   import { startReminderScheduler, stopReminderScheduler } from './workers/reminderScheduler';
 *   startReminderScheduler(); // Start processing
 *   stopReminderScheduler();  // Stop processing (for graceful shutdown) — now async
 */

import type { Pool } from 'pg';
import { createDatabaseService, type DatabaseService, getPool } from '../database/index.js';
import { ReminderService } from '../services/reminders/index.js';
import { decideRetry, MAX_RETRIES } from '../services/reminders/retryPolicy.js';
import { errorsTotal } from '../services/metrics.js';
import { createTenantConfigService, type TenantConfigService } from '../services/tenants/index.js';

// ── Configuration ────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_BATCH_SIZE = 100;

/**
 * How long a row may sit in 'sending' before we assume the worker that claimed
 * it is gone and put it back on the queue.
 *
 * The claim query only ever selects status = 'scheduled'. A row claimed by a
 * process that then dies — SIGTERM past the 10s drain, OOM, pod eviction — is
 * therefore invisible to every future tick FOREVER. Without this sweep the
 * atomic claim would trade a loud double-text for a silent lost reminder.
 *
 * 5 minutes is deliberately far longer than any real batch (the tick is 60s and
 * the drain caps at 10s), so this can only fire on a genuinely abandoned claim,
 * never on a slow-but-alive one. Re-sending a reminder we are not sure went out
 * is the correct trade against never sending it.
 */
const STALE_CLAIM_MS = 5 * 60_000;

// ── State ────────────────────────────────────────────────────────────

let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let isShuttingDown = false;
let _currentTick: Promise<void> | null = null;
let db: DatabaseService | null = null;
let configService: TenantConfigService | null = null;
let reminderService: ReminderService | null = null;

// ── Initialization ───────────────────────────────────────────────────

/**
 * Initialize services lazily.
 */
function initServices(): void {
  if (!db) {
    db = createDatabaseService();
  }
  if (!configService) {
    configService = createTenantConfigService();
  }
  if (!reminderService) {
    reminderService = new ReminderService(db, configService);
  }
}

// ── Processing ───────────────────────────────────────────────────────

/**
 * Process a single batch of due reminders.
 * Returns the number of reminders processed.
 */
/**
 * Put reminders abandoned in 'sending' back on the queue.
 *
 * Exported for direct testing; processBatch calls it at the top of every tick.
 * `poolOverride` lets tests pass the test-DB pool instead of the production one.
 *
 * Non-fatal by design: if this sweep fails we still want the tick to go on and
 * process the reminders that ARE claimable. It is loud about it, because a
 * persistently failing release means reminders are piling up unseen.
 */
export async function releaseStaleClaims(poolOverride?: Pool): Promise<number> {
  const pool = poolOverride ?? getPool();
  try {
    const res = await pool.query(
      `UPDATE reminder_schedules
          SET status = 'scheduled', updated_at = NOW()
        WHERE status = 'sending'
          AND updated_at < NOW() - ($1::int * interval '1 millisecond')
       RETURNING reminder_schedule_id`,
      [STALE_CLAIM_MS]
    );
    const released = res.rowCount ?? 0;
    if (released > 0) {
      // WHO: a customer waiting on a confirmation or reminder. WHAT: their row was
      // claimed and then orphaned. WHEN: a worker died mid-batch. WHERE: the
      // atomic claim in processBatch. WHY: the claim query only sees 'scheduled',
      // so without this the reminder would never be attempted again.
      errorsTotal.inc({ event: 'reminder_stale_claim_released' });
      console.warn(
        JSON.stringify({
          event: 'reminder_stale_claim_released',
          count: released,
          stale_after_ms: STALE_CLAIM_MS,
          reason:
            'reminder rows sat in status=sending past the stale window — the worker that claimed them did not finish',
          next: 'expected after a hard kill; if this is nonzero every tick, the worker is crashing mid-batch',
        })
      );
    }
    return released;
  } catch (error) {
    errorsTotal.inc({ event: 'reminder_stale_claim_release_failed' });
    // Same structured shape as reminder_batch_failed below — these two are the
    // only ways this worker fails wholesale, and a log parser should not have to
    // handle one of them as JSON and the other as a prose string.
    console.error(
      JSON.stringify({
        event: 'reminder_stale_claim_release_failed',
        reason: error instanceof Error ? error.message : 'Unknown error',
        impact:
          'reminders abandoned in status=sending were NOT returned to the queue — if this persists they are never retried',
        next: 'check DB reachability and that status=sending is permitted by reminder_schedules_status_check',
      })
    );
    if (error instanceof Error && error.stack) console.error(error.stack);
    return 0;
  }
}

async function processBatch(): Promise<number> {
  initServices();
  if (!db || !reminderService) return 0;

  const pool = getPool();

  // Before claiming anything new, take back what a dead worker left behind.
  await releaseStaleClaims(pool);

  try {
    // ATOMIC CLAIM prevents double-SMS race: UPDATE + FOR UPDATE SKIP LOCKED
    // RETURNING guarantees only one worker claims a reminder. Sets 'sending'
    // so concurrent ticks see it as in-flight. High impact on every deploy.
    //
    // 'sending' must be in reminder_schedules_status_check (migration
    // 20260819000000) or this statement throws on every tick and the whole
    // pipeline goes silently dark — it did, for 13 days. The paired guarantees
    // are releaseStaleClaims() above (a claim can be abandoned) and
    // processReminder's acceptance of 'sending' (a claimed row is processable).
    // Changing any one of the three in isolation breaks reminders.
    const claimRes = await pool.query(
      `
      UPDATE reminder_schedules
         SET status = 'sending',
             updated_at = NOW()
       WHERE reminder_schedule_id IN (
         SELECT reminder_schedule_id
           FROM reminder_schedules
          WHERE status = 'scheduled'
            AND scheduled_for <= NOW()
          ORDER BY scheduled_for ASC, reminder_schedule_id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING *
    `,
      [MAX_BATCH_SIZE]
    );

    const dueReminders = claimRes.rows;

    if (dueReminders.length === 0) {
      return 0;
    }

    console.log(`🔔 Processing ${dueReminders.length} due reminder(s)`);

    let processed = 0;
    for (const reminder of dueReminders) {
      try {
        await reminderService.processReminder(reminder.reminder_schedule_id.toString());
        processed++;
      } catch (error) {
        errorsTotal.inc({ event: 'reminder_process_failed' });
        console.error(`❌ Failed to process reminder ${reminder.reminder_schedule_id}:`, error);
        const currentRetryCount = reminder.retry_count ?? 0;
        const decision = decideRetry(error, currentRetryCount);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        try {
          if (decision.action === 'retry') {
            await db.updateReminderSchedule(reminder.reminder_schedule_id.toString(), {
              status: 'scheduled',
              error: errorMessage,
              retry_count: decision.nextRetryCount,
              next_retry_at: decision.nextRetryAt.toISOString(),
            });
            console.log(
              `🔁 Retry ${decision.nextRetryCount}/${MAX_RETRIES} scheduled for reminder ${reminder.reminder_schedule_id} at ${decision.nextRetryAt.toISOString()}`
            );
          } else {
            await db.updateReminderSchedule(reminder.reminder_schedule_id.toString(), {
              status: 'failed',
              error: `${errorMessage} (reason: ${decision.reason})`,
            });
          }
        } catch (updateError) {
          // Worse than the outer catch: the row is stuck in 'sending' with no
          // status write to recover it — only releaseStaleClaims()'s 5-minute
          // sweep will put it back on the queue. Silent until then.
          errorsTotal.inc({ event: 'reminder_status_update_failed' });
          console.error(`❌ Failed to update reminder status:`, updateError);
        }
      }
    }

    console.log(`✅ Processed ${processed}/${dueReminders.length} reminder(s)`);
    return processed;
  } catch (error) {
    // This catch swallowed a THIRTEEN-DAY total reminder outage into a single
    // console.error line (2026-08-06 → 2026-08-19). The claim above wrote
    // status='sending', which the CHECK constraint did not allow, so every tick
    // threw here, incremented a counter on the token-gated /metrics endpoint
    // that nothing scrapes, and returned 0 — a worker that looked alive, a
    // /health that stayed green, and not one reminder sent. See migration
    // 20260819000000.
    //
    // The lesson is not "add a metric" (there already was one). It is that a
    // batch-wide failure must say IN WORDS what it means for the customer, so
    // the next person to read a log line knows the pipeline is down rather than
    // that one batch hiccuped.
    errorsTotal.inc({ event: 'reminder_batch_failed' });
    console.error(
      JSON.stringify({
        event: 'reminder_batch_failed',
        reason: error instanceof Error ? error.message : 'Unknown error',
        impact:
          'NO reminders or confirmations were sent this tick — if this repeats, the reminder pipeline is fully down, not degraded',
        next: 'check the claim UPDATE against the reminder_schedules_status_check constraint and the DB connection',
      })
    );
    if (error instanceof Error && error.stack) console.error(error.stack);
    return 0;
  }
}

/**
 * Delete demo tenants whose demo_expires_at has passed.
 * Uses the raw pool with no RLS tenant context — this is an admin sweep.
 * CASCADE on tenants covers all child rows automatically.
 * Exported for direct testing; the scheduler tick also calls it on every cycle.
 *
 * The optional `poolOverride` parameter lets tests pass the test-DB pool
 * instead of the production pool (which reads DATABASE_URL from env).
 */
export async function cleanupExpiredDemoTenants(poolOverride?: Pool): Promise<void> {
  try {
    const pool = poolOverride ?? getPool();
    // SOFT delete (2026-07-13). This runs EVERY 60 SECONDS in production, and a
    // cascading DELETE here races the fire-and-forget reminder seeding of any live
    // booking: the cascade takes FK locks appointments → tenants, the seeding INSERT
    // takes them tenants → appointments, and Postgres kills one side at random. That
    // is a real production deadlock on a 60-second timer. An UPDATE takes no cascade
    // locks.
    //
    // The rows still exist; a maintenance-window purge can reclaim them whenever we
    // want. Nothing reads them: createWithTenantClient treats a soft-deleted tenant
    // as 404, so an expired demo cannot answer a call, book, or bill.
    const res = await pool.query(
      `UPDATE tenants
          SET is_deleted = true, deleted_at = now()
        WHERE is_demo = true AND demo_expires_at < NOW() AND is_deleted = false
       RETURNING tenant_id`
    );
    if ((res.rowCount ?? 0) > 0) {
      console.log(`🧹 Soft-deleted ${res.rowCount} expired demo tenant(s)`);
    }
  } catch (err) {
    console.error('❌ Demo tenant cleanup error:', err);
  }
}

/**
 * Main scheduler tick - called on each interval.
 */
function tick(): Promise<void> {
  if (isShuttingDown || isRunning) {
    return Promise.resolve();
  }

  isRunning = true;
  _currentTick = (async () => {
    try {
      await processBatch();
      await cleanupExpiredDemoTenants();
    } catch (error) {
      console.error('Tick error:', error);
    } finally {
      isRunning = false;
      _currentTick = null;
    }
  })();
  return _currentTick;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the reminder scheduler.
 * @param intervalMs - Processing interval in milliseconds (default: 60000)
 */
export function startReminderScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (schedulerInterval) {
    console.warn('⚠️ Reminder scheduler is already running');
    return;
  }

  console.log(`🚀 Starting reminder scheduler (interval: ${intervalMs}ms)`);
  initServices();

  // Run immediately on start, then on interval
  tick().catch(console.error);
  schedulerInterval = setInterval(() => {
    tick().catch(console.error);
  }, intervalMs);
}

/**
 * Stop the reminder scheduler. Drains current tick with timeout to prevent
 * in-flight reminders from being abandoned mid-process.
 */
export async function stopReminderScheduler(timeoutMs = 10000): Promise<void> {
  isShuttingDown = true;
  if (schedulerInterval) {
    console.log('🛑 Stopping reminder scheduler');
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  if (_currentTick) {
    console.log('Draining current reminder tick (SIGTERM drain)...');
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('drain timeout')), timeoutMs)
    );
    try {
      await Promise.race([_currentTick, timeout]);
      console.log('Drain complete');
    } catch {
      console.warn('Reminder worker drain timed out');
    }
  }

  if (reminderService) {
    reminderService.cleanup();
  }
  isShuttingDown = false;
}

/**
 * Check if the scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null;
}

/**
 * Process reminders immediately (for testing or manual trigger).
 */
export async function processRemindersNow(): Promise<number> {
  return processBatch();
}

/**
 * Get scheduler status for monitoring.
 */
export function getSchedulerStatus(): {
  running: boolean;
  processing: boolean;
} {
  return {
    running: schedulerInterval !== null,
    processing: isRunning,
  };
}

// ── Graceful Shutdown ────────────────────────────────────────────────

// Handle process signals for graceful shutdown
if (typeof process !== 'undefined') {
  const handleShutdown = async () => {
    await stopReminderScheduler().catch(console.error);
  };

  process.once('SIGTERM', handleShutdown);
  process.once('SIGINT', handleShutdown);
}
