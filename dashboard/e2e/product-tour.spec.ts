/**
 * Product tour — real browser, real Tutorial tenant, real Driver.js.
 *
 * Proves the part the unit tests cannot: that every step's tab switch lands,
 * its target actually renders, and Driver.js spotlights THAT element (not its
 * centered fallback card) — then that the account menu replays it.
 */
import { test, expect, type Page } from '@playwright/test';
import { TOUR_STEPS } from '../lib/productTour';

const SHOTS = process.env.TOUR_SCREENSHOT_DIR;

async function expectStep(page: Page, index: number) {
  const step = TOUR_STEPS[index];
  const popover = page.locator('.driver-popover.shq-tour');
  await expect(popover.locator('.driver-popover-title')).toHaveText(step.title);
  await expect(popover.locator('.driver-popover-progress-text')).toHaveText(
    `${index + 1} of ${TOUR_STEPS.length}`
  );
  if (step.target) {
    // Driver.js marks the spotlighted element; a missing target would leave
    // only its zero-size #driver-dummy-element marked instead.
    await expect(page.locator(`${step.target}.driver-active-element`)).toBeVisible();
  }
  if (SHOTS) await page.waitForTimeout(500);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${String(index).padStart(2, '0')}-${step.id}.png` });
}

test.describe('product tour on the Tutorial', () => {
  test('HAPPY: auto-starts, walks every feature across tabs, finishes, and replays', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/tutorial');
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

    // Auto-start: the prospect did nothing but open the Tutorial.
    await expectStep(page, 0);

    for (let i = 1; i < TOUR_STEPS.length; i++) {
      await page.locator('.driver-popover-next-btn').click();
      await expectStep(page, i);
    }

    // Keyboard works the same path (ArrowLeft goes back a step, across a tab).
    // Driver.js ignores arrow keys while its 400 ms highlight animation runs.
    await page.waitForTimeout(600);
    await page.keyboard.press('ArrowLeft');
    await expectStep(page, TOUR_STEPS.length - 2);
    await page.waitForTimeout(600);
    await page.keyboard.press('ArrowRight');
    await expectStep(page, TOUR_STEPS.length - 1);

    await expect(page.locator('.driver-popover-next-btn')).toHaveText('Finish');
    await page.locator('.driver-popover-next-btn').click();
    await expect(page.locator('.driver-popover')).toHaveCount(0);
    await expect(page.locator('.driver-overlay')).toHaveCount(0);

    // Reload: seen once, it must not ambush the prospect again.
    await page.reload();
    await page.waitForTimeout(2000);
    await expect(page.locator('.driver-popover')).toHaveCount(0);

    // Replay from the account menu.
    await page.locator('[data-tour="account-menu"]').click();
    await page.getByRole('button', { name: 'Take the product tour' }).click();
    await expectStep(page, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.driver-popover')).toHaveCount(0);
  });
});
