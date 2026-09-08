/**
 * Timeline layout constants and date/zoom utility functions for the shift
 * management views. Extracted from ShiftManagementView.tsx.
 */

export const HOURS = Array.from({ length: 24 }, (_, i) => i);
export const DEFAULT_COL_W = 72;
export const MIN_COL_W = 36;
export const MAX_COL_W = 140;
export const ZOOM_STEP = 16;
export const ROW_HEIGHT = 48;
export const HEADER_HEIGHT = 32;
export const DAY_LABEL_WIDTH = 120;
export const DEFAULT_OPEN_HOUR = 8;
export const DEFAULT_CLOSE_HOUR = 17;

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

export function formatWeekLabel(weekStart: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `Week of ${months[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()}`;
}

export function getZoomPercent(colW: number): number {
  return Math.round((colW / DEFAULT_COL_W) * 100);
}
