'use client';

import React from 'react';
import { User, Settings, Keyboard, LogOut, Compass } from 'lucide-react';

interface ProfileMenuDropdownProps {
  userName: string | null | undefined;
  anchorRect: DOMRect | null;
  activeTab: string;
  onClose: () => void;
  onSelectTab: (tab: string) => void;
  onShowShortcuts?: () => void;
  onStartTour?: () => void;
  onLogout?: () => void;
}

export function ProfileMenuDropdown({
  userName,
  anchorRect,
  activeTab,
  onClose,
  onSelectTab,
  onShowShortcuts,
  onStartTour,
  onLogout,
}: ProfileMenuDropdownProps) {
  return (
    <>
      <div className="fixed inset-0 z-[99]" onClick={onClose} />
      <div
        className="fixed z-[100] w-56 rounded-xl shadow-2xl border overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-raised)',
          borderColor: 'var(--border-soft)',
          top: anchorRect ? anchorRect.bottom + 4 : 0,
          right: 16,
        }}
      >
        <div
          className="px-4 py-3 border-b"
          style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
        >
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            {userName || 'User'}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Signed in
          </div>
        </div>
        <div className="py-1">
          <button
            onClick={() => {
              onSelectTab('profile');
              onClose();
            }}
            className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors hover:brightness-125"
            style={{
              color: 'var(--text-primary)',
              backgroundColor: activeTab === 'profile' ? 'var(--accent-muted)' : 'transparent',
            }}
          >
            <User className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
            My Profile
          </button>
          <button
            onClick={() => {
              onSelectTab('setup');
              onClose();
            }}
            className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors hover:brightness-125"
            style={{
              color: 'var(--text-primary)',
              backgroundColor: activeTab === 'setup' ? 'var(--accent-muted)' : 'transparent',
            }}
          >
            <Settings className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
            Setup
          </button>
          {onShowShortcuts && (
            <button
              onClick={() => {
                onClose();
                onShowShortcuts();
              }}
              className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors hover:brightness-125"
              style={{ color: 'var(--text-primary)' }}
            >
              <Keyboard className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
              Keyboard shortcuts
            </button>
          )}
          {onStartTour && (
            <button
              onClick={() => {
                onClose();
                onStartTour();
              }}
              className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors hover:brightness-125"
              style={{ color: 'var(--text-primary)' }}
            >
              <Compass className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
              Take the product tour
            </button>
          )}
        </div>
        {onLogout && (
          <div className="border-t py-1" style={{ borderColor: 'var(--border-soft)' }}>
            <button
              onClick={() => {
                onClose();
                onLogout();
              }}
              className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors"
              style={{ color: 'var(--red)' }}
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>
        )}
      </div>
    </>
  );
}
