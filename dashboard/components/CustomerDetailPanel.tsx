'use client';

import React from 'react';
import { Users } from 'lucide-react';
import { type Customer } from '@/lib/types';
import { CustomerDetailHeader, type EditForm } from './crm/CustomerDetailHeader';
import { ContactDetailsCard } from './crm/ContactDetailsCard';
import {
  CustomerAppointmentsSection,
  type CustomerAppointment,
} from './crm/CustomerAppointmentsSection';
import { CustomerCallHistory, type CallSummary } from './crm/CustomerCallHistory';

interface CustomerDetailPanelProps {
  selectedCustomer: Customer | null;
  isCreating: boolean;
  isEditing: boolean;
  saving: boolean;
  showDetailOnMobile: boolean;
  editForm: EditForm;
  summaries: CallSummary[];
  upcomingAppointments: CustomerAppointment[];
  pastAppointments: CustomerAppointment[];
  onEditFormChange: (field: string, value: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onCreate: () => void;
  onDelete: () => void;
  onCancelAppointment: (appointmentId: string) => void;
  onReactivateAppointment: (appointmentId: string) => void;
  onCloseMobile: () => void;
}

export function CustomerDetailPanel({
  selectedCustomer,
  isCreating,
  isEditing,
  saving,
  showDetailOnMobile,
  editForm,
  summaries,
  upcomingAppointments,
  pastAppointments,
  onEditFormChange,
  onEdit,
  onCancelEdit,
  onSave,
  onCreate,
  onDelete,
  onCancelAppointment,
  onReactivateAppointment,
  onCloseMobile,
}: CustomerDetailPanelProps) {
  return (
    <section
      className={`flex-1 flex flex-col overflow-y-auto fixed inset-0 z-20 md:relative md:z-0 ${showDetailOnMobile || isCreating ? 'flex' : 'hidden md:flex'}`}
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      {selectedCustomer || isCreating ? (
        <>
          <CustomerDetailHeader
            selectedCustomer={selectedCustomer}
            isCreating={isCreating}
            isEditing={isEditing}
            saving={saving}
            onEdit={onEdit}
            onCancelEdit={onCancelEdit}
            onSave={onSave}
            onCreate={onCreate}
            onDelete={onDelete}
            onCloseMobile={onCloseMobile}
          />

          <div className="p-4 md:p-8 space-y-8">
            {!isCreating && !isEditing && selectedCustomer && (
              <nav
                aria-label="Customer sections"
                className="flex gap-3 text-xs font-medium"
                style={{ color: 'var(--text-secondary)' }}
              >
                {['Contact', 'Upcoming', 'History', 'Calls'].map((label) => (
                  <a
                    key={label}
                    href={`#customer-${label.toLowerCase()}`}
                    className="hover:underline"
                    style={{ color: 'var(--accent-soft)' }}
                  >
                    {label}
                  </a>
                ))}
              </nav>
            )}

            <ContactDetailsCard
              selectedCustomer={selectedCustomer}
              isCreating={isCreating}
              isEditing={isEditing}
              editForm={editForm}
              onEditFormChange={onEditFormChange}
            />

            {!isCreating && (
              <>
                <CustomerAppointmentsSection
                  upcomingAppointments={upcomingAppointments}
                  pastAppointments={pastAppointments}
                  onCancelAppointment={onCancelAppointment}
                  onReactivateAppointment={onReactivateAppointment}
                />
                <CustomerCallHistory summaries={summaries} />
              </>
            )}
          </div>
        </>
      ) : (
        <div
          className="flex-1 flex items-center justify-center italic text-center px-4 flex-col"
          style={{ color: 'var(--text-muted)' }}
        >
          <Users className="w-12 h-12 mb-4 opacity-20" />
          Select a customer or click the &quot;+&quot; button to add one.
        </div>
      )}
    </section>
  );
}
