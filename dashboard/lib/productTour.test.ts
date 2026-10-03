/**
 * Product tour — step list, navigation, auto-start gating, and the Driver.js
 * runner (with a fake Driver so the step logic is tested without an overlay).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config as DriverConfig, Driver } from 'driver.js';
import {
  CALLS_SUBTAB_EVENT,
  SETUP_SUBTAB_EVENT,
  TOUR_START_EVENT,
  TOUR_STEPS,
  goTo,
  markTourSeen,
  requestProductTour,
  runProductTour,
  shouldAutoStart,
  stepsForRole,
  tourSeenKey,
  waitForElement,
} from './productTour';

/** A stand-in Driver that records calls and exposes the config it was given. */
function fakeDriver() {
  let config: DriverConfig = {};
  let active = false;
  let index: number | undefined;
  const calls: string[] = [];
  const instance = {
    isActive: () => active,
    getActiveIndex: () => index,
    drive: (i = 0) => {
      active = true;
      index = i;
      calls.push(`drive:${i}`);
    },
    moveTo: (i: number) => {
      index = i;
      calls.push(`moveTo:${i}`);
    },
    destroy: () => {
      active = false;
      calls.push('destroy');
      config.onDestroyed?.(undefined, {}, {} as never);
    },
  } as unknown as Driver;
  const factory = (c: DriverConfig) => {
    config = c;
    return instance;
  };
  return {
    factory,
    calls,
    config: () => config,
    next: () => config.onNextClick?.(undefined, {}, {} as never),
    prev: () => config.onPrevClick?.(undefined, {}, {} as never),
  };
}

/** Let the runner's async show() settle (goTo + waitForElement + move). */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/dashboard');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TOUR_STEPS — content', () => {
  test('HAPPY: every step has a unique id, a title and a body', () => {
    // WHAT: the step list is the whole tour; a blank title or duplicate id
    //       would render an empty card or confuse the progress count.
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of TOUR_STEPS) {
      expect(s.title.trim()).not.toBe('');
      expect(s.body.trim().length).toBeGreaterThan(20);
    }
  });

  test('HAPPY: every spotlighted step names the place its target lives', () => {
    // WHY: without a place, the tour would highlight an element that is not
    //      mounted because the user is on a different tab.
    for (const s of TOUR_STEPS) {
      if (s.target) expect(s.place, s.id).toBeDefined();
    }
  });

  test('HAPPY: the tour covers every main area of the product', () => {
    // WHAT: "teach a person and show off all the features" — each area the
    //       owner works in must appear at least once.
    const tabs = new Set(TOUR_STEPS.map((s) => s.place?.tab).filter(Boolean));
    for (const tab of ['dashboard', 'schedule', 'customers', 'calls', 'setup', 'ai-insights']) {
      expect(tabs.has(tab as never), tab).toBe(true);
    }
  });

  test('SAD: no step promises a text message while SMS is off', () => {
    // WHY: SMS is disabled until 10DLC registration; the product must not
    //      promise what it cannot do (CLAUDE.md, Architecture → SMS is OFF).
    for (const s of TOUR_STEPS) {
      expect(`${s.title} ${s.body}`).not.toMatch(/\b(text|texts|sms|texting)\b/i);
    }
  });

  test('HAPPY: the tour opens with a centered welcome and ends on the replay button', () => {
    expect(TOUR_STEPS[0].target).toBeUndefined();
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].target).toBe('[data-tour="account-menu"]');
  });
});

describe('stepsForRole', () => {
  test('HAPPY: owners get every step', () => {
    expect(stepsForRole('owner')).toHaveLength(TOUR_STEPS.length);
    expect(stepsForRole(undefined)).toHaveLength(TOUR_STEPS.length);
  });

  test('SAD: front desk never sees Setup or Phone Assistant steps', () => {
    // WHO: front-desk users only have Home, Schedule, Customers, Calls.
    // WHY: a step on a hidden tab would spotlight nothing and navigate to a
    //      tab they are not allowed to open.
    const steps = stepsForRole('front_desk');
    expect(steps.length).toBeLessThan(TOUR_STEPS.length);
    for (const s of steps) {
      expect(['setup', 'ai-insights']).not.toContain(s.place?.tab);
    }
  });
});

