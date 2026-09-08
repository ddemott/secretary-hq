'use client';

import React, { useState } from 'react';
import { Api } from '../../lib/api';
import { downloadTextFile } from '../../lib/utils';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';

interface DataExportCardProps {
  tenantId: string | null;
}

export function DataExportCard({ tenantId }: DataExportCardProps) {
  const [exporting, setExporting] = useState(false);
  const [csvExporting, setCsvExporting] = useState<'appointments' | 'calls' | null>(null);

  async function handleExportData() {
    setExporting(true);
    try {
      const data = await Api.exportData.tenantData(tenantId);
      if (!data.success) {
        showToast('Failed to export your data', 'error');
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `secretaryhq-export-${data.generated_at?.slice(0, 10) ?? 'data'}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      showToast(`Exported ${data.total_records} records`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to export your data', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function handleExportCsv(kind: 'appointments' | 'calls') {
    setCsvExporting(kind);
    try {
      const csv = await Api.exportData.csv(kind, tenantId);
      downloadTextFile(
        `${kind}-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
        'text/csv;charset=utf-8'
      );
      showToast(`Exported your ${kind === 'calls' ? 'call history' : 'appointments'}.`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to export ${kind}`, 'error');
    } finally {
      setCsvExporting(null);
    }
  }

  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <h3 className="text-base font-semibold mb-1">Your data</h3>
      <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
        Download a complete copy of your business data — customers, appointments, staff, schedule,
        services, call history, knowledge base, and more — as a JSON file. Or export individual
        lists as spreadsheet-ready CSV files (the customer list exports from the Customers tab).
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isLoading={exporting} onClick={() => void handleExportData()}>
          Download my data
        </Button>
        <Button
          variant="secondary"
          isLoading={csvExporting === 'appointments'}
          onClick={() => void handleExportCsv('appointments')}
        >
          Export appointments (CSV)
        </Button>
        <Button
          variant="secondary"
          isLoading={csvExporting === 'calls'}
          onClick={() => void handleExportCsv('calls')}
        >
          Export calls (CSV)
        </Button>
      </div>
    </Card>
  );
}
