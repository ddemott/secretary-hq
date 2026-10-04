/**
 * Product tour — a guided spotlight walk through the dashboard, built on
 * Driver.js (MIT; Intro.js was ruled out because it is AGPL / paid).
 *
 * The tour both TEACHES (where each thing lives, what to do there) and SHOWS
 * OFF (what the AI receptionist does for the business). It auto-starts once
 * on the public Tutorial and can be replayed by any user from the account
 * menu; new owners are offered it from the first-run welcome card.
 *
 * Moving between steps crosses tabs, so each step names the PLACE its target
 * lives in. `goTo()` puts the dashboard there using the same channels the app
 * already listens to — `?tab=` + a popstate (dashboard page + every
 * useUrlQueryState view), the Setup sub-tab event, and the Calls sub-tab
 * event — so the tour never needs a handle on React state.
 *
 * Copy rule: say only what the product does TODAY. SMS is off until 10DLC,
 * so no step promises a text.
 */

import type { Driver, Config as DriverConfig } from 'driver.js';

export type TourTab = 'dashboard' | 'schedule' | 'customers' | 'calls' | 'setup' | 'ai-insights';

export type CallsSubTab = 'calls' | 'analytics' | 'messages' | 'sent';

export interface TourPlace {
  tab: TourTab;
  /** Setup sub-tab (`?subtab=`), e.g. 'services', 'business-settings', 'billing'. */
  subtab?: string;
  /** Phone Assistant sub-tab (`?aiTab=`). */
  aiTab?: 'persona' | 'knowledge';
  /** Calls sub-tab — local state in VoiceCallsView, driven by CALLS_SUBTAB_EVENT. */
  callsTab?: CallsSubTab;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector to spotlight. Omitted = a centered card. */
  target?: string;
  /** Where the dashboard must be for `target` to exist. */
  place?: TourPlace;
  /** Hidden from front-desk users, who cannot see Setup or Phone Assistant. */
  ownerOnly?: boolean;
}

export const TOUR_START_EVENT = 'secretary-hq:start-tour';
export const CALLS_SUBTAB_EVENT = 'secretary-hq:calls-subtab';
export const SETUP_SUBTAB_EVENT = 'secretary-hq:setup-subtab';

/** How long a step waits for its target to render after a tab switch. */
export const TARGET_WAIT_MS = 4000;
/**
 * After TARGET_WAIT_MS the step is shown anyway (a floating card beats a stuck
 * tour), but a target that mounts later, on a slow connection or a cold server,
 * still gets spotlighted: the tour keeps watching this long and re-anchors.
 */
