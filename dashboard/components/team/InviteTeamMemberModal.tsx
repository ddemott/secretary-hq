'use client';

import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

type Role = 'owner' | 'front_desk';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  front_desk: 'Front Desk',
};

const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Full access — can configure services, staff, vocabulary, and team logins.',
  front_desk: 'Daily-use access only — schedule, customers, calls. No configuration.',
};

interface InviteTeamMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    email: string;
    full_name: string;
    role: Role;
  }) => Promise<{ success: boolean; error?: string }>;
}

export function InviteTeamMemberModal({ isOpen, onClose, onSubmit }: InviteTeamMemberModalProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('front_desk');
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInviting(true);
    const res = await onSubmit({ email: email.trim(), full_name: name.trim(), role });
    setInviting(false);
    if (res.success) {
      setEmail('');
      setName('');
      setRole('front_desk');
      onClose();
    } else {
      setError(res.error || 'Invite failed');
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!inviting) onClose();
      }}
      title="Invite a teammate"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={inviting}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" isLoading={inviting}>
            Send invite
          </Button>
        </div>
      }
    >
      <form id="invite-form" onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Full name"
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pat Lopez"
        />
        <Input
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="pat@business.com"
        />
        <div>
          <label
            className="block text-xs font-bold uppercase mb-1"
            style={{ color: 'var(--text-secondary)' }}
          >
            Role
          </label>
          <div className="space-y-2">
            {(['front_desk', 'owner'] as Role[]).map((r) => (
              <label
                key={r}
                className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition"
                style={{
                  borderColor: role === r ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: role === r ? 'var(--accent-muted)' : 'var(--bg-card)',
                }}
              >
                <input
                  type="radio"
                  name="invite-role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {ROLE_LABEL[r]}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {ROLE_DESCRIPTION[r]}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          They&rsquo;ll receive an email with a link to set their password and sign in. The link
          expires in 3 days.
        </p>
      </form>
    </Modal>
  );
}
