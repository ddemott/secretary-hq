// sim-load — booking-path load probe (on-demand, localhost-only).
//
// PURPOSE: characterize the FAILURE MODE of the booking path under concurrency
// that exceeds the DB pool (max=10, connectionTimeoutMillis=5000). The question
// is NOT "what's the absolute ceiling" — a number off a dev box + docker
// Postgres doesn't transfer to Railway — but "when concurrency >> pool, do
// excess requests fail FAST (~5s checkout timeout → clean error, the behavior
// connectionTimeoutMillis exists to guarantee) or do they hang / cascade?"
//
// Contention is wanted, not avoided: a conflicting booking still runs the atomic
// RPC and holds a connection, which is exactly the pool pressure being measured.
// Outcomes are bucketed honestly (success / conflict / pool-or-error) so a
// conflict is never mistaken for a failure.
//
// CONTEXT: the agent runs one LiveKit worker per tenant, so concurrent bookings
// are bounded by simultaneous calls across DISTINCT tenants — a handful at beta
// scale. pool=10 is near-certainly fine for real load; this is a resilience
// datapoint, not a scaling mandate.
//
// Env: SIM_BACKEND (default https://localhost:4001), SIM_AGENT_SECRET.
// Refuses any non-localhost backend unless --force (mirrors rebuild-db.sh) so a
// decrypted prod URL can never be load-blasted by accident.

const BACKEND = process.env.SIM_BACKEND || 'https://localhost:4001';
const SECRET = process.env.SIM_AGENT_SECRET || '';
const FORCE = process.argv.includes('--force');
const LEVELS = [5, 10, 20, 40];

// ── Safety guard: localhost only ──────────────────────────────────────────
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BACKEND);
if (!isLocal && !FORCE) {
  console.error(
    `REFUSING: SIM_BACKEND=${BACKEND} is not localhost. This fires dozens of ` +
      `concurrent bookings and would pollute + saturate a live DB. Pass --force ` +
      `only if you are certain this is a throwaway target.`
  );
  process.exit(1);
}
// Disable TLS verification ONLY for the local self-signed cert — never weaken
// TLS for a remote --force target.
if (isLocal) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// /agent-tools/* require x-agent-secret; without it every booking 401s and the
// run is meaningless. Warn loudly rather than report a wall of failures.
if (!SECRET) {
  console.error(
    'WARNING: SIM_AGENT_SECRET is empty — every /agent-tools/book call will 401. ' +
      "Set it to the backend's AGENT_SECRET, e.g. " +
      'SIM_AGENT_SECRET=$(grep ^AGENT_SECRET= .env | cut -d= -f2-) node scripts/sim-load.mjs'
  );
}

async function api(path, body, { auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers['x-agent-secret'] = SECRET;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const ms = performance.now() - t0;
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, ms };
  } catch (e) {
    return { status: 0, json: null, ms: performance.now() - t0, netErr: String(e?.message || e) };
  }
}

const CONFLICT = /TIMESLOT_OCCUPIED|NO_AVAILABILITY|EMPLOYEE_NOT_SCHEDULED|NO_SKILLED_EMPLOYEE/i;

// Classify one booking response into a bucket.
function bucket(r) {
  if (r.netErr) return 'neterr';
  if (r.status >= 500) return 'pool_or_5xx';
  if (r.json?.success) return 'success';
  // Stringify the whole body so error_code (e.g. NO_AVAILABILITY) is seen, not
  // just the human-readable error message.
  const err = JSON.stringify(r.json ?? '');
  if (CONFLICT.test(err)) return 'conflict';
  if (/timeout|connect|pool/i.test(err)) return 'pool_or_5xx';
  return 'other';
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]);
}