export const LATE_TARGET_WAIT_MS = 20_000;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Secretary HQ',
    body:
      'Secretary HQ answers your business phone with an AI receptionist. It books appointments, ' +
      'takes messages, answers questions about your business, and puts callers through to a ' +
      'person when they ask. This short tour shows where everything lives. Use the arrow keys ' +
      'or the buttons; press Esc to leave at any time.',
  },
  {
    id: 'navigation',
    title: 'Getting around',
    body:
      'These tabs are the whole app. Home, Schedule, Customers and Calls are for running the ' +
      'day; Setup and Phone Assistant are where you shape the business and the receptionist.',
    target: '[role="tablist"][aria-label="Main navigation"]',
    place: { tab: 'dashboard' },
  },
  {
    id: 'home',
    title: 'Home: your day at a glance',
    body:
      "Today's appointments, whether your receptionist is live, and a snapshot of recent " +
      'calls. Start here each morning.',
    target: '[data-tour="home"]',
    place: { tab: 'dashboard' },
  },
  {
    id: 'schedule',
    title: 'Schedule',
    body:
      'Every booking lands here, whether the AI took it on the phone or you added it yourself. ' +
      'The AI only offers times when someone qualified is working and a room or bay is free, ' +
      'so it does not double-book.',
    target: '[data-testid="scheduler-view"]',
    place: { tab: 'schedule' },
  },
  {
    id: 'customers',
    title: 'Customers',
    body:
      'Every caller gets a profile automatically: name, number, visits and calls. The next ' +
      'time they call, the AI already knows who they are.',
    target: '#crm-customer-list',
    place: { tab: 'customers' },
  },
  {
    id: 'customer-preferences',
    title: 'What callers told the AI',
    body:
      'Open any customer to see what they mentioned on their calls: the car they drive, who ' +
      'they like to see, how they want to be reached. Nobody typed this in; the AI heard it ' +
      'and saved it.',
    target: '[data-tour="customer-preferences"]',
    place: { tab: 'customers' },
  },
  {
    id: 'calls',
    title: 'Every call, written down',
    body:
      'Each call is logged with a transcript, a short summary and what came of it: booked, ' +
      'message taken, or put through to a person. Filter by outcome to find what you need.',
    target: '[data-tour="call-list"]',
    place: { tab: 'calls', callsTab: 'calls' },
  },
  {
    id: 'call-analytics',
    title: 'Why people call',
    body:
      'Analytics show why callers reached out and what each call led to, so you can see what ' +
      'your phone line is worth to the business.',
    target: '[data-tour="call-analytics"]',
    place: { tab: 'calls', callsTab: 'analytics' },
  },
  {
    id: 'messages',
    title: 'Messages',
    body:
      'When a caller wants a call back, the AI takes their name, number and reason, and the ' +
      'message waits here for you.',
    target: '[data-tour="call-messages"]',
    place: { tab: 'calls', callsTab: 'messages' },
  },
  {
    id: 'go-live',
    title: 'Go live',
    body:
      'Get a local number for the receptionist, or forward your existing line to it. Place a ' +
      'test call before your customers reach it.',
    target: '[data-tour="go-live"]',
    place: { tab: 'ai-insights', aiTab: 'persona' },
    ownerOnly: true,
  },
  {
    id: 'forward-calls',
    title: 'Put callers through to a person',
    body:
      'Add a transfer number, and a caller who asks for a real person is put straight through ' +
      'to you or your team. Transfer is included on every plan.',
    target: '[data-tour="forward-calls"]',
    place: { tab: 'ai-insights', aiTab: 'persona' },
    ownerOnly: true,
  },
  {
    id: 'voice',
    title: 'Voice and style',
    body:
      'Pick the voice callers hear and how it speaks: warm, formal, cheerful or brief. It is ' +
      'your front desk, so make it sound like you.',
    target: '[data-tour="voice-identity"]',
    place: { tab: 'ai-insights', aiTab: 'persona' },
    ownerOnly: true,
  },
  {
    id: 'preferences',
    title: 'Remembering what callers like',
    body:
      'Choose whether the AI saves the preferences callers mention. It already knows what to ' +
      'listen for in your kind of business, and you can add your own.',
    target: '[data-tour="caller-preferences"]',
    place: { tab: 'ai-insights', aiTab: 'persona' },
    ownerOnly: true,
  },
  {
    id: 'knowledge',
    title: 'What your AI knows',
    body:
      'Add your policies, prices and common questions here. The AI answers callers from what ' +
      'you teach it, so the more you add, the fewer calls need you.',
    target: '[data-tour="knowledge"]',
    place: { tab: 'ai-insights', aiTab: 'knowledge' },
    ownerOnly: true,
  },
  {
    id: 'setup',
    title: 'Your business, as the AI sees it',
    body:
      'Services, staff, rooms or bays, shifts and skills. This is what the AI books against: ' +
      'who can do what, where, and when.',
    target: '[data-testid="setup-panel"]',
    place: { tab: 'setup', subtab: 'services' },
    ownerOnly: true,
  },
  {
    id: 'checklist',
    title: 'What every call asks',
    body:
      'Choose what the AI must find out before it books or takes a message. The preview shows ' +
      'exactly what your next call will ask.',
    target: '[data-testid="checklist-dry-run"]',
    place: { tab: 'setup', subtab: 'business-settings' },
    ownerOnly: true,
  },
  {
    id: 'billing',
    title: 'Plans and billing',
    body:
      "Pick a plan and watch this month's calls against its allowance. Calls past the " +
      'allowance are still answered, so a busy month never costs you a customer.',
    target: '[data-tour="billing"]',
    place: { tab: 'setup', subtab: 'billing' },
    ownerOnly: true,
  },
  {
    id: 'replay',
    title: 'That is the tour',
    body:
      'Replay it any time from your account menu. Everything you just saw is live: click ' +
      'around, book an appointment, or change the receptionist and see what it does.',
    target: '[data-tour="account-menu"]',
    place: { tab: 'dashboard' },
  },
];

/** Front-desk users only see Home, Schedule, Customers and Calls. */
export function stepsForRole(role: string | null | undefined): TourStep[] {
  if (role === 'front_desk') return TOUR_STEPS.filter((s) => !s.ownerOnly);
  return [...TOUR_STEPS];
}

/** localStorage key recording that a tenant's tour has been shown. */
export function tourSeenKey(tenantId: string): string {
  return `productTour_${tenantId}`;
}

/**
 * Auto-start only on the public Tutorial, once per Tutorial tenant. Real owners
 * are offered the tour from the first-run card instead of having it sprung on
 * them. Storage failures (private window, blocked site data) mean "don't
 * auto-start" — the tour stays reachable from the account menu.
 */
export function shouldAutoStart(tenantId: string | null, storage: Storage | undefined): boolean {
  if (!tenantId || !storage) return false;
  try {
    if (storage.getItem('tutorialTenantId') !== tenantId) return false;
    return storage.getItem(tourSeenKey(tenantId)) !== 'shown';
  } catch {
    return false;
  }
}

