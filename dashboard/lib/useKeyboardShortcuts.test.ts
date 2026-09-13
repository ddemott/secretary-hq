/**
 * useKeyboardShortcuts — global single-key and two-key-chord shortcuts.
 *
 * WHO: every page that registers "n" (new booking), "g h" (go home), "?"
 *   (help), etc. — the vimium-style navigation layer (UX audit #10).
 * WHAT: dispatches a keydown to a registered single-key or chord handler,
 *   suppresses everything but Escape while an editable element has focus,
 *   and ignores Ctrl/Cmd/Alt combos entirely (those stay native).
 * WHY: zero test coverage today despite real timing logic (a 750ms chord
 *   window) and a real safety rule (never hijack typing in a form field)
 *   that a naive refactor could silently break.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts, type Shortcut } from './useKeyboardShortcuts';

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useKeyboardShortcuts — single-key shortcuts', () => {
  test('HAPPY: a registered single key fires its run() and preventDefault()s', () => {
    const run = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', run, label: 'New booking' }];
    renderHook(() => useKeyboardShortcuts(shortcuts));

    const event = press('n');

    expect(run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  test('SAD: an unregistered key does nothing', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));

    press('z');

    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: matching is case-insensitive on registration but keys still dispatch by e.key', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'N', run, label: 'New booking' }]));

    press('n');

    expect(run).toHaveBeenCalledOnce();
  });
});

describe('useKeyboardShortcuts — Escape is never claimed', () => {
  test("SAD: Escape is ignored even when registered as a shortcut's key", () => {
    // WHO: a modal that wants ITS OWN escape handler to run, not this hook's
    // WHY: the hook deliberately never calls preventDefault on Escape so a
    //      focused element's own close-on-escape behavior still works
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'Escape', run, label: 'Close' }]));

    const event = press('Escape');

    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('useKeyboardShortcuts — editable-target suppression', () => {
  test('SAD: typing in an <input> suppresses shortcuts', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    document.body.removeChild(input);

    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: typing in a contenteditable element suppresses shortcuts', () => {
    // jsdom does not implement `isContentEditable` at all — it stays
    // `undefined` regardless of the contenteditable attribute/property
    // (a known, long-standing jsdom gap). Define it directly to simulate
    // what a real browser reports, so this test exercises the hook's own
    // `target.isContentEditable` check rather than jsdom's missing one.
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));

    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    document.body.removeChild(div);

    expect(run).not.toHaveBeenCalled();
  });

  test('HAPPY: a shortcut fires normally when nothing editable has focus', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));

    // event.target defaults to `document` when dispatched there directly —
    // exercises the isEditableTarget(document) => false path.
    press('n');

    expect(run).toHaveBeenCalledOnce();
  });
});

describe('useKeyboardShortcuts — modifier keys are ignored', () => {
  test('SAD: Ctrl+n does not fire the plain "n" shortcut', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));
    press('n', { ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: Cmd(meta)+n does not fire the plain "n" shortcut', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));
    press('n', { metaKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: Alt+n does not fire the plain "n" shortcut', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }]));
    press('n', { altKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts — chords', () => {
  test('HAPPY: "g" then "h" within the window fires the "g h" chord', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'g h', run, label: 'Go home' }]));

    press('g');
    press('h');

    expect(run).toHaveBeenCalledOnce();
  });

  test('SAD: "g" then "h" AFTER the 750ms window does not fire the chord', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'g h', run, label: 'Go home' }]));

    press('g');
    vi.advanceTimersByTime(800);
    press('h');

    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: a chord miss (unregistered second key) does not fire and does not throw', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'g h', run, label: 'Go home' }]));

    press('g');
    expect(() => press('z')).not.toThrow();

    expect(run).not.toHaveBeenCalled();
  });

  test('HAPPY: a chord miss falls through to a single-key match on the second keypress', () => {
    // WHO: a user pressing "g" (arming the "g h" chord) then "n" (registered
    //      standalone as "New booking", unrelated to any chord)
    // WHY: the comment above the dispatcher says "chord miss — fall through
    //      to single-key" explicitly; this pins that it actually does
    const goHome = vi.fn();
    const newBooking = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        { key: 'g h', run: goHome, label: 'Go home' },
        { key: 'n', run: newBooking, label: 'New booking' },
      ])
    );

    press('g');
    press('n');

    expect(goHome).not.toHaveBeenCalled();
    expect(newBooking).toHaveBeenCalledOnce();
  });

  test('SAD: two DIFFERENT chords sharing a head key resolve independently', () => {
    const goHome = vi.fn();
    const goSettings = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        { key: 'g h', run: goHome, label: 'Go home' },
        { key: 'g s', run: goSettings, label: 'Go settings' },
      ])
    );

    press('g');
    press('s');

    expect(goSettings).toHaveBeenCalledOnce();
    expect(goHome).not.toHaveBeenCalled();
  });

  test('KNOWN PRECEDENCE: a single-key registration for a chord-head key shadows the chord entirely', () => {
    // WHO: a caller who (perhaps by mistake) registers BOTH a single-key
    //      shortcut for "g" AND a chord "g h"
    // WHAT: the dispatcher checks singleKeys BEFORE arming the chord head,
    //       so the single-key "g" fires immediately and "g h" can never be
    //       reached — this is a real precedence rule of the current
    //       implementation, pinned here so a future change to the check
    //       order is a deliberate decision, not an accidental behavior
    //       change
    const gAlone = vi.fn();
    const goHome = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        { key: 'g', run: gAlone, label: 'G alone' },
        { key: 'g h', run: goHome, label: 'Go home' },
      ])
    );

    press('g');
    press('h');

    expect(gAlone).toHaveBeenCalledOnce();
    expect(goHome).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts — enabled flag and lifecycle', () => {
  test('SAD: enabled=false registers no listener at all', () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New booking' }], false));
    press('n');
    expect(run).not.toHaveBeenCalled();
  });

  test('SAD: an empty shortcuts array registers no listener', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useKeyboardShortcuts([]));
    unmount();
    // No listener was ever added for an empty list, so cleanup has nothing
    // keydown-related to remove.
    expect(removeSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  test('SAD: listener is removed on unmount — a shortcut never fires after', () => {
    const run = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts([{ key: 'n', run, label: 'New' }]));
    unmount();
    press('n');
    expect(run).not.toHaveBeenCalled();
  });

  test('HAPPY: re-rendering with a new shortcuts array re-registers the updated list', () => {
    const firstRun = vi.fn();
    const secondRun = vi.fn();
    const { rerender } = renderHook(
      ({ shortcuts }: { shortcuts: Shortcut[] }) => useKeyboardShortcuts(shortcuts),
      { initialProps: { shortcuts: [{ key: 'n', run: firstRun, label: 'First' }] } }
    );

    press('n');
    expect(firstRun).toHaveBeenCalledOnce();

    rerender({ shortcuts: [{ key: 'n', run: secondRun, label: 'Second' }] });
    press('n');

    expect(secondRun).toHaveBeenCalledOnce();
    expect(firstRun).toHaveBeenCalledOnce(); // still just the one call from before
  });
});
