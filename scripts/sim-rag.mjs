// sim-rag.mjs — RAG accuracy eval for the receptionist's knowledge base.
// Driven by scripts/simulate.sh `rag`.
//
// The receptionist answers caller questions from search_tenant_docs (pgvector
// cosine over the tenant KB) via /agent-tools/policy-answer. Nothing measured
// whether retrieval is actually accurate. This seeds a known KB into an
// ephemeral /demo/start tenant, then asks PARAPHRASED caller questions and
// checks the right content is retrieved — plus that a genuinely out-of-scope
// question correctly falls back ("I don't have that on hand...") instead
// of hallucinating a match. Reports a hit-rate; exits non-zero below threshold.
//
// Uses real OpenAI embeddings (+ normalization), so it's a true retrieval eval,
// not a mock. Env: SIM_BACKEND, SIM_AGENT_SECRET (server's). Needs OPENAI on the
// target backend for /knowledge/add + /agent-tools/policy-answer.

const BACKEND = process.env.SIM_BACKEND;
const SECRET = process.env.SIM_AGENT_SECRET || '';
const THRESHOLD = 0.8; // pass if >= 80% of cases are correct

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

if (!BACKEND) {
  console.error('sim-rag: SIM_BACKEND not set');
  process.exit(2);
}

// ── Known KB (what the business "knows") ─────────────────────────────────────
const KB = [
  { question: 'What are your business hours?', answer: 'We are open Monday through Friday from 8 AM to 5 PM, and we are closed on weekends.' },
  { question: 'How much does an oil change cost?', answer: 'A standard oil change is 49 dollars and 99 cents and takes about 45 minutes.' },
  { question: 'What is your cancellation policy?', answer: 'We ask for at least 24 hours notice if you need to cancel or reschedule an appointment.' },
  { question: 'Where are you located?', answer: 'We are located at 123 Main Street in downtown.' },
  { question: 'Do you offer tire rotation?', answer: 'Yes, we offer tire rotation for 29 dollars and 99 cents.' },
];

// ── Caller questions (PARAPHRASED) + what a correct retrieval must contain ───
// type 'kb' → answer content must include `expect`; type 'fallback' → must hit
// the no-match fallback (out-of-scope, should NOT retrieve a wrong doc).
const CASES = [
  { ask: 'when are you open?', type: 'kb', expect: /8 ?am|monday|5 ?pm/i },
  { ask: 'how much do you charge to change my oil', type: 'kb', expect: /49/ },
  { ask: 'what happens if I have to cancel last minute', type: 'kb', expect: /24 ?hours/i },
  // Vocabulary-gap case: "address" shares no words with the doc's "located".
  // Two phrasings — terse and polite — both must retrieve via query expansion
  // (regression guard for the 2026-06-12 address-gap fix).
  { ask: "what's your address", type: 'kb', expect: /main street|123/i },
  { ask: 'could you tell me your address?', type: 'kb', expect: /main street|123/i },
  { ask: 'can you rotate my tires', type: 'kb', expect: /rotation|29/i },
  // True out-of-scope — must fall back, NOT match a wrong doc. Widened beyond a
  // single negative so the lowered 0.30 threshold is validated against several
  // distinct out-of-scope topics, not tuned to one point.
  { ask: 'do you sell hamburgers', type: 'fallback', expect: null },
  { ask: 'can you fix my refrigerator', type: 'fallback', expect: null },
  { ask: 'what is your wifi password', type: 'fallback', expect: null },
];

const FALLBACK_MARK = /don'?t have specific information|take a message/i;

async function post(path, body, { auth = true, bearer = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers['x-agent-secret'] = SECRET;
  if (bearer) headers['authorization'] = `Bearer ${bearer}`;
  const res = await fetch(`${BACKEND}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  console.log(`${C.b}SecretaryHQ — RAG accuracy eval${C.x} ${C.d}(${BACKEND})${C.x}`);

  // 1. Ephemeral tenant + dashboard token (for /knowledge/add).
  const demo = await post('/demo/start', {}, { auth: false });
  const tenant = demo.json?.tenant_id;
  const token = demo.json?.token;
  if (!tenant || !token) {
    console.error(`  ${C.r}could not provision demo tenant: ${JSON.stringify(demo.json)}${C.x}`);
    process.exit(1);
  }
  console.log(`${C.d}  tenant ${tenant.slice(0, 8)}… · seeding ${KB.length} KB docs…${C.x}`);

  // 2. Seed the KB (real embeddings via /knowledge/add).
  for (const doc of KB) {
    const r = await post('/knowledge/add', { ...doc, category: 'faq', source: 'sim-rag' }, { auth: false, bearer: token });
    if (r.status !== 200 || r.json?.success === false) {
      console.error(`  ${C.r}KB seed failed (${r.status}): ${JSON.stringify(r.json)}${C.x}`);
      process.exit(1);
    }
  }

  // 3. Ask the paraphrased questions, grade retrieval.
  let correct = 0;
  for (const c of CASES) {
    const r = await post('/agent-tools/policy-answer', { tenant_id: tenant, question: c.ask });
    const answer = typeof r.json?.result === 'string' ? r.json.result : JSON.stringify(r.json?.result ?? '');
    let ok;
    if (c.type === 'fallback') {
      ok = FALLBACK_MARK.test(answer); // out-of-scope must fall back, not match a wrong doc
    } else {
      ok = c.expect.test(answer) && !FALLBACK_MARK.test(answer);
    }
    if (ok) correct++;
    const tag = ok ? `${C.g}[HIT] ${C.x}` : `${C.r}[MISS]${C.x}`;
    const why = c.type === 'fallback' ? 'should fall back (out-of-scope)' : `should contain ${c.expect}`;
    console.log(`  ${tag} "${c.ask}" ${C.d}— ${why}${C.x}`);
    if (!ok) console.log(`        ${C.d}got: ${answer.slice(0, 100).replace(/\n/g, ' ')}…${C.x}`);
  }

  const rate = correct / CASES.length;
  console.log('');
  const verdict = rate >= THRESHOLD ? `${C.g}PASS` : `${C.r}FAIL`;
  console.log(`${C.b}${verdict}${C.x} — RAG accuracy ${correct}/${CASES.length} (${Math.round(rate * 100)}%), threshold ${Math.round(THRESHOLD * 100)}%`);
  process.exit(rate >= THRESHOLD ? 0 : 1);
}

main().catch((e) => {
  console.error('sim-rag error:', e?.message ?? e);
  process.exit(1);
});
