/**
 * useFocusTrap — shared modal/panel/popover focus-management hook.
 *
 * WHO: every modal, side panel, and dismissible popover across the
 *   dashboard (8 components) share this ONE hook for focus trapping,
 *   Escape-to-close, Tab-wrap, and focus restoration.
 * WHAT: while isOpen, focus moves inside the container, Tab/Shift+Tab
 *   wrap at the container's edges instead of escaping to the page behind
 *   it, Escape fires the caller's close handler, and on close focus
 *   returns to whatever had it before the overlay opened.
 * WHY: zero test coverage today. A regression here — focus escaping the
 *   modal, Escape not firing, or focus NOT returning on close — is an
 *   accessibility break across every dialog in the product at once, and
 *   the kind of bug that only shows up under a screen reader or keyboard
 *   nav, never in a visual pass.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React, { useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';

function TestModal({
  isOpen,
  onEscape,
  lockScroll,
  onOutsideDismiss,
}: {
  isOpen: boolean;
  onEscape?: () => void;
  lockScroll?: boolean;
  onOutsideDismiss?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, isOpen, onEscape, lockScroll, onOutsideDismiss);
  if (!isOpen) return null;
  return (
    <div ref={ref} data-testid="modal">
      <button data-testid="first">First</button>
      <button data-testid="middle">Middle</button>
      <button data-testid="last">Last</button>
    </div>
  );
}

describe('useFocusTrap — initial focus', () => {
  test('HAPPY: moves focus to the first focusable child when opened', async () => {
    render(
      <div>
        <button data-testid="trigger">Open</button>
        <TestModal isOpen={true} />
      </div>
    );
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());
  });

  test('SAD: does NOT steal focus if autoFocus already placed it inside the container', async () => {
    // WHO: a modal whose form field uses <input autoFocus> to get focus first
    // WHAT: the hook must not override a focus target the caller already set
    // WHY: the "skip if already inside" branch (el.contains(activeElement))
    //      exists exactly to avoid fighting an intentional autoFocus
    function AutoFocusModal({ isOpen }: { isOpen: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, isOpen);
      if (!isOpen) return null;
      return (
        <div ref={ref} data-testid="modal">
          <button data-testid="first">First</button>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input data-testid="autofocused" autoFocus />
        </div>
      );
    }
    render(<AutoFocusModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('autofocused')).toHaveFocus());
  });
});

describe('useFocusTrap — Tab wrap', () => {
  test('HAPPY: Tab on the last element wraps to the first', async () => {
    render(<TestModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    screen.getByTestId('last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(screen.getByTestId('first')).toHaveFocus();
  });

  test('HAPPY: Shift+Tab on the first element wraps to the last', async () => {
    render(<TestModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(screen.getByTestId('last')).toHaveFocus();
  });

  test('HAPPY: Tab in the middle does not hijack focus (browser default applies)', async () => {
    render(<TestModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    screen.getByTestId('middle').focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    // Neither wrap branch fires for the middle element — focus is left where
    // it was for the browser's own Tab order to take over.
    expect(screen.getByTestId('middle')).toHaveFocus();
  });
});

describe('useFocusTrap — Escape', () => {
  test('HAPPY: Escape calls onEscape', async () => {
    const onEscape = vi.fn();
    render(<TestModal isOpen={true} onEscape={onEscape} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledOnce();
  });

  test('SAD: Escape with no onEscape provided does not throw', async () => {
    render(<TestModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());
    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
  });
});

describe('useFocusTrap — focus restoration on close', () => {
  test('HAPPY: focus returns to the element that had it before the trap opened', async () => {
    function Harness() {
      const [isOpen, setIsOpen] = React.useState(false);
      return (
        <div>
          <button data-testid="trigger" onClick={() => setIsOpen(true)}>
            Open
          </button>
          <TestModal isOpen={isOpen} onEscape={() => setIsOpen(false)} />
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('useFocusTrap — lockScroll', () => {
  test('HAPPY: locks body scroll while open and restores it on close', async () => {
    const { rerender } = render(<TestModal isOpen={true} lockScroll={true} />);
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));

    rerender(<TestModal isOpen={false} lockScroll={true} />);
    expect(document.body.style.overflow).toBe('unset');
  });

  test('HAPPY: does not touch body scroll when lockScroll is omitted', async () => {
    document.body.style.overflow = '';
    render(<TestModal isOpen={true} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });
});

describe('useFocusTrap — outside dismiss', () => {
  test('HAPPY: an outside mousedown calls onOutsideDismiss', async () => {
    const onOutsideDismiss = vi.fn();
    render(
      <div>
        <button data-testid="outside">Outside</button>
        <TestModal isOpen={true} onOutsideDismiss={onOutsideDismiss} />
      </div>
    );
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    // The listener attaches on the NEXT tick specifically so the opening
    // click itself can't immediately close the overlay — wait past that.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(onOutsideDismiss).toHaveBeenCalledOnce();
  });

  test('SAD: a mousedown INSIDE the container does not dismiss', async () => {
    const onOutsideDismiss = vi.fn();
    render(<TestModal isOpen={true} onOutsideDismiss={onOutsideDismiss} />);
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());

    await new Promise((r) => setTimeout(r, 0));
    fireEvent.mouseDown(screen.getByTestId('middle'));

    expect(onOutsideDismiss).not.toHaveBeenCalled();
  });

  test('SAD: without onOutsideDismiss, no mousedown listener is ever attached', async () => {
    // Copilot review, PR #437: the earlier version of this test only
    // asserted the click doesn't throw — that would pass even if a
    // listener WERE attached, since the handler uses optional chaining
    // on a callback that happens to be undefined. Spy on
    // addEventListener directly so this actually guards the omit-path.
    const addSpy = vi.spyOn(document, 'addEventListener');
    render(
      <div>
        <button data-testid="outside">Outside</button>
        <TestModal isOpen={true} />
      </div>
    );
    await waitFor(() => expect(screen.getByTestId('first')).toHaveFocus());
    await new Promise((r) => setTimeout(r, 0));

    expect(addSpy).not.toHaveBeenCalledWith('mousedown', expect.any(Function));
  });
});
