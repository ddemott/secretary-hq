/**
 * THE RAG NO-ANSWER LINE IS A CONTRACT BETWEEN TWO PACKAGES.
 *
 * WHO: any caller who asks something the knowledge base cannot answer.
 * WHAT: `/agent-tools/policy-answer` returns `policyFallback` — a warm spoken
 *       sentence — for both zero retrieval hits and an embedding failure. The
 *       AGENT reads that sentence to decide the call must not end there: on
 *       seeing it, `answer_question` selects the message tree in host code so
 *       the goodbye gate holds the door until a message is actually taken.
 * WHEN: 2026-08-15. Rosa Delgado asked whether the owner would MC a wedding,
 *       the KB had nothing, and the agent read the fallback aloud, recorded a
 *       summary and hung up — name discarded, no number, no message. Nobody at
 *       the business would ever have learned she rang.
 * WHERE: `src/routes/agentTools/knowledge.ts` (the sentence) and
 *        `agent/src/checklist/checklistTools.ts` (`RAG_NO_ANSWER_MARKER`).
 * WHY THIS TEST: the two live in different packages with no shared import — the
 *       agent does not consume `shared/`. Matching prose across a package
 *       boundary is only safe if something fails loudly when one side is
 *       reworded. This is that something. If you change the sentence, change
 *       the marker in the same commit; if you want them decoupled properly,
 *       give the route a structured no-answer field and delete this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

/** Kept in sync by hand with agent/src/checklist/checklistTools.ts. */
const AGENT_MARKER = "I don't have that on hand";

describe('the RAG no-answer line the agent keys its take-a-message guarantee on', () => {
  it('the backend route still returns a fallback containing the exact agent marker', () => {
    const route = readFileSync(join(ROOT, 'src/routes/agentTools/knowledge.ts'), 'utf8');
    expect(
      route.includes(AGENT_MARKER),
      `src/routes/agentTools/knowledge.ts no longer contains the sentence the agent matches ` +
        `on (${AGENT_MARKER}). The agent's take-a-message guarantee for an unanswerable ` +
        `question is now DEAD — it will fail silently on a live call. Update ` +
        `RAG_NO_ANSWER_MARKER in agent/src/checklist/checklistTools.ts to match.`
    ).toBe(true);
  });

  it('the agent constant still holds the same sentence the route emits', () => {
    const agentFile = readFileSync(
      join(ROOT, 'agent/src/checklist/checklistTools.ts'),
      'utf8'
    );
    // The marker is declared as a string literal; both quote styles are fine.
    const declared =
      agentFile.includes(`export const RAG_NO_ANSWER_MARKER = "${AGENT_MARKER}"`) ||
      agentFile.includes(`export const RAG_NO_ANSWER_MARKER = '${AGENT_MARKER}'`);
    expect(
      declared,
      'RAG_NO_ANSWER_MARKER drifted from the sentence this test pins. Both sides must move together.'
    ).toBe(true);
  });

  it('SAD: the fallback is used for BOTH failure modes, not just zero hits', () => {
    // An embedding outage must degrade to the same sentence — otherwise a caller
    // hits the OpenAI-is-down path and the agent, seeing an unfamiliar string,
    // never offers the message.
    const route = readFileSync(join(ROOT, 'src/routes/agentTools/knowledge.ts'), 'utf8');
    const uses = route.split('ok(reply, policyFallback)').length - 1;
    expect(uses).toBeGreaterThanOrEqual(2);
  });
});
