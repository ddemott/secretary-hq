import React from 'react';
import { Plus, Edit, Trash2, RotateCcw, RefreshCw, Merge, Clock } from 'lucide-react';
import type { ChangeType, ChangeSource } from '../../lib/types';

export function formatChangeSource(source: ChangeSource): string {
  const labels: Record<ChangeSource, string> = {
    local: 'Manual Edit',
    square: 'Square Sync',
    voice_call: 'Voice Call',
    system: 'System',
    api: 'API',
  };
  return labels[source] || source;
}

export function formatChangeType(type: ChangeType): string {
  const labels: Record<ChangeType, string> = {
    create: 'Created',
    update: 'Updated',
    delete: 'Deleted',
    restore: 'Restored',
    sync: 'Synced',
    merge: 'Merged',
  };
  return labels[type] || type;
}

export function getChangeTypeIcon(type: ChangeType): React.ReactNode {
  const icons: Record<ChangeType, React.ReactNode> = {
    create: <Plus className="w-3 h-3" />,
    update: <Edit className="w-3 h-3" />,
    delete: <Trash2 className="w-3 h-3" />,
    restore: <RotateCcw className="w-3 h-3" />,
    sync: <RefreshCw className="w-3 h-3" />,
    merge: <Merge className="w-3 h-3" />,
  };
  return icons[type] || <Clock className="w-3 h-3" />;
}

export type ChangeTypeStyle = { backgroundColor: string; color: string };

/**
 * Theme-token-driven change-type badge colors. Each ChangeType maps to
 * a semantic CSS var defined per-theme in globals.css so the badge
 * reads correctly on every theme. Mapping rationale:
 * - create → success (new thing added)
 * - update → accent  (informational, neutral)
 * - delete → danger  (destructive)
 * - restore → success (undo of destructive — "back to good state")
 * - sync   → warning (procedural, system-initiated)
 * - merge  → accent  (informational)
 */
export function getChangeTypeStyle(type: ChangeType): ChangeTypeStyle {
  switch (type) {
    case 'create':
    case 'restore':
      return { backgroundColor: 'var(--success-bg)', color: 'var(--success)' };
    case 'update':
    case 'merge':
      return { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' };
    case 'delete':
      return { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' };
    case 'sync':
      return { backgroundColor: 'var(--warning-bg)', color: 'var(--warning)' };
    default:
      return { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' };
  }
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (days === 1) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (days < 7) {
    return `${days} days ago`;
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') {
    return value.length > 100 ? value.substring(0, 100) + '...' : value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const str = String(value);
    return str.length > 100 ? str.substring(0, 100) + '...' : str;
  }
  return '(invalid)';
}
