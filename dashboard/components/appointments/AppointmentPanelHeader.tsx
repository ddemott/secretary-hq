'use client';

import React from 'react';
import { ChevronLeft, Trash2, Edit, Send } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { Appointment } from '../../lib/types';

interface AppointmentPanelHeaderProps {
  selectedAppointment: Appointment | null;
  isCreating: boolean;
  isEditing: boolean;
  isSendingLinks: boolean;
  vocab: { booking_label: string };
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSendLinks: () => void;
  onCloseMobile: () => void;
}

export function AppointmentPanelHeader({
  selectedAppointment,
  isCreating,
  isEditing,
  isSendingLinks,
  vocab,
  onEdit,
  onCancelEdit,
  onDelete,
  onSendLinks,
  onCloseMobile,
}: AppointmentPanelHeaderProps) {
  return (
    <header
      className="p-4 md:p-8 sticky top-0 z-10 shadow-sm flex items-center justify-between"
      style={{
        borderBottom: '1px solid var(--border-soft)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      <div className="flex items-start">
        <button
          onClick={onCloseMobile}
          aria-label="Back to appointment list"
          className="md:hidden p-2 -ml-2 mr-2"
          style={{ color: 'var(--accent-soft)' }}
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-2xl md:text-3xl font-display">
            {isCreating
              ? `New ${vocab.booking_label}`
              : isEditing
                ? `Edit ${vocab.booking_label}`
                : selectedAppointment?.description}
          </h1>
          {selectedAppointment?.status === 'canceled' && <Badge variant="danger">Canceled</Badge>}
        </div>
      </div>
      <div className="flex items-center space-x-2">
        {!isEditing && !isCreating ? (
          <>
            <Button variant="danger" size="sm" onClick={onDelete} title="Cancel this appointment">
              <Trash2 className="w-4 h-4 mr-1" /> Cancel Appointment
            </Button>
            {selectedAppointment?.status === 'scheduled' && (
              <Button variant="secondary" onClick={onEdit}>
                <Edit className="w-4 h-4 mr-2" /> Edit Details
              </Button>
            )}
            {selectedAppointment?.status === 'scheduled' &&
              selectedAppointment?.customers?.phone && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onSendLinks}
                  isLoading={isSendingLinks}
                  title="Send cancel/reschedule links to customer via SMS"
                >
                  <Send className="w-4 h-4 mr-1" /> Send Links
                </Button>
              )}
          </>
        ) : (
          <Button variant="ghost" onClick={onCancelEdit} aria-label="Cancel edit">
            <span className="text-xl leading-none" aria-hidden="true">
              ✕
            </span>
          </Button>
        )}
      </div>
    </header>
  );
}
