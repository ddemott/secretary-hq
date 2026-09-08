'use client';

import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export type ThemeId =
  'navy' | 'rose' | 'forest' | 'midnight' | 'nord' | 'sunset' | 'high-contrast' | 'solarized';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  preview: { bg: string; accent: string };
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'navy',
    name: 'Navy',
    description: 'Deep blue (default)',
    preview: { bg: '#090E1A', accent: '#2563EB' },
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'Warm plum',
    preview: { bg: '#160F14', accent: '#BE185D' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Deep earth greens',
    preview: { bg: '#0A110E', accent: '#16A34A' },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Discord-inspired',
    preview: { bg: '#0B0E14', accent: '#5865F2' },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic cool',
    preview: { bg: '#2E3440', accent: '#88C0D0' },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm amber',
    preview: { bg: '#1A1412', accent: '#E8914F' },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    description: 'Maximum readability',
    preview: { bg: '#000000', accent: '#FFD60A' },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: 'Classic developer',
    preview: { bg: '#002B36', accent: '#268BD2' },
  },
];

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  themeInfo: ThemeInfo;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'navy',
  setTheme: () => {},
  themeInfo: THEMES[0],
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>('navy');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('theme') as ThemeId | null;
    if (saved && THEMES.some((t) => t.id === saved)) {
      setThemeState(saved);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    // Set data-theme attribute for CSS variable overrides
    document.documentElement.setAttribute('data-theme', theme);

    // All themes are dark — always add dark class for Tailwind dark: prefixes
    document.documentElement.classList.add('dark');

    localStorage.setItem('theme', theme);
  }, [theme, mounted]);

  function setTheme(t: ThemeId) {
    setThemeState(t);
  }

  const themeInfo = THEMES.find((t) => t.id === theme) || THEMES[0];

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themeInfo }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
