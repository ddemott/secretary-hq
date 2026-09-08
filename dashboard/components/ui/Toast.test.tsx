import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { ToastContainer, showToast } from './Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastContainer — Dismiss all button', () => {
  test('HAPPY: ≤2 toasts → no Dismiss all button', async () => {
    // WHO: user with 1-2 notifications
    // WHAT: "Dismiss all" button not shown
    // WHEN: toast count is at or below the threshold
    // WHERE: ToastContainer header area
    // WHY: button is unnecessary noise when there are only 1-2 toasts
    render(<ToastContainer />);
    act(() => {
      showToast('First error', 'error');
      showToast('Second error', 'error');
    });
    expect(screen.getByText('First error')).toBeInTheDocument();
    expect(screen.getByText('Second error')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss all/i })).not.toBeInTheDocument();
  });

  test('HAPPY: >2 toasts → Dismiss all button appears', async () => {
    // WHO: user with 3+ stacked error notifications
    // WHAT: "Dismiss all" button renders above the stack
    // WHEN: toast count exceeds 2
    // WHERE: ToastContainer header row
    // WHY: a dense error stack is unusable without a single-tap escape
    render(<ToastContainer />);
    act(() => {
      showToast('Error 1', 'error');
      showToast('Error 2', 'error');
      showToast('Error 3', 'error');
    });
    expect(screen.getByRole('button', { name: /dismiss all/i })).toBeInTheDocument();
  });

  test('HAPPY: clicking Dismiss all removes every toast', async () => {
    // WHO: user with 3 stacked errors wanting to clear everything
    // WHAT: all toasts gone after one click; button disappears too
    // WHEN: clicking the Dismiss all button
    // WHERE: ToastContainer
    // WHY: pins the core utility — one action clears the entire stack
    render(<ToastContainer />);
    act(() => {
      showToast('Error A', 'error');
      showToast('Error B', 'error');
      showToast('Error C', 'error');
    });
    const btn = screen.getByRole('button', { name: /dismiss all/i });
    fireEvent.click(btn);
    expect(screen.queryByText('Error A')).not.toBeInTheDocument();
    expect(screen.queryByText('Error B')).not.toBeInTheDocument();
    expect(screen.queryByText('Error C')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss all/i })).not.toBeInTheDocument();
  });

  test('HAPPY: adding a 3rd toast to existing 2 makes button appear', async () => {
    // WHO: user who already had 2 errors and gets a third
    // WHAT: button appears reactively when count crosses the threshold
    // WHEN: third toast is added
    // WHERE: ToastContainer
    // WHY: button visibility is driven by live count, not initial render
    render(<ToastContainer />);
    act(() => {
      showToast('E1', 'error');
      showToast('E2', 'error');
    });
    expect(screen.queryByRole('button', { name: /dismiss all/i })).not.toBeInTheDocument();
    act(() => {
      showToast('E3', 'error');
    });
    expect(screen.getByRole('button', { name: /dismiss all/i })).toBeInTheDocument();
  });
});

describe('ToastContainer — auto-dismiss', () => {
  test('HAPPY: success toast dismisses after 3s', () => {
    // WHO: user who just saved a record
    // WHAT: success toast auto-disappears after 3000ms
    // WHY: success confirmations are transient — they must not pile up
    render(<ToastContainer />);
    act(() => {
      showToast('Saved!', 'success');
    });
    expect(screen.getByText('Saved!')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  test('SAD: error toast does NOT auto-dismiss', () => {
    // WHO: user who encountered an error
    // WHAT: error toast stays until explicitly dismissed
    // WHY: errors carry diagnostic info the user must be able to read
    render(<ToastContainer />);
    act(() => {
      showToast('Something broke', 'error');
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    }); // 30s — well past any auto-dismiss
    expect(screen.getByText('Something broke')).toBeInTheDocument();
  });

  test('HAPPY: warning toast dismisses after 5s', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('Low storage', 'warning');
    });
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText('Low storage')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    }); // cross the 5000ms boundary
    expect(screen.queryByText('Low storage')).not.toBeInTheDocument();
  });
});

describe('ToastContainer — individual dismiss', () => {
  test('HAPPY: clicking the X removes just that toast', () => {
    // WHO: user who wants to clear one toast but keep another
    // WHAT: clicking the dismiss button removes only that toast
    render(<ToastContainer />);
    act(() => {
      showToast('Keep me', 'error');
      showToast('Remove me', 'error');
    });
    const dismissButtons = screen.getAllByRole('button', { name: /dismiss notification/i });
    // Second "Remove me" button
    fireEvent.click(dismissButtons[1]);
    expect(screen.queryByText('Remove me')).not.toBeInTheDocument();
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });
});

describe('ToastContainer — action button', () => {
  test('HAPPY: action button label appears and calls the callback on click', () => {
    // WHO: user who just cancelled an appointment
    // WHAT: an Undo action is shown; clicking it fires the callback and removes the toast
    const onUndo = vi.fn();
    render(<ToastContainer />);
    act(() => {
      showToast('Appointment cancelled', 'success', { label: 'Undo', onClick: onUndo });
    });
    const undoBtn = screen.getByRole('button', { name: /undo/i });
    expect(undoBtn).toBeInTheDocument();
    fireEvent.click(undoBtn);
    expect(onUndo).toHaveBeenCalledTimes(1);
    // Toast dismissed on action click
    expect(screen.queryByText('Appointment cancelled')).not.toBeInTheDocument();
  });

  test('HAPPY: action toast lives longer than standard success (5s vs 3s)', () => {
    // WHO: user who needs time to notice and click Undo
    // WHY: standard success lasts 3s; action toasts need 5s for usability
    render(<ToastContainer />);
    act(() => {
      showToast('Done', 'success', { label: 'Undo', onClick: vi.fn() });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    }); // standard success would be gone
    expect(screen.getByText('Done')).toBeInTheDocument(); // still there at 3s
    act(() => {
      vi.advanceTimersByTime(2000);
    }); // now at 5s
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
});

describe('ToastContainer — MAX_TOASTS cap', () => {
  test('HAPPY: capped at 5 — 6th toast evicts the oldest', () => {
    // WHO: system firing many rapid notifications
    // WHAT: container never exceeds 5 toasts; the oldest is evicted
    render(<ToastContainer />);
    act(() => {
      for (let i = 1; i <= 6; i++) showToast(`Error ${i}`, 'error');
    });
    // Toast 1 is evicted; toasts 2–6 remain
    expect(screen.queryByText('Error 1')).not.toBeInTheDocument();
    expect(screen.getByText('Error 6')).toBeInTheDocument();
  });
});

describe('ToastContainer — ARIA', () => {
  test('HAPPY: error toast renders with role=alert', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('Critical failure', 'error');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Critical failure');
  });

  test('HAPPY: success toast renders with role=status', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('Saved successfully', 'success');
    });
    // role=status for non-errors; queryAllByRole because there may be multiple
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => el.textContent?.includes('Saved successfully'))).toBe(true);
  });
});
