/**
 * Speak the outage line NOW — ahead of the generation that is failing.
 *
 * WHY THIS IS NOT JUST `session.say()`. When the LLM is erroring, the reply the
 * SDK is generating is still the session's CURRENT speech, and the SDK keeps
 * retrying it (a 429 is "retryable" to it: 100ms, 2s, 2s). `say()` queues BEHIND
 * the current speech, so the outage line cannot play until the retries are spent.
 *
 * Measured (2026-09-18, real `AgentSession` against a local server that answers
 * 429 forever, see outagePlayback.test.ts): `say()` issued at +26ms finished
 * playing at +4142ms — the caller waits out every retry to hear that the call is
 * broken. With `interrupt({ force: true })` first, the same line finished at
 * +6ms. On the real call (SCL_MFD3o5QRKQJB) those seconds were filled by the
 * watchdog's hold lines, one of them offering to take a message.
 *
 * `force` is deliberate: a non-forced interrupt waits for the generation's own
 * tasks to wind down, and those tasks are sitting in the retry delay. The call
 * is ending regardless, so there is nothing worth being gentle with.
 */
import type { voice } from '@livekit/agents';

type SayOptions = Parameters<voice.AgentSession['say']>[1];

export async function speakOutageLine(
  session: voice.AgentSession,
  text: string,
  audio?: NonNullable<SayOptions>['audio']
): Promise<void> {
  try {
    // interrupt() returns LiveKit's Future<void, Error>, not a plain Promise —
    // .await is its real getter (see @livekit/agents utils.d.ts), not a typo.
    const interruption = session.interrupt({ force: true });
    await interruption.await;
  } catch {
    // Nothing playing, or the session is already closing — say() below still works.
  }
  const handle = audio ? session.say(text, { audio }) : session.say(text);
  await (handle as { waitForPlayout?: () => Promise<void> })?.waitForPlayout?.();
}
