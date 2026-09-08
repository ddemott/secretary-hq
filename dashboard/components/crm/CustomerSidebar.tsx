'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Search, RefreshCw, UserPlus, Download, Upload } from 'lucide-react';
import { type Customer } from '@/lib/types';
import { downloadTextFile } from '../../lib/utils';
import { Api } from '../../lib/api';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { showToast } from '../ui/Toast';
import { useConfirm } from '../../lib/useConfirm';
import { ConfirmModal } from '../ui/ConfirmModal';
import { CustomerListItem } from './CustomerListItem';

interface CustomerSidebarProps {
  customers: Customer[];
  selectedCustomer: Customer | null;
  loading: boolean;
  isOwner: boolean;
  tenantId: string | null;
  showDetailOnMobile: boolean;
  onSelectCustomer: (customer: Customer) => void;
  onAddCustomer: () => void;
  onRefresh: () => void;
  onImportDone: () => void;
}

export function CustomerSidebar({
  customers,
  selectedCustomer,
  loading,
  isOwner,
  tenantId,
  showDetailOnMobile,
  onSelectCustomer,
  onAddCustomer,
  onRefresh,
  onImportDone,
}: CustomerSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const filteredCustomers = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const q = searchQuery.toLowerCase();
    return customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q)
    );
  }, [customers, searchQuery]);

  async function handleExportCsv() {
    setExportingCsv(true);
    try {
      const csv = await Api.exportData.csv('customers', tenantId);
      downloadTextFile(
        `customers-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
        'text/csv;charset=utf-8'
      );
      showToast('Customer list exported.', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to export customers.', 'error');
    } finally {
      setExportingCsv(false);
    }
  }

  function handleImportFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showToast('Could not read that file. Please try again.', 'error');
    reader.onload = () => {
      const csv = typeof reader.result === 'string' ? reader.result : '';
      if (!csv.trim()) {
        showToast('That file is empty.', 'error');
        return;
      }
      confirm({
        title: 'Import Customers',
        message: `Import customers from "${file.name}"? Rows with an invalid phone number are skipped, and customers whose phone number already exists are left unchanged.`,
        confirmLabel: 'Import',
        onConfirm: async () => {
          closeConfirm();
          setImportingCsv(true);
          try {
            const res = await Api.customers.importCsv(tenantId, csv);
            if (!res.success) {
              showToast(res.error || 'Import failed.', 'error');
              return;
            }
            showToast(
              `Imported ${res.imported} customer${res.imported === 1 ? '' : 's'}.`,
              'success'
            );
            const skipped = res.skipped_duplicates ?? 0;
            const errorRows = res.errors?.length ?? 0;
            if (skipped > 0 || errorRows > 0) {
              const parts: string[] = [];
              if (skipped > 0) parts.push(`${skipped} duplicate${skipped === 1 ? '' : 's'}`);
              if (errorRows > 0) {
                const first = res.errors[0];
                parts.push(
                  `${errorRows}${res.errors_truncated ? '+' : ''} invalid row${errorRows === 1 ? '' : 's'} (first: row ${first.row} — ${first.reason})`
                );
              }
              showToast(`Skipped ${parts.join('; ')}.`, 'warning');
            }
            onImportDone();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Import failed.', 'error');
          } finally {
            setImportingCsv(false);
          }
        },
      });
    };
    reader.readAsText(file);
  }

  return (
    <>
      <section
        className={`w-full md:w-80 flex flex-col ${showDetailOnMobile ? 'hidden md:flex' : 'flex'}`}
        style={{
          backgroundColor: 'var(--bg-raised)',
          borderRight: '1px solid var(--border-soft)',
        }}
      >
        <header
          className="p-4 sticky top-0 z-10"
          style={{
            borderBottom: '1px solid var(--border-soft)',
            backgroundColor: 'var(--bg-surface)',
          }}
        >
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold">Customers</h2>
            <div className="flex space-x-1">
              <Button onClick={onAddCustomer} size="sm" className="gap-2">
                <UserPlus className="w-4 h-4" />
                Add Customer
              </Button>
              <Button
                variant="ghost"
                onClick={onRefresh}
                size="sm"
                className="p-1.5"
                aria-label="Refresh customers"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          {isOwner && (
            <div className="flex space-x-1 mb-3">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                isLoading={exportingCsv}
                onClick={() => void handleExportCsv()}
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                Export CSV
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                isLoading={importingCsv}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-4 h-4" aria-hidden="true" />
                Import CSV
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                aria-label="Choose a CSV file of customers to import"
                onChange={handleImportFileChosen}
              />
            </div>
          )}
          <div className="relative">
            <Search
              className="w-4 h-4 absolute left-3 top-2.5"
              style={{ color: 'var(--text-muted)' }}
            />
            <input
              data-shortcut-target="search"
              type="text"
              placeholder="Search customers..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setFocusedIdx(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (filteredCustomers.length > 0) setFocusedIdx(0);
                } else if (e.key === 'Enter' && filteredCustomers.length > 0) {
                  e.preventDefault();
                  const first = filteredCustomers[0];
                  onSelectCustomer(first);
                }
              }}
              role="combobox"
              aria-expanded={filteredCustomers.length > 0}
              aria-controls="crm-customer-list"
              aria-activedescendant={
                focusedIdx >= 0
                  ? `crm-customer-row-${filteredCustomers[focusedIdx]?.customer_id}`
                  : undefined
              }
              className="w-full pl-9 pr-4 py-2 border-none rounded-md text-sm outline-none"
              style={{ backgroundColor: 'var(--bg-raised)', color: 'var(--text-primary)' }}
            />
          </div>
        </header>

        <div
          ref={listRef}
          id="crm-customer-list"
          role="listbox"
          aria-label="Customers"
          className="flex-1 overflow-y-auto pb-20 md:pb-0"
          onKeyDown={(e) => {
            if (filteredCustomers.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setFocusedIdx((i) => Math.min(i + 1, filteredCustomers.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setFocusedIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && focusedIdx >= 0) {
              e.preventDefault();
              const c = filteredCustomers[focusedIdx];
              if (c) onSelectCustomer(c);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setFocusedIdx(-1);
              document.querySelector<HTMLInputElement>('[data-shortcut-target="search"]')?.focus();
            }
          }}
        >
          {filteredCustomers.length === 0 && !loading && (
            <div className="p-6 text-center">
              {searchQuery ? (
                <EmptyState
                  icon={UserPlus}
                  title={`No customers match "${searchQuery}"`}
                  variant="compact"
                />
              ) : (
                <EmptyState
                  icon={UserPlus}
                  title="No customers yet"
                  description="Customers are added automatically when your AI handles calls. You can also add one manually."
                  variant="compact"
                  action={
                    <Button variant="primary" size="md" onClick={onAddCustomer}>
                      <UserPlus className="w-4 h-4 mr-1.5" aria-hidden="true" />
                      Add customer
                    </Button>
                  }
                />
              )}
            </div>
          )}
          {filteredCustomers.map((c, idx) => (
            <CustomerListItem
              key={c.customer_id}
              customer={c}
              isSelected={selectedCustomer?.customer_id === c.customer_id}
              isFocused={focusedIdx === idx}
              onClick={() => onSelectCustomer(c)}
              onMouseEnter={() => setFocusedIdx(-1)}
            />
          ))}
        </div>
      </section>
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </>
  );
}
