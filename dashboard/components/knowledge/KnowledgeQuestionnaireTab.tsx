'use client';

/**
 * "Teach Your AI" tab — policy questionnaire + custom Q&A. Shows a progress
 * bar, a start-here or fully-trained banner, the category accordions, and the
 * custom-questions accordion. Extracted from KnowledgeBaseView.tsx.
 */

import React from 'react';
import { MessageSquare, CheckCircle2 } from 'lucide-react';
import { POLICY_CATEGORIES, POLICY_QUESTIONS } from '../../lib/policyQuestions';
import { PolicyCategory } from './PolicyCategory';
import { CustomQuestionsSection } from './CustomQuestionsSection';
import type { KnowledgeEntry } from '../../lib/types';

type SavedAnswer = { id: string; answer: string; source?: string };

interface KnowledgeQuestionnaireTabProps {
  totalAnswered: number;
  totalQuestions: number;
  showUnansweredOnly: boolean;
  onToggleUnansweredOnly: () => void;
  savedAnswers: Map<string, SavedAnswer>;
  onSaveAnswer: (
    question: string,
    answer: string,
    existingId: string | null,
    category: string
  ) => Promise<string | null>;
  customDocs: KnowledgeEntry[];
  onAddCustomQuestion: (question: string, answer: string) => Promise<boolean>;
  onDeleteEntry: (id: string) => void;
}

export function KnowledgeQuestionnaireTab({
  totalAnswered,
  totalQuestions,
  showUnansweredOnly,
  onToggleUnansweredOnly,
  savedAnswers,
  onSaveAnswer,
  customDocs,
  onAddCustomQuestion,
  onDeleteEntry,
}: KnowledgeQuestionnaireTabProps) {
  return (
    <div className="space-y-3 max-w-3xl pb-8">
      {/* "Start here" banner for 0-entry users — gives a clear
          entry point instead of staring at 9 collapsed rows.
          2026-05-28 UX fix. */}
      {totalAnswered === 0 && (
        <div
          className="flex items-start gap-3 p-4 rounded-xl border mb-2"
          style={{
            backgroundColor: 'var(--accent-muted)',
            borderColor: 'var(--accent)',
          }}
        >
          <MessageSquare
            className="w-5 h-5 mt-0.5 shrink-0"
            style={{ color: 'var(--accent-soft)' }}
          />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--accent-soft)' }}>
              Start here — answer a few questions about your business
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              Your AI uses these answers to respond to callers. Each answer auto-saves as you type.
              Start with Business Hours below.
            </p>
          </div>
        </div>
      )}
      {/* Progress bar — more motivating than the tiny tab badge */}
      {totalQuestions > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {totalAnswered} of {totalQuestions} answered
              {totalAnswered === totalQuestions && ' — fully trained!'}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {Math.round((totalAnswered / totalQuestions) * 100)}%
            </span>
          </div>
          <div
            className="w-full rounded-full h-1.5"
            style={{ backgroundColor: 'var(--bg-raised)' }}
          >
            <div
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${Math.round((totalAnswered / totalQuestions) * 100)}%`,
                backgroundColor: 'var(--accent-soft)',
              }}
            />
          </div>
          {totalAnswered < totalQuestions && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              The more you fill in, the better your AI sounds to callers.
            </p>
          )}
        </div>
      )}
      {totalAnswered === totalQuestions && totalQuestions > 0 && (
        <div
          className="flex items-start gap-3 p-4 rounded-xl border mb-2"
          style={{
            backgroundColor: 'var(--accent-muted)',
            borderColor: 'var(--accent)',
          }}
        >
          <CheckCircle2
            className="w-5 h-5 mt-0.5 shrink-0"
            style={{ color: 'var(--accent-soft)' }}
          />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--accent-soft)' }}>
              Your AI is fully trained on your business
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              To activate your phone line, open the{' '}
              <strong style={{ color: 'var(--text-primary)' }}>Phone Assistant</strong> tab and go
              to Go Live.
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Answer these questions about your business. The AI will use your answers to respond to
          callers. Answers auto-save as you type.
        </p>
        <div className="flex items-center gap-3 shrink-0 ml-4">
          {totalAnswered < totalQuestions && (
            <button
              onClick={onToggleUnansweredOnly}
              className="text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors"
              style={
                showUnansweredOnly
                  ? {
                      backgroundColor: 'var(--accent-muted)',
                      borderColor: 'var(--accent)',
                      color: 'var(--accent-soft)',
                    }
                  : {
                      backgroundColor: 'transparent',
                      borderColor: 'var(--border)',
                      color: 'var(--text-secondary)',
                    }
              }
            >
              {showUnansweredOnly ? 'Showing unanswered' : 'Show unanswered only'}
            </button>
          )}
          <button
            onClick={() =>
              document
                .getElementById('custom-questions-section')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="text-xs font-medium hover:underline"
            style={{ color: 'var(--accent-soft)' }}
          >
            + Add your own question
          </button>
        </div>
      </div>
      {POLICY_CATEGORIES.filter((cat) => {
        if (!showUnansweredOnly) return true;
        return (
          POLICY_QUESTIONS.filter((q) => q.category === cat && !savedAnswers.has(q.question))
            .length > 0
        );
      }).map((cat, idx) => (
        <PolicyCategory
          key={cat}
          category={cat}
          questions={POLICY_QUESTIONS.filter(
            (q) => q.category === cat && (!showUnansweredOnly || !savedAnswers.has(q.question))
          )}
          savedAnswers={savedAnswers}
          onSave={onSaveAnswer}
          defaultOpen={idx === 0}
        />
      ))}
      <div id="custom-questions-section">
        <CustomQuestionsSection
          customDocs={customDocs}
          onAdd={onAddCustomQuestion}
          onDelete={onDeleteEntry}
        />
      </div>
    </div>
  );
}
