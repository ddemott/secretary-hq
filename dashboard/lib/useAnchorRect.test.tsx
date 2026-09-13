/**
 * useAnchorRect — keeps a floating menu anchored to its trigger element.
 *
 * WHO: OutlookLayout's tenant-switcher and profile dropdowns.
 * WHAT: tracks a ref'd element's bounding rect, re-publishing it on
 *   scroll/resize/ResizeObserver so the menu doesn't float in a stale
 *   position after the page moves under it.
 * WHY: zero test coverage today. This hook exists specifically to fix a
 *   real bug (UX audit 4.2 row 7 — getBoundingClientRect() computed once
 *   inline in JSX, so any scroll/resize left the menu stranded); a
 *   regression here silently reintroduces that exact bug with nothing to
 *   catch it.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React, { useRef } from 'react';
import { useAnchorRect } from './useAnchorRect';

let roCallback: (() => void) | undefined;

beforeEach(() => {
  roCallback = undefined;
  // jsdom does not implement ResizeObserver — stub it so the hook's
  // `typeof ResizeObserver !== 'undefined'` branch is exercised.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(ref, active);
  return (
    <div>
      <div ref={ref} data-testid="anchor" />
      <div data-testid="output">{rect ? `${rect.left},${rect.top}` : 'null'}</div>
    </div>
  );
}

describe('useAnchorRect — active gate', () => {
  test('SAD: returns null while inactive, even with a mounted ref', () => {
    const { getByTestId } = render(<Harness active={false} />);
    expect(getByTestId('output').textContent).toBe('null');
  });

  test('HAPPY: computes the rect once active', () => {
    const { getByTestId } = render(<Harness active={true} />);
    // jsdom's getBoundingClientRect returns all-zero rects by default —
    // the point is that it moved from 'null' to an actual rect string.
    expect(getByTestId('output').textContent).not.toBe('null');
  });

  test('HAPPY: flips back to null when active turns false again', () => {
    const { getByTestId, rerender } = render(<Harness active={true} />);
    expect(getByTestId('output').textContent).not.toBe('null');

    rerender(<Harness active={false} />);
    expect(getByTestId('output').textContent).toBe('null');
  });
});

describe('useAnchorRect — re-anchoring', () => {
  test('HAPPY: a scroll event re-publishes the rect', () => {
    const { getByTestId } = render(<Harness active={true} />);
    const anchor = getByTestId('anchor');
    const spy = vi.spyOn(anchor, 'getBoundingClientRect');

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(spy).toHaveBeenCalled();
  });

  test('HAPPY: a resize event re-publishes the rect', () => {
    const { getByTestId } = render(<Harness active={true} />);
    const anchor = getByTestId('anchor');
    const spy = vi.spyOn(anchor, 'getBoundingClientRect');

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(spy).toHaveBeenCalled();
  });

  test('HAPPY: a ResizeObserver callback re-publishes the rect (size change with no scroll/resize)', () => {
    const { getByTestId } = render(<Harness active={true} />);
    const anchor = getByTestId('anchor');
    const spy = vi.spyOn(anchor, 'getBoundingClientRect');

    // Simulate the observer firing — e.g. a sidebar collapse or font load
    // that changes the anchor's size with no window scroll/resize event.
    act(() => {
      roCallback?.();
    });

    expect(spy).toHaveBeenCalled();
  });
});

describe('useAnchorRect — cleanup', () => {
  test('SAD: listeners are removed on unmount (no stale updates after)', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Harness active={true} />);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  test('SAD: deactivating disconnects the ResizeObserver instance', () => {
    let disconnected = false;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = () => {
          disconnected = true;
        };
        unobserve = vi.fn();
      }
    );

    const { rerender } = render(<Harness active={true} />);
    expect(disconnected).toBe(false);

    rerender(<Harness active={false} />);
    expect(disconnected).toBe(true);
  });
});
