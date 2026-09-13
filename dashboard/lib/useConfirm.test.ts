/**
 * useConfirm — the shared confirmation-dialog state hook.
 *
 * WHO: every destructive-action button across the dashboard (cancel
 *   appointment, delete employee/resource/service, remove a mapping, etc.)
 *   — many components share this ONE hook for "are you sure?" state.
 * WHAT: confirm() opens the dialog with the caller's copy + callback;
 *   close() resets it; a second confirm() while one is already open
 *   REPLACES the pending action rather than stacking dialogs.
 * WHY: this hook has zero test coverage today despite being the single
 *   point every destructive action in the product funnels through — a
 *   regression here (stale onConfirm firing, defaults silently changing)
 *   would misfire a delete/cancel across the whole app at once.
 */
import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConfirm } from './useConfirm';

describe('useConfirm — initial state', () => {
  test('HAPPY: starts closed with safe empty defaults', () => {
    const { result } = renderHook(() => useConfirm());
    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.title).toBe('');
    expect(result.current.state.message).toBe('');
    expect(result.current.state.confirmLabel).toBe('Confirm');
    expect(result.current.state.confirmVariant).toBe('danger');
  });

  test('SAD: calling the default onConfirm before confirm() is ever invoked does not throw', () => {
    // WHO: a consumer that renders the confirm dialog unconditionally and
    //      wires its button straight to state.onConfirm
    // WHY: the INITIAL state's onConfirm is a no-op specifically so an
    //      accidental early call is harmless instead of a runtime crash
    const { result } = renderHook(() => useConfirm());
    expect(() => result.current.state.onConfirm()).not.toThrow();
  });
});

describe('useConfirm — confirm()', () => {
  test('HAPPY: opens with the given title/message/callback', () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({
        title: 'Delete employee?',
        message: 'This cannot be undone.',
        onConfirm,
      });
    });

    expect(result.current.state.isOpen).toBe(true);
    expect(result.current.state.title).toBe('Delete employee?');
    expect(result.current.state.message).toBe('This cannot be undone.');
    expect(result.current.state.onConfirm).toBe(onConfirm);
  });

  test('HAPPY: confirmLabel and confirmVariant default when omitted', () => {
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({ title: 'X', message: 'Y', onConfirm: vi.fn() });
    });

    expect(result.current.state.confirmLabel).toBe('Confirm');
    expect(result.current.state.confirmVariant).toBe('danger');
  });

  test('HAPPY: an explicit confirmLabel/confirmVariant overrides the default', () => {
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({
        title: 'Cancel appointment?',
        message: 'The slot will free up.',
        confirmLabel: 'Cancel appointment',
        confirmVariant: 'warning',
        onConfirm: vi.fn(),
      });
    });

    expect(result.current.state.confirmLabel).toBe('Cancel appointment');
    expect(result.current.state.confirmVariant).toBe('warning');
  });

  test('SAD: a second confirm() while one is open REPLACES the pending action, never stacks', () => {
    // WHO: a user who clicks two different delete buttons in quick succession
    //      before dismissing the first dialog (double-click, fast tab, etc.)
    // WHAT: the hook holds exactly ONE ConfirmState — the second confirm()
    //       call must fully overwrite the first, so confirming the dialog
    //       never fires the FIRST action against the SECOND item's copy
    // WHY: this is the one behavior every call site relies on implicitly
    //      and none of them test individually
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({ title: 'Delete A', message: 'first', onConfirm: firstAction });
    });
    act(() => {
      result.current.confirm({ title: 'Delete B', message: 'second', onConfirm: secondAction });
    });

    expect(result.current.state.title).toBe('Delete B');
    expect(result.current.state.onConfirm).toBe(secondAction);

    act(() => result.current.state.onConfirm());
    expect(secondAction).toHaveBeenCalledOnce();
    expect(firstAction).not.toHaveBeenCalled();
  });
});

describe('useConfirm — close()', () => {
  test('HAPPY: resets fully back to INITIAL, not just isOpen=false', () => {
    // WHO: the dialog's Cancel button / onClose handler
    // WHAT: close() must clear title/message/onConfirm too — leaving a
    //       stale onConfirm behind would let a LATER accidental call to
    //       state.onConfirm() (e.g. a lingering keyboard handler) fire the
    //       previous action after the dialog is supposedly gone
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({ title: 'Delete A', message: 'msg', onConfirm });
    });
    act(() => result.current.close());

    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.title).toBe('');
    expect(result.current.state.message).toBe('');
    expect(() => result.current.state.onConfirm()).not.toThrow();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