export function markTourSeen(tenantId: string | null, storage: Storage | undefined): void {
  if (!tenantId || !storage) return;
  try {
    storage.setItem(tourSeenKey(tenantId), 'shown');
  } catch {
    // Non-fatal: worst case the Tutorial tour auto-starts once more.
  }
}

/** Ask the mounted <ProductTour /> to start. Safe to call from anywhere. */
export function requestProductTour(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT));
}

/** Put the dashboard on the tab / sub-tab a step's target lives in. */
export function goTo(place: TourPlace): void {
  const url = new URL(window.location.href);
  const alreadyThere =
    url.searchParams.get('tab') === place.tab &&
    (place.subtab === undefined || url.searchParams.get('subtab') === place.subtab) &&
    (place.aiTab === undefined || url.searchParams.get('aiTab') === place.aiTab);
  if (!alreadyThere) {
    url.searchParams.set('tab', place.tab);
    if (place.subtab) url.searchParams.set('subtab', place.subtab);
    if (place.aiTab) url.searchParams.set('aiTab', place.aiTab);
    window.history.pushState({}, '', url.toString());
    // The dashboard page and every useUrlQueryState view re-read the URL on
    // popstate; pushState alone fires nothing.
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  // An already-mounted SetupView does not re-read ?subtab on popstate.
  if (place.subtab) {
    window.dispatchEvent(new CustomEvent(SETUP_SUBTAB_EVENT, { detail: { subtab: place.subtab } }));
  }
  if (place.callsTab) {
    window.dispatchEvent(
      new CustomEvent(CALLS_SUBTAB_EVENT, { detail: { subtab: place.callsTab } })
    );
  }
}

/**
 * Resolve once `selector` matches, or with null after `timeoutMs`. Tab
 * content mounts a render (and often a fetch) after goTo(); a step that
 * highlighted before its target existed would spotlight nothing.
 */
export function waitForElement(
  selector: string,
  timeoutMs: number = TARGET_WAIT_MS,
  intervalMs = 50
): Promise<Element | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

export type DriverFactory = (config: DriverConfig) => Driver;

export interface RunTourOptions {
  role?: string | null;
  /** Injected for tests; defaults to Driver.js, loaded on demand. */
  driverFactory?: DriverFactory;
  onFinish?: () => void;
  targetWaitMs?: number;
  /** How long to keep watching for a target that missed targetWaitMs. */
  lateTargetWaitMs?: number;
}

/**
 * Start the tour. Returns the Driver instance (for tests / teardown).
 * Driver.js is imported lazily so the dashboard bundle does not carry it for
 * users who never open the tour.
 */
export async function runProductTour(opts: RunTourOptions = {}): Promise<Driver> {
  const steps = stepsForRole(opts.role);
  const factory = opts.driverFactory ?? (await import('driver.js')).driver;
  const waitMs = opts.targetWaitMs ?? TARGET_WAIT_MS;
  const lateWaitMs = opts.lateTargetWaitMs ?? LATE_TARGET_WAIT_MS;
  let moving = false;
  /** Bumped on every step change and on destroy, so a stale late-anchor watcher stands down. */
  let stepToken = 0;

  const tour = factory({
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Finish',
    popoverClass: 'shq-tour',
    stagePadding: 6,
    stageRadius: 10,
    allowKeyboardControl: true,
    steps: steps.map((s) => ({
      element: s.target,
      popover: { title: s.title, description: s.body },
    })),
    onNextClick: () => void show((tour.getActiveIndex() ?? 0) + 1),
    onPrevClick: () => void show((tour.getActiveIndex() ?? 0) - 1),
    onDestroyed: () => {
      stepToken++;
      opts.onFinish?.();
    },
  });

  // Navigate first, wait for the target, THEN move — Driver.js would
  // otherwise measure a target that is still mounting.
  async function show(index: number): Promise<void> {
    if (moving) return;
    if (index >= steps.length) {
      tour.destroy();
      return;
    }
    if (index < 0) return;
    moving = true;
    try {
      const step = steps[index];
      const token = ++stepToken;
      if (step.place) goTo(step.place);
      const found = step.target ? await waitForElement(step.target, waitMs) : null;
      if (tour.isActive()) tour.moveTo(index);
      else tour.drive(index);
      // The target missed its window: the card is up, unanchored. Keep watching,
      // and spotlight the target if it does appear while this step is still showing.
      if (step.target && !found && lateWaitMs > 0) {
        void waitForElement(step.target, lateWaitMs).then((el) => {
          if (el && token === stepToken && tour.isActive() && tour.getActiveIndex() === index) {
            tour.moveTo(index);
          }
        });
      }
    } finally {
      moving = false;
    }
  }

  await show(0);
  return tour;
}
