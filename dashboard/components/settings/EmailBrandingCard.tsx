'use client';

import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

interface EmailBrandingCardProps {
  logoUrl: string;
  savedLogoUrl: string;
  saving: boolean;
  onLogoUrlChange: (val: string) => void;
  onSave: () => void;
}

export function EmailBrandingCard({
  logoUrl,
  savedLogoUrl,
  saving,
  onLogoUrlChange,
  onSave,
}: EmailBrandingCardProps) {
  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <h2 className="text-lg font-bold mb-1">Email Branding</h2>
      <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
        Your logo, shown at the top of appointment confirmations, reminders, and other emails your
        customers receive. Paste a URL to an image you already host — leave blank for no logo.
      </p>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            label="Logo URL"
            value={logoUrl}
            maxLength={2000}
            onChange={(e) => onLogoUrlChange(e.target.value)}
            placeholder="https://example.com/logo.png"
          />
        </div>
        <Button
          onClick={onSave}
          isLoading={saving}
          disabled={logoUrl.trim() === savedLogoUrl.trim()}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}
