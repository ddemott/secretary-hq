'use client';

import React from 'react';
import {
  Users,
  Columns3,
  List,
  Calendar,
  LayoutGrid,
  RefreshCw,
  Plus,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { SchedulerDateNav } from './SchedulerDateNav';
import type { SchedulerViewTab } from './SchedulerView';

type DayMode = 'staff' | 'resources' | 'list';

const ZOOM_LEVELS = [40, 60, 90, 120, 180];

interface SchedulerToolbarProps {
  activeView: SchedulerViewTab;
  dayMode: DayMode;
  selectedDate: Date;
  zoomIndex: number;
  hourWidth: number;
  loading: boolean;
  vocab: { employee_plural: string; resource_plural: string };
  tenantTimezone?: string;
  onViewChange: (view: SchedulerViewTab) => void;
  onDayModeChange: (mode: DayMode) => void;
  onDateChange: (date: Date) => void;
  onZoomChange: (index: number) => void;
  onRefresh: () => void;
  onNewQuickBook: () => void;
}

const tabActive = { backgroundColor: 'var(--accent)', color: 'var(--primary-text)' };

const tabCls = (active: boolean) =>
  `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition ${
    active ? '' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
  }`;

const dayModeCls = (active: boolean) =>
  `flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold transition ${
    active ? '' : 'text-gray-500 dark:text-gray-400 hover:brightness-110'
  }`;

export function SchedulerToolbar({
  activeView,
  dayMode,
  selectedDate,
  zoomIndex,
  hourWidth,
  loading,
  vocab,
  tenantTimezone,
  onViewChange,
  onDayModeChange,
  onDateChange,
  onZoomChange,
  onRefresh,
  onNewQuickBook,
}: SchedulerToolbarProps) {
  return (
    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#111] flex items-center justify-between gap-3 flex-wrap">
      {/* Left: top-level view tabs */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onViewChange('day')}
          className={tabCls(activeView === 'day')}
          style={activeView === 'day' ? tabActive : undefined}
          data-testid="view-tab-day"
        >
          <LayoutGrid className="w-4 h-4" />
          Day
        </button>
        <button
          onClick={() => onViewChange('calendar')}
          className={tabCls(activeView === 'calendar')}
          style={activeView === 'calendar' ? tabActive : undefined}
          data-testid="view-tab-calendar"
        >
          <Calendar className="w-4 h-4" />
          Calendar
        </button>
      </div>

      {/* Right: context-sensitive controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {activeView === 'day' && (
          <SchedulerDateNav
            selectedDate={selectedDate}
            onDateChange={onDateChange}
            tenantTimezone={tenantTimezone}
          />
        )}

        {activeView === 'day' && (
          <div
            className="flex items-center rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border-soft)' }}
            role="group"
            aria-label="Day view mode"
          >
            <button
              onClick={() => onDayModeChange('staff')}
              className={dayModeCls(dayMode === 'staff')}
              style={dayMode === 'staff' ? tabActive : undefined}
              data-testid="day-mode-staff"
            >
              <Users className="w-4 h-4" />
              <span className="hidden sm:inline">{vocab.employee_plural}</span>
            </button>
            <button
              onClick={() => onDayModeChange('resources')}
              className={dayModeCls(dayMode === 'resources')}
              style={dayMode === 'resources' ? tabActive : undefined}
              data-testid="day-mode-resources"
            >
              <Columns3 className="w-4 h-4" />
              <span className="hidden sm:inline">{vocab.resource_plural}</span>
            </button>
            <button
              onClick={() => onDayModeChange('list')}
              className={dayModeCls(dayMode === 'list')}
              style={dayMode === 'list' ? tabActive : undefined}
              data-testid="day-mode-list"
            >
              <List className="w-4 h-4" />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
        )}

        {activeView === 'day' && dayMode === 'resources' && (
          <div
            className="flex items-center gap-1 border rounded-lg overflow-hidden"
            style={{ borderColor: 'var(--border-soft)' }}
            role="group"
            aria-label={`Scheduler zoom · level ${zoomIndex + 1} of ${ZOOM_LEVELS.length} · ${hourWidth} pixels per hour`}
          >
            <button
              onClick={() => onZoomChange(Math.max(zoomIndex - 1, 0))}
              disabled={zoomIndex <= 0}
              className="p-1.5 hover:brightness-110 disabled:opacity-30 transition-colors"
              title="Zoom out"
              aria-label="Zoom out"
              style={{ color: 'var(--text-secondary)' }}
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span
              className="text-xs font-bold tabular-nums px-1 select-none whitespace-nowrap"
              style={{ color: 'var(--text-muted)' }}
              aria-hidden="true"
            >
              {zoomIndex + 1}/{ZOOM_LEVELS.length}
            </span>
            <button
              onClick={() => onZoomChange(Math.min(zoomIndex + 1, ZOOM_LEVELS.length - 1))}
              disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
              className="p-1.5 hover:brightness-110 disabled:opacity-30 transition-colors"
              title="Zoom in"
              aria-label="Zoom in"
              style={{ color: 'var(--text-secondary)' }}
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <Button size="sm" onClick={onNewQuickBook} data-testid="quick-book-trigger">
          <Plus className="w-4 h-4 mr-1" />
          Quick Book
        </Button>
      </div>
    </div>
  );
}
