/**
 * E2E: inbound caller hears the agent. Not a constant pin — a room join.
 *
 * WHO: browser caller on /call-simulator (the no-PSTN inbound stand-in).
 * WHAT: after Start, this page joins LiveKit and must receive agent audio.
 * WHEN: 2026-08-14 — three sim joins, greeting live-streamed, 0 TTS frames,
 *       "no answer". A page-visible first-audio mark is the thing CI/human
 *       can fail on.
 * WHERE: GET /call-simulator + in-page LiveKit join.
 * WHY: asserting GREETING_POST_PICKUP_WAIT_MS === 0 stayed green while
 *      the line was silent. This spec fails if no remote audio arrives.
 */
import { test, expect } from './helpers/test';
import { BACKEND_URL } from './helpers/fixtures';
import {
  GREETING_POST_PICKUP_WAIT_MS,
  canWarmGreetingBeforePickup,
  greetingSpeakPath,
} from '../../agent/src/greetingPickup';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test.describe('inbound pickup — agent must make noise', () => {
  test('call-simulator is the browser inbound rig', async ({ page }) => {
    await page.goto(`${BACKEND_URL}/call-simulator`);
    await expect(page.getByRole('heading', { name: /Call your AI from browser/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Start call session/i })).toBeVisible();
  });

  test('pickup contract: cache if the frame exists', () => {
    expect(GREETING_POST_PICKUP_WAIT_MS).toBe(0);
    expect(greetingSpeakPath(true)).toBe('play_cache');
    expect(canWarmGreetingBeforePickup('d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0')).toBe(true);
  });

  test('agent publishes audio after the caller joins', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BACKEND_URL}/call-simulator`);
    await page.locator('#agent-name').fill(process.env.SIM_AGENT_NAME ?? 'secretary-hq-agent-dev');
    await page.getByRole('button', { name: /Start call session/i }).click();
    await page.getByRole('link', { name: /Open voice call/i }).click();
    const firstAudio = page.locator('[data-testid="first-audio"]');
    await expect(firstAudio, 'agent must publish audio — silent join is a fail').toBeVisible({
      timeout: 35_000,
    });
    const ms = Number(await firstAudio.textContent());
    expect(
      Number.isFinite(ms) && ms > 0,
      `first-audio ms should be a positive number, got ${ms}`
    ).toBe(true);

    // HANG UP. The assertion above is satisfied in ~3s, but before this the page
    // just sat in the room until the agent's silence watchdog gave up — so every
    // run of this spec burned a full ~45s call of LiveKit + Deepgram + OpenAI
    // usage after the useful part was over, and left a `no_caller_audio` warning
    // in the worker log whose `likely_layer: "stt"` accuses a healthy component
    // (the browser sends a fake tone, not speech, so STT is CORRECT to transcribe
    // nothing). Ending the call deliberately costs less and stops teaching
    // whoever reads those logs to ignore a real diagnostic.
    // Let the greeting FINISH before hanging up. Cutting it off mid-sentence
    // makes the agent's guarded say() log `greeting_say_failed: AgentSession is
    // not running` at error level on every run — a real event, but one nobody
    // asked for, and a recurring red herring teaches people to skim the log.
    //
    // The page marks this after a bounded grace period. It is a heuristic, and
    // the mark's own text says so; two attempts at a "real" signal (active
    // speakers, then a WebAudio analyser) were flaky and inert respectively.
    // See caller-simulator.html for what was tried and how each was disproved.
    await expect(
      page.getByTestId('agent-turn-done'),
      'the agent should be given its greeting turn before hangup'
    ).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('end-call').click();
    await expect(
      page.getByTestId('call-ended'),
      'hanging up must actually close the room, not just hide the button'
    ).toBeVisible({ timeout: 10_000 });
  });
});
