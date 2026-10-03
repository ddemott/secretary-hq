/**
 * ProfileMenuDropdown — the account menu's "Take the product tour" item is
 * how anyone replays the tour.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { ProfileMenuDropdown } from './ProfileMenuDropdown';

function renderMenu(extra: Partial<React.ComponentProps<typeof ProfileMenuDropdown>> = {}) {
  const props = {
    userName: 'Dale',
    anchorRect: null,
    activeTab: 'dashboard',
    onClose: vi.fn(),
    onSelectTab: vi.fn(),
    ...extra,
  };
  render(<ProfileMenuDropdown {...props} />);
  return props;
}

describe('ProfileMenuDropdown — product tour', () => {
  test('HAPPY: "Take the product tour" closes the menu, then starts the tour', () => {
    // WHAT: close first so the open menu is not left under the tour overlay.
    const order: string[] = [];
    const props = renderMenu({
      onClose: vi.fn(() => order.push('close')),
      onStartTour: vi.fn(() => order.push('tour')),
    });
    fireEvent.click(screen.getByRole('button', { name: /take the product tour/i }));
    expect(props.onStartTour).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close', 'tour']);
  });

  test('SAD: no onStartTour → no tour item', () => {
    // WHY: a menu item that does nothing is worse than no item.
    renderMenu();
    expect(screen.queryByRole('button', { name: /take the product tour/i })).toBeNull();
  });
});