describe('auto-start gating', () => {
  test('HAPPY: the Tutorial tenant auto-starts once', () => {
    localStorage.setItem('tutorialTenantId', 'tutorial-1');
    expect(shouldAutoStart('tutorial-1', localStorage)).toBe(true);
    markTourSeen('tutorial-1', localStorage);
    expect(localStorage.getItem(tourSeenKey('tutorial-1'))).toBe('shown');
    expect(shouldAutoStart('tutorial-1', localStorage)).toBe(false);
  });

  test('SAD: a real tenant never gets the tour sprung on it', () => {
    // WHY: real owners are offered it from the first-run card instead.
    expect(shouldAutoStart('tenant-real', localStorage)).toBe(false);
    localStorage.setItem('tutorialTenantId', 'some-other-tutorial');
    expect(shouldAutoStart('tenant-real', localStorage)).toBe(false);
  });

  test('SAD: no tenant or no storage means no auto-start', () => {
    expect(shouldAutoStart(null, localStorage)).toBe(false);
    expect(shouldAutoStart('tutorial-1', undefined)).toBe(false);
  });

  test('SAD: storage that throws (private window) means no auto-start and no crash', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    expect(shouldAutoStart('tutorial-1', broken)).toBe(false);
    expect(() => markTourSeen('tutorial-1', broken)).not.toThrow();
  });
});