async function main() {
  console.log(`sim-load — booking-path failure-mode probe  (${BACKEND})`);

  // Use a supplied tenant (SIM_TENANT) or provision an isolated demo tenant.
  let TENANT = process.env.SIM_TENANT;
  if (TENANT) {
    console.log(`using supplied tenant ${TENANT.slice(0, 8)}…`);
  } else {
    const r = await api('/tutorial/start', {}, { auth: false });
    TENANT = r.json?.tenant_id;
    if (!TENANT) {
      console.error(`FAILED to provision demo tenant: ${r.status} ${JSON.stringify(r.json)}`);
      process.exit(1);
    }
    console.log(`demo tenant ${TENANT.slice(0, 8)}… provisioned`);
  }

  // Pick a real service from the tenant's catalog so the scheduling RPC does
  // real work regardless of which tenant we target.
  const cat = await api('/agent-tools/service-catalog', { tenant_id: TENANT });
  const svc = cat.json?.result?.services?.[0]?.name ?? cat.json?.result?.[0]?.name ?? 'Oil Change';
  console.log(`service: "${svc}"\n`);

  // Wide window (contention wanted): tomorrow 14:00Z spanning a week.
  const winFrom = new Date(Date.now() + 86400_000);
  winFrom.setUTCHours(14, 0, 0, 0);
  const winTo = new Date(winFrom.getTime() + 7 * 86400_000);
  const window = { from: winFrom.toISOString(), to: winTo.toISOString() };

  const bookOnce = (i) =>
    api('/agent-tools/book-with-scheduling', {
      tenant_id: TENANT,
      phone: `+1630${String(1000000 + i).slice(-7)}`,
      name: `Load ${i}`,
      description: 'load probe',
      call_id: `load-${Date.now()}-${i}`,
      requirements: { serviceType: svc },
      window,
    });

  // Warm-up (also confirms the path works before measuring).
  const warm = await bookOnce(0);
  console.log(`warm-up booking: ${bucket(warm)} (${Math.round(warm.ms)}ms)\n`);

  console.log('conc | success conflict pool/5xx other net | p50    p95    p99   | req/s');
  console.log('-----+-------------------------------------+----------------------+------');
  let verdict = 'clean fail-fast';
  let seq = 1;
  for (const n of LEVELS) {
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: n }, () => bookOnce(seq++)));
    const wall = (performance.now() - t0) / 1000;
    const b = { success: 0, conflict: 0, pool_or_5xx: 0, other: 0, neterr: 0 };
    for (const r of results) b[bucket(r)]++;
    if (process.env.SIM_LOAD_DEBUG) {
      const sample = results.find((r) => bucket(r) === 'other');
      if (sample) console.error('  [debug other] ', JSON.stringify(sample.json));
    }
    const lat = results.map((r) => r.ms).sort((a, z) => a - z);
    const p99 = pct(lat, 99);
    console.log(
      `${String(n).padStart(4)} | ${String(b.success).padStart(7)} ${String(b.conflict).padStart(8)} ` +
        `${String(b.pool_or_5xx).padStart(8)} ${String(b.other).padStart(5)} ${String(b.neterr).padStart(3)} | ` +
        `${String(pct(lat, 50)).padStart(5)}  ${String(pct(lat, 95)).padStart(5)}  ${String(p99).padStart(5)} | ` +
        `${(n / wall).toFixed(1)}`
    );
    // Failure-mode signal: under heavy concurrency, errors should arrive at or
    // below the ~5s checkout timeout (fail-fast), not hang far beyond it.
    if (b.neterr > 0) verdict = 'NET ERRORS — clients saw dropped/hung connections';
    else if (b.pool_or_5xx > 0 && p99 > 12000)
      verdict = 'SLOW FAILURES — errors arrived well past the 5s checkout cap (investigate)';
  }

  console.log(`\nfailure mode: ${verdict}`);
  console.log(
    'NOTE: latency/throughput are LOCAL (dev box + docker Postgres) — do NOT size ' +
      'prod off these numbers; the transferable result is the failure MODE above.'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
