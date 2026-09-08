'use client';

import React from 'react';

interface TabDef {
  id: string;
  label: string;
  icon: React.ElementType;
}

interface MobileTabBarProps {
  tabs: TabDef[];
  activeTab: string;
  unansweredCount: number;
  activeCallCount: number;
  onSelectTab: (tab: string) => void;
}

export function MobileTabBar({
  tabs,
  activeTab,
  unansweredCount,
  activeCallCount,
  onSelectTab,
}: MobileTabBarProps) {
  return (
    <nav
      aria-label="Mobile navigation"
      className="md:hidden flex flex-col border-t transition-colors duration-200 safe-area-pb"
      style={{ backgroundColor: 'var(--sidebar-bg)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex h-14 overflow-x-auto no-scrollbar border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className="relative flex-1 min-w-[64px] flex flex-col items-center justify-center shrink-0"
              style={
                activeTab === tab.id
                  ? { color: 'var(--accent-soft)' }
                  : { color: 'var(--text-muted)' }
              }
            >
              <Icon className="w-5 h-5" />
              <span className="text-[11px] mt-0.5 font-medium">{tab.label}</span>
              {tab.id === 'ai-insights' && unansweredCount > 0 && (
                <span
                  className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full text-[8px] font-bold leading-none"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
                >
                  {unansweredCount > 99 ? '99+' : unansweredCount}
                </span>
              )}
              {tab.id === 'calls' && activeCallCount > 0 && (
                <span
                  className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full text-[8px] font-bold leading-none animate-pulse"
                  style={{
                    backgroundColor: 'var(--danger, #dc2626)',
                    color: 'var(--primary-text)',
                  }}
                  aria-label={`${activeCallCount} active call${activeCallCount > 1 ? 's' : ''}`}
                >
                  {activeCallCount > 99 ? '99+' : activeCallCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
