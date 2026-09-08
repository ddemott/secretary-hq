/**
 * SkillManagementView — master skill list: render, create, delete.
 *
 * WHO: Owner/admin managing the skills that gate appointment booking.
 * WHAT: Renders skill cards, create form, delete confirmation flow.
 * WHERE: components/SkillManagementView.tsx — 0% coverage.
 * WHY: Create + delete paths were completely untested; a broken
 *   Api.skills.create call would silently succeed with no user feedback.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-test' }));
vi.mock('./ui/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./ui/LoadingState', () => ({
  LoadingState: ({ message }: { message: string }) => <div>{message}</div>,
}));
vi.mock('./ui/ConfirmModal', () => ({
  ConfirmModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div>Confirm Modal</div> : null),
}));

const { mockStaticData, mockApi, mockConfirm } = vi.hoisted(() => ({
  mockStaticData: {
    skills: [] as { name: string; description: string }[],
    loading: false,
    refresh: vi.fn(),
  },
  mockApi: {
    skills: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockConfirm: {
    state: { isOpen: false, title: '', message: '', confirmLabel: '', onConfirm: () => {} },
    confirm: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../lib/hooks', () => ({
  useStaticData: () => mockStaticData,
}));
vi.mock('../lib/api', () => ({ Api: mockApi }));
vi.mock('../lib/useConfirm', () => ({ useConfirm: () => mockConfirm }));

import SkillManagementView from './SkillManagementView';
import { showToast } from './ui/Toast';

const mockToast = vi.mocked(showToast);

const SAMPLE_SKILLS = [
  { name: 'oil-change', description: 'Full oil change service' },
  { name: 'tire-rotation', description: 'Rotate all four tires' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockStaticData.skills = SAMPLE_SKILLS;
  mockStaticData.loading = false;
  mockStaticData.refresh = vi.fn();
  mockConfirm.state = {
    isOpen: false,
    title: '',
    message: '',
    confirmLabel: '',
    onConfirm: () => {},
  };
  mockConfirm.confirm = vi.fn();
  mockConfirm.close = vi.fn();
});

describe('SkillManagementView — render', () => {
  test('HAPPY: renders skill cards from loaded list', () => {
    render(<SkillManagementView />);
    expect(screen.getByText('oil-change')).toBeInTheDocument();
    expect(screen.getByText('tire-rotation')).toBeInTheDocument();
    expect(screen.getByText('Full oil change service')).toBeInTheDocument();
  });

  test('HAPPY: shows loading state when skills are empty and loading is true', () => {
    mockStaticData.skills = [];
    mockStaticData.loading = true;
    render(<SkillManagementView />);
    expect(screen.getByText(/loading skills/i)).toBeInTheDocument();
  });

  test('HAPPY: shows empty state placeholder when no skills defined', () => {
    mockStaticData.skills = [];
    render(<SkillManagementView />);
    expect(screen.getByText(/no master skills defined/i)).toBeInTheDocument();
  });

  test('HAPPY: renders delete button for each skill', () => {
    render(<SkillManagementView />);
    expect(screen.getByRole('button', { name: /remove skill oil-change/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove skill tire-rotation/i })).toBeInTheDocument();
  });
});

describe('SkillManagementView — create skill form', () => {
  test('HAPPY: Submit button is disabled when skill name is empty', () => {
    render(<SkillManagementView />);
    expect(screen.getByRole('button', { name: /define skill/i })).toBeDisabled();
  });

  test('HAPPY: typing a name enables the Submit button', () => {
    render(<SkillManagementView />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. oil-change/i), {
      target: { value: 'brake-service' },
    });
    expect(screen.getByRole('button', { name: /define skill/i })).not.toBeDisabled();
  });

  test('HAPPY: submitting calls Api.skills.create with name + description', async () => {
    mockApi.skills.create.mockResolvedValue({ success: true });
    render(<SkillManagementView />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. oil-change/i), {
      target: { value: 'brake-service' },
    });
    fireEvent.change(screen.getByPlaceholderText(/briefly describe/i), {
      target: { value: 'Brake pad replacement' },
    });
    fireEvent.click(screen.getByRole('button', { name: /define skill/i }));
    await waitFor(() =>
      expect(mockApi.skills.create).toHaveBeenCalledWith('tenant-test', {
        name: 'brake-service',
        description: 'Brake pad replacement',
      })
    );
    expect(mockStaticData.refresh).toHaveBeenCalled();
  });

  test('SAD: API error shows inline error message', async () => {
    mockApi.skills.create.mockResolvedValue({ success: false, error: 'Skill name already taken' });
    render(<SkillManagementView />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. oil-change/i), {
      target: { value: 'duplicate-skill' },
    });
    fireEvent.click(screen.getByRole('button', { name: /define skill/i }));
    await waitFor(() => expect(screen.getByText('Skill name already taken')).toBeInTheDocument());
  });
});

describe('SkillManagementView — delete skill', () => {
  test('HAPPY: clicking delete invokes confirmAction with skill name', () => {
    render(<SkillManagementView />);
    fireEvent.click(screen.getByRole('button', { name: /remove skill oil-change/i }));
    expect(mockConfirm.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmVariant: 'danger' })
    );
  });

  test('HAPPY: confirming delete calls Api.skills.delete and shows toast', async () => {
    mockApi.skills.delete.mockResolvedValue({ success: true });
    mockConfirm.confirm = vi.fn().mockImplementation(({ onConfirm }) => {
      onConfirm?.();
    });
    render(<SkillManagementView />);
    fireEvent.click(screen.getByRole('button', { name: /remove skill oil-change/i }));
    await waitFor(() =>
      expect(mockApi.skills.delete).toHaveBeenCalledWith('oil-change', 'tenant-test')
    );
    expect(mockToast).toHaveBeenCalledWith('Skill removed', 'success');
  });

  test('SAD: failed delete shows error toast', async () => {
    mockApi.skills.delete.mockRejectedValue(new Error('Delete failed'));
    mockConfirm.confirm = vi.fn().mockImplementation(({ onConfirm }) => {
      onConfirm?.();
    });
    render(<SkillManagementView />);
    fireEvent.click(screen.getByRole('button', { name: /remove skill oil-change/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Delete failed', 'error'));
  });
});
