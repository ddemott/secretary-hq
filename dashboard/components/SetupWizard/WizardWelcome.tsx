'use client';

import React, { useRef } from 'react';
import { Wand2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface WizardWelcomeProps {
  onContinue: () => void;
  onDismiss: () => void;
}

export function WizardWelcome({ onContinue, onDismiss }: WizardWelcomeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, true, onDismiss, true);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-welcome-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        ref={containerRef}
        className="rounded-2xl shadow-xl border max-w-lg w-full overflow-hidden"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-6 py-4 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" style={{ color: 'var(--accent-soft)' }} aria-hidden="true" />
            <h2 id="wizard-welcome-title" className="text-lg font-bold">
              Welcome to your AI receptionist
            </h2>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Close welcome"
            className="p-1 transition"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-base" style={{ color: 'var(--text-primary)' }}>
            Let&apos;s get your AI receptionist set up. We&apos;ll walk you through{' '}
            <span className="font-semibold">a few quick steps</span> — add your services, set your
            hours, and you can stop and come back any time.
          </p>

          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-2">
            <Button variant="ghost" size="md" onClick={onDismiss}>
              I&apos;ll set up later, just show me around
            </Button>
            <Button variant="primary" size="md" onClick={onContinue} autoFocus>
              Let&apos;s go
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