describe('requestProductTour', () => {
  test('HAPPY: dispatches the start event', () => {
    const seen = vi.fn();
    window.addEventListener(TOUR_START_EVENT, seen);
    requestProductTour();
    window.removeEventListener(TOUR_START_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('goTo', () => {
  test('HAPPY: writes tab + sub-tabs to the URL and fires popstate', () => {
    // WHAT: the dashboard page and useUrlQueryState views re-read the URL on
    //       popstate; pushState alone would change the address bar only.
    const pop = vi.fn();
    window.addEventListener('popstate', pop);
    goTo({ tab: 'ai-insights', aiTab: 'knowledge' });
    window.removeEventListener('popstate', pop);
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('ai-insights');
    expect(params.get('aiTab')).toBe('knowledge');
    expect(pop).toHaveBeenCalledTimes(1);
  });

  test('HAPPY: a Setup sub-tab also fires the setup-subtab event', () => {
    // WHY: an already-mounted SetupView does not re-read ?subtab on popstate.
    const sub = vi.fn();
    window.addEventListener(SETUP_SUBTAB_EVENT, sub);
    goTo({ tab: 'setup', subtab: 'billing' });
    window.removeEventListener(SETUP_SUBTAB_EVENT, sub);
    expect(new URLSearchParams(window.location.search).get('subtab')).toBe('billing');
    expect((sub.mock.calls[0][0] as CustomEvent).detail).toEqual({ subtab: 'billing' });
  });

  test('HAPPY: a Calls sub-tab fires the calls-subtab event', () => {
    const sub = vi.fn();
    window.addEventListener(CALLS_SUBTAB_EVENT, sub);
    goTo({ tab: 'calls', callsTab: 'analytics' });
    window.removeEventListener(CALLS_SUBTAB_EVENT, sub);
    expect((sub.mock.calls[0][0] as CustomEvent).detail).toEqual({ subtab: 'analytics' });
  });

  test('SAD: already on the place → no history entry and no popstate', () => {
    // WHY: stepping between two targets on the same tab must not stack
    //      history entries the Back button would have to walk through.
    goTo({ tab: 'calls' });
    const pop = vi.fn();
    const push = vi.spyOn(window.history, 'pushState');
    window.addEventListener('popstate', pop);
    goTo({ tab: 'calls' });
    window.removeEventListener('popstate', pop);
    expect(push).not.toHaveBeenCalled();
    expect(pop).not.toHaveBeenCalled();
  });
});

describe('waitForElement', () => {
  test('HAPPY: resolves with an element that is already there', async () => {
    document.body.innerHTML = '<div data-tour="x"></div>';
    await expect(waitForElement('[data-tour="x"]', 100)).resolves.not.toBeNull();
  });

  test('HAPPY: resolves once a late-mounting element appears', async () => {
    setTimeout(() => {
      document.body.innerHTML = '<div id="late"></div>';
    }, 30);
    const el = await waitForElement('#late', 1000, 10);
    expect(el?.id).toBe('late');
  });

  test('SAD: resolves null after the timeout instead of hanging', async () => {
    await expect(waitForElement('#never', 40, 10)).resolves.toBeNull();
  });
});

describe('runProductTour', () => {
  test('HAPPY: starts at the welcome step with the themed popover', async () => {
    const d = fakeDriver();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0 });
    expect(d.calls).toEqual(['drive:0']);
    const cfg = d.config();
    expect(cfg.popoverClass).toBe('shq-tour');
    expect(cfg.steps).toHaveLength(TOUR_STEPS.length);
    expect(cfg.steps?.[1].element).toBe(TOUR_STEPS[1].target);
  });

  test('HAPPY: Next navigates to the step’s tab BEFORE moving the spotlight', async () => {
    // WHAT: step 4 (schedule) lives on another tab. The runner must switch
    //       tabs first; Driver.js measures the target when it moves.
    const d = fakeDriver();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0 });
    const scheduleIndex = TOUR_STEPS.findIndex((s) => s.id === 'schedule');
    for (let i = 0; i < scheduleIndex; i++) {
      d.next();
      await settle();
    }
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('schedule');
    expect(d.calls.at(-1)).toBe(`moveTo:${scheduleIndex}`);
  });

  test('HAPPY: Back returns to the previous step', async () => {
    const d = fakeDriver();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0 });
    d.next();
    await settle();
    d.prev();
    await settle();
    expect(d.calls.slice(-2)).toEqual(['moveTo:1', 'moveTo:0']);
  });

  test('SAD: Back on the first step does nothing', async () => {
    const d = fakeDriver();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0 });
    d.prev();
    await settle();
    expect(d.calls).toEqual(['drive:0']);
  });

  test('HAPPY: Finish on the last step closes the tour and calls onFinish', async () => {
    const d = fakeDriver();
    const onFinish = vi.fn();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0, onFinish });
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      d.next();
      await settle();
    }
    expect(d.calls.at(-1)).toBe('destroy');
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  test('SAD: a double-click on Next advances one step, not two', async () => {
    // WHY: show() awaits the target; a second click in that window used to
    //      read the same active index and would skip a step once it landed.
    const d = fakeDriver();
    document.body.innerHTML = '';
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 40 });
    d.next();
    d.next();
    await new Promise((r) => setTimeout(r, 120));
    expect(d.calls.filter((c) => c.startsWith('moveTo'))).toEqual(['moveTo:1']);
  });

  test('HAPPY: front desk runs the shorter tour', async () => {
    const d = fakeDriver();
    await runProductTour({ driverFactory: d.factory, targetWaitMs: 0, role: 'front_desk' });
    expect(d.config().steps).toHaveLength(stepsForRole('front_desk').length);
  });

  test('HAPPY: without an injected factory it loads the real Driver.js', async () => {
    // WHAT: proves the lazy import resolves and the real library accepts our
    //       config (a renamed option would surface here, not in production).
    const tour = await runProductTour({ targetWaitMs: 0 });
    expect(tour.isActive()).toBe(true);
    expect(tour.getActiveIndex()).toBe(0);
    expect(document.querySelector('.driver-popover.shq-tour')).not.toBeNull();
    tour.destroy();
    expect(tour.isActive()).toBe(false);
  });
});
