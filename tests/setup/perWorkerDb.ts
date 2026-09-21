/**
 * Vitest setup file (runs in every test worker before any test module loads): point the four
 * database env vars at THIS worker's database. See globalSetup.ts for how those databases exist.
 *
 * VITEST_POOL_ID is the worker slot (1..maxWorkers). VITEST_WORKER_ID is a different counter
 * that grows past maxWorkers, so it must not be used to name databases.
 */
import { workerDbName, workerEnv } from './dbUrls';

const runId = process.env.TEST_DB_RUN;
if (runId && process.env.TEST_PER_WORKER_DB !== '0') {
  const slot = process.env.VITEST_POOL_ID ?? '1';
  Object.assign(process.env, workerEnv(process.env, workerDbName(runId, slot)));
}
