/**
 * ThemeContext — unit coverage for context logic.
 *
 * WHO: Any dashboard user switching themes.
 * WHAT: ThemeProvider persists + applies theme; useTheme() exposes state.
 * WHERE: lib/ThemeContext.tsx — previously 9.52% coverage (THEMES array only).
 * WHY: Untested persistence logic means a regression in localStorage read/write
 *   would go undetected until a user reports their theme resetting on refresh.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { ThemeProvider, useTheme, THEMES } from './ThemeContext';
import type { ThemeId } from './ThemeContext';

function ThemeConsumer() {
  const { theme, themeInfo, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-id">{theme}</span>
      <span data-testid="theme-name">{themeInfo.name}</span>
      <button onClick={() => setTheme('rose')}>Set Rose</button>
      <button onClick={() => setTheme('forest')}>Set Forest</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
});

describe('THEMES constant', () => {
  test('contains all 8 themes with required fields', () => {
    // WHO: any code reading THEMES
    // WHAT: each entry must have id, name, description, preview.bg, preview.accent
    expect(THEMES).toHaveLength(8);
    for (const t of THEMES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.preview.bg).toMatch(/^#/);
      expect(t.preview.accent).toMatch(/^#/);
    }
  });

  test('navy is the first (default) theme', () => {
    expect(THEMES[0].id).toBe('navy');
  });
});

describe('ThemeProvider defaults', () => {
  test('HAPPY: defaults to navy when localStorage is empty', async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    const themeId = await screen.findByTestId('theme-id');
    expect(themeId.textContent).toBe('navy');
    expect(screen.getByTestId('theme-name').textContent).toBe('Navy');
  });

  test('HAPPY: adds dark class to documentElement after mount', async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    // Wait for mounted useEffect
    await screen.findByTestId('theme-id');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('HAPPY: sets data-theme attribute after mount', async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    await screen.findByTestId('theme-id');
    expect(document.documentElement.getAttribute('data-theme')).toBe('navy');
  });
});

describe('ThemeProvider localStorage persistence', () => {
  test('HAPPY: reads saved theme from localStorage on mount', async () => {
    localStorage.setItem('theme', 'forest');
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    const themeId = await screen.findByTestId('theme-id');
    // After mount effect runs, should switch to the saved value
    expect(themeId.textContent).toBe('forest');
    expect(screen.getByTestId('theme-name').textContent).toBe('Forest');
  });

  test('SAD: ignores unknown theme ids in localStorage and keeps default', async () => {
    // WHO: user with a corrupted/stale localStorage value
    // WHY: prevents crashing on unknown theme id
    localStorage.setItem('theme', 'neon-pink-does-not-exist' as ThemeId);
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    const themeId = await screen.findByTestId('theme-id');
    expect(themeId.textContent).toBe('navy');
  });
});

describe('setTheme()', () => {
  test('HAPPY: updates theme state and writes to localStorage', async () => {
    const { getByText } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    await screen.findByTestId('theme-id');
    act(() => {
      getByText('Set Rose').click();
    });
    expect(screen.getByTestId('theme-id').textContent).toBe('rose');
    expect(screen.getByTestId('theme-name').textContent).toBe('Rose');
    expect(localStorage.getItem('theme')).toBe('rose');
  });

  test('HAPPY: updates data-theme attribute when theme changes', async () => {
    const { getByText } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    await screen.findByTestId('theme-id');
    act(() => {
      getByText('Set Forest').click();
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('forest');
  });

  test('HAPPY: successive theme changes reflect the latest selection', async () => {
    const { getByText } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );
    await screen.findByTestId('theme-id');
    act(() => {
      getByText('Set Rose').click();
    });
    act(() => {
      getByText('Set Forest').click();
    });
    expect(screen.getByTestId('theme-id').textContent).toBe('forest');
    expect(localStorage.getItem('theme')).toBe('forest');
  });
});
