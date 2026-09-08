'use client';

import React from 'react';
import { type VoiceSession } from '@/lib/types';
import {
  Phone,
  PhoneIncoming,
  User,
  Calendar,
  MessageSquare,
  CheckCircle,
  XCircle,
  AlertCircle,
  Trash2,
} from 'lucide-react';
import { formatPhone } from '../../lib/phone';
import { OutcomeBadge } from './outcome';
import { formatDuration } from './callFormatters';

interface CallDetailPanelProps {
  selectedCall: VoiceSession | null;
  isOwner: boolean;
  onDeleteCall: (call: VoiceSession) => void;
}

export function CallDetailPanel({ selectedCall, isOwner, onDeleteCall }: CallDetailPanelProps) {
  const customerContext = selectedCall?.customer_context;

  if (!selectedCall) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-gray-500"
        style={{ backgroundColor: 'var(--bg-base)' }}
      >
        <div className="text-center">
          <PhoneIncoming className="w-12 h-12 mx-auto mb-4 text-gray-300" />
          <p>Select a call to view details</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-y-auto flex flex-col"
      style={{ backgroundColor: 'var(--bg-base)' }}
    >
      <div className="p-6">
        {/* Call Header */}
        <div
          className="rounded-lg shadow-sm p-6 mb-4"
          style={{ backgroundColor: 'var(--bg-surface)' }}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold text-[var(--text-primary)]">
                {customerContext?.customer?.name || formatPhone(selectedCall.caller_phone)}
              </h2>
              <p className="text-gray-500">{formatPhone(selectedCall.caller_phone)}</p>
            </div>
            <div className="flex items-center gap-2">
              {isOwner && selectedCall.status !== 'active' && (
                <button
                  onClick={() => onDeleteCall(selectedCall)}
                  title="Delete this call"
                  aria-label="Delete this call"
                  className="p-2 rounded-lg transition-colors"
                  style={{ color: 'var(--danger)' }}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              {selectedCall.status === 'active' ? (
                <span
                  className="px-3 py-1 rounded-full text-sm flex items-center gap-1"
                  style={{ backgroundColor: 'var(--success-bg)', color: 'var(--success)' }}
                >
                  <Phone className="w-4 h-4 animate-pulse" />
                  Active
                </span>
              ) : selectedCall.status === 'completed' ? (
                <span
                  className="px-3 py-1 rounded-full text-sm flex items-center gap-1"
                  style={{ backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
                >
                  <CheckCircle className="w-4 h-4" />
                  Completed
                </span>
              ) : (
                <span
                  className="px-3 py-1 rounded-full text-sm flex items-center gap-1"
                  style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
                >
                  <XCircle className="w-4 h-4" />
                  {selectedCall.status}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Started</span>
              <p className="font-medium">{new Date(selectedCall.started_at).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-gray-500">Duration</span>
              <p className="font-medium">{formatDuration(selectedCall.duration_seconds)}</p>
            </div>
            <div>
              <span className="text-gray-500">Outcome</span>
              <p className="font-medium">
                <OutcomeBadge outcome={selectedCall.outcome} />
              </p>
            </div>
          </div>
        </div>

        {/* Customer Context */}
        {customerContext && (
          <div
            className="rounded-lg shadow-sm p-6 mb-4"
            style={{ backgroundColor: 'var(--bg-surface)' }}
          >
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
              <User className="w-5 h-5" />
              Customer Context
            </h3>

            {customerContext.is_known_customer ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {customerContext.customer?.email && (
                    <div>
                      <span className="text-gray-500">Email</span>
                      <p className="font-medium">{customerContext.customer.email}</p>
                    </div>
                  )}
                  {customerContext.member_since && (
                    <div>
                      <span className="text-gray-500">Customer Since</span>
                      <p className="font-medium">
                        {new Date(customerContext.member_since).toLocaleDateString()}
                      </p>
                    </div>
                  )}
                </div>

                <div className="border-t pt-4">
                  <h4 className="font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    Appointment History
                  </h4>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div className="rounded p-3 text-center">
                      <p className="text-2xl font-bold text-[var(--text-primary)]">
                        {customerContext.appointment_history.total}
                      </p>
                      <p className="text-gray-500 text-xs">Total</p>
                    </div>
                    <div className="rounded p-3 text-center">
                      <p className="text-2xl font-bold" style={{ color: 'var(--success)' }}>
                        {customerContext.appointment_history.completed}
                      </p>
                      <p className="text-gray-500 text-xs">Completed</p>
                    </div>
                    <div
                      className="rounded p-3 text-center"
                      style={{ backgroundColor: 'var(--danger-bg)' }}
                    >
                      <p className="text-2xl font-bold" style={{ color: 'var(--danger)' }}>
                        {customerContext.appointment_history.cancelled}
                      </p>
                      <p className="text-gray-500 text-xs">Cancelled</p>
                    </div>
                  </div>

                  {customerContext.appointment_history.upcoming_appointments.length > 0 && (
                    <div className="mt-4">
                      <h5 className="text-sm font-medium text-gray-700 mb-2">Upcoming</h5>
                      <div className="space-y-2">
                        {customerContext.appointment_history.upcoming_appointments.map((apt) => (
                          <div
                            key={apt.appointment_id}
                            className="rounded p-2 text-sm"
                            style={{ backgroundColor: 'var(--accent-muted)' }}
                          >
                            <p className="font-medium">
                              {new Date(apt.start_time).toLocaleDateString()} at{' '}
                              {new Date(apt.start_time).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                            {apt.description && <p className="text-gray-600">{apt.description}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {customerContext.notes.length > 0 && (
                  <div className="border-t pt-4">
                    <h4 className="font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
                      <MessageSquare className="w-4 h-4" />
                      Notes
                    </h4>
                    <div className="space-y-2">
                      {customerContext.notes.slice(-5).map((note) => (
                        <div
                          key={note.note_id}
                          className="rounded p-2 text-sm"
                          style={{ backgroundColor: 'var(--warning-bg)' }}
                        >
                          <p>{note.text}</p>
                          <p className="text-xs text-gray-500 mt-1">
                            {new Date(note.created_at).toLocaleDateString()} · {note.type}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {customerContext.tags.length > 0 && (
                  <div className="border-t pt-4">
                    <h4 className="font-medium text-[var(--text-primary)] mb-2">Tags</h4>
                    <div className="flex flex-wrap gap-2">
                      {customerContext.tags.map((tag) => (
                        <span key={tag} className="px-2 py-1 rounded text-sm">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4 text-gray-500">
                <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                <p>New caller - no previous history</p>
              </div>
            )}
          </div>
        )}

        {/* Transcript */}
        {selectedCall.transcript && (
          <div
            className="rounded-lg shadow-sm p-6 mb-4"
            style={{ backgroundColor: 'var(--bg-surface)' }}
          >
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Transcript</h3>
            <div className="rounded p-4 text-sm whitespace-pre-wrap">{selectedCall.transcript}</div>
          </div>
        )}

        {/* Summary */}
        {selectedCall.summary && (
          <div
            className="rounded-lg shadow-sm p-6"
            style={{ backgroundColor: 'var(--bg-surface)' }}
          >
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Call Summary</h3>
            <p className="text-gray-700">{selectedCall.summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
