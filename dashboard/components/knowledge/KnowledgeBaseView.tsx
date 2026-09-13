'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BookOpen,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Globe,
  Loader2,
} from 'lucide-react';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useUrlQueryState } from '../../lib/useUrlQueryState';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useConfirm } from '../../lib/useConfirm';
import { showToast } from '../ui/Toast';
import type { KnowledgeEntry } from '../../lib/types';
import { POLICY_QUESTIONS } from '../../lib/policyQuestions';
import { KnowledgeSuggestions } from './KnowledgeSuggestions';
import { KnowledgeQuestionnaireTab } from './KnowledgeQuestionnaireTab';
import { KnowledgeDocumentsTab } from './KnowledgeDocumentsTab';
import { KnowledgeEntriesTab } from './KnowledgeEntriesTab';

type Tab = 'questionnaire' | 'documents' | 'entries' | 'suggestions';
const VALID_TABS: Tab[] = ['questionnaire', 'documents', 'entries', 'suggestions'];
const CUSTOM_QUESTION_SOURCE = 'custom-question';

export default function KnowledgeBaseView() {
  const tenantId = useActiveTenantId();

  // tab + q are shallow URL state; the shared hook owns read/validate/write/
  // popstate (replaces this view's hand-rolled URLSearchParams plumbing).
  const [tab, setTab] = useUrlQueryState<Tab>('tab', {
    defaultValue: 'questionnaire',
    valid: VALID_TABS,
  });
  const [searchTerm, setSearchTerm] = useUrlQueryState<string>('q', {
    defaultValue: '',
    omitDefault: true,
  });
  const [suggestionCount, setSuggestionCount] = useState(0);

  const [docs, setDocs] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
  const [scanUrl, setScanUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [savedAnswers, setSavedAnswers] = useState<
    Map<string, { id: string; answer: string; source?: string }>
  >(new Map());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const fetchDocs = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const data = await Api.knowledge.list(tenantId);
      setDocs(data);

      // Pre-fill questionnaire from saved entries. Accept both the manual
      // source ('policy-questionnaire') and website-scan-sourced answers so a
      // scanned answer pre-fills AND carries its provenance for the badge.
      const answers = new Map<string, { id: string; answer: string; source?: string }>();
      for (const doc of data) {
        if ((doc.source === 'policy-questionnaire' || doc.source === 'website-scan') && doc.title) {
          // `data` is newest-first; if a title has multiple docs (e.g. a manual
          // answer + a later website-scan for the same question) keep the FIRST
          // seen = the newest, rather than letting an older row overwrite it.
          if (answers.has(doc.title)) continue;
          const answerMatch = doc.content.match(/^Q: .+\nA: ([\s\S]+)$/);
          const answer = answerMatch ? answerMatch[1] : doc.content;
          answers.set(doc.title, { id: doc.tenant_doc_id, answer, source: doc.source });
        }
      }
      setSavedAnswers(answers);
    } catch (err) {
      console.error('Failed to fetch knowledge', err);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void fetchDocs();
  }, [fetchDocs]);

  // Load suggestion count on mount so the Suggestions tab badge appears
  // without requiring the user to click into the tab first.
  useEffect(() => {
    if (!tenantId) return;
    void Api.knowledge.suggestions(tenantId).then((res) => {
      if (res?.success) setSuggestionCount(res.suggestions?.length ?? 0);
    });
  }, [tenantId]);

  async function handleSaveAnswer(
    question: string,
    answer: string,
    existingId: string | null,
    category: string
  ): Promise<string | null> {
    if (!tenantId) return null;
    try {
      if (existingId) {
        // update resets source to the 'policy-questionnaire' default server-side;
        // once an owner edits a scanned answer it's owner-authored, so drop the
        // website badge to match.
        await Api.knowledge.update(existingId, tenantId, { question, answer, category });
        setSavedAnswers((prev) =>
          new Map(prev).set(question, { id: existingId, answer, source: 'policy-questionnaire' })
        );
        return existingId;
      } else {
        const res = await Api.knowledge.add(tenantId, { question, answer, category });
        if (res.success) {
          setSavedAnswers((prev) =>
            new Map(prev).set(question, {
              id: res.tenant_doc_id,
              answer,
              source: 'policy-questionnaire',
            })
          );
          return res.tenant_doc_id;
        }
      }
    } catch (err) {
      console.error('Failed to save answer', err);
    }
    return null;
  }

  async function handleAddCustomQuestion(question: string, answer: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const res = await Api.knowledge.add(tenantId, {
        question,
        answer,
        category: 'Custom',
        source: CUSTOM_QUESTION_SOURCE,
      });
      if (res.success) {
        await fetchDocs();
        showToast('Custom question saved', 'success');
        return true;
      }
      showToast('Failed to save custom question', 'error');
      return false;
    } catch (err) {
      console.error('Failed to add custom question', err);
      showToast('Failed to save custom question', 'error');
      return false;
    }
  }

  async function handleWebsiteScan() {
    if (!scanUrl || !tenantId) return;
    setScanning(true);
    setMessage(null);
    try {
      const res = await Api.knowledge.importWebsite(tenantId, scanUrl);
      if (res?.success) {
        // The scan STAGES everything as a suggestion server-side (nothing is
        // auto-confirmed into the live KB) — so this refreshes the suggestion
        // count and points the owner at the review flow, rather than writing
        // to the KB a second time itself (Copilot review on #442: the
        // earlier version of this called Api.knowledge.add per item, which
        // both duplicated the staged suggestion and bypassed the approve
        // step entirely).
        const total = (res.confirmed ?? 0) + (res.suggestions ?? 0);
        const suggestionsRes = await Api.knowledge.suggestions(tenantId);
        if (suggestionsRes?.success) {
          setSuggestionCount(suggestionsRes.suggestions?.length ?? 0);
        }
        setMessage({
          type: 'success',
          text: total
            ? `Scanned your site and found ${total} answer${total === 1 ? '' : 's'} to review. Check the Suggestions tab to approve them.`
            : 'Scan completed but nothing matched your questionnaire — you can still answer manually.',
        });
        setScanUrl('');
      } else {
        setMessage({ type: 'error', text: res?.error || 'Could not scan that website.' });
      }
    } catch (err) {
      console.error('Website scan error', err);
      setMessage({
        type: 'error',
        text: 'Could not scan that website. Check the URL and try again.',
      });
    } finally {
      setScanning(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !tenantId) return;
    setUploading(true);
    setMessage(null);
    try {
      const res = await Api.knowledge.ingest(tenantId, file);
      if (res.success) {
        setMessage({
          type: 'success',
          text: `Successfully processed ${file.name} — your AI can now answer questions from this document.`,
        });
        void fetchDocs();
      } else {
        setMessage({ type: 'error', text: res.error || 'Upload failed' });
      }
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleDeleteFile(source: string) {
    const chunks = docs.filter((d) => d.source === source);
    confirm({
      title: 'Remove Document',
      message: `Remove "${source}"? This will delete all ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} from your AI's knowledge.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        closeConfirm();
        void Promise.all(chunks.map((c) => doDelete(c.tenant_doc_id)));
      },
    });
  }

  function handleDelete(id: string) {
    confirm({
      title: 'Delete Knowledge Entry',
      message: 'Delete this entry? The AI will no longer have access to this information.',
      confirmLabel: 'Delete',
      onConfirm: () => {
        closeConfirm();
        void doDelete(id);
      },
    });
  }

  async function doDelete(id: string) {
    try {
      await Api.knowledge.delete(id, tenantId);
      setDocs(docs.filter((d) => d.tenant_doc_id !== id));
      // Also remove from savedAnswers if it was a questionnaire entry
      setSavedAnswers((prev) => {
        const next = new Map(prev);
        for (const [q, v] of next) {
          if (v.id === id) {
            next.delete(q);
            break;
          }
        }
        return next;
      });
    } catch {
      showToast('Failed to delete', 'error');
    }
  }

  const filteredDocs = docs.filter(
    (d) =>
      d.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.source?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.title?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalAnswered = savedAnswers.size;
  const totalQuestions = POLICY_QUESTIONS.length;

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <header className="mb-6 shrink-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center">
          <div className="bg-orange-100 dark:bg-orange-900/30 p-2 rounded-lg mr-4 text-orange-600 dark:text-orange-400">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-3xl font-display">What Your AI Knows</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Teach the AI about your business so it can answer caller questions.
            </p>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div
        className="flex gap-1 mb-6 p-1 rounded-xl shrink-0"
        style={{ backgroundColor: 'var(--bg-raised)' }}
      >
        {[
          {
            key: 'questionnaire' as Tab,
            label: 'Teach Your AI',
            icon: MessageSquare,
            badge: `${totalAnswered}/${totalQuestions}`,
          },
          { key: 'documents' as Tab, label: 'Upload Documents', icon: Upload },
          {
            key: 'entries' as Tab,
            label: 'Review Everything',
            icon: FileText,
            badge: String(docs.length),
          },
          {
            key: 'suggestions' as Tab,
            label: 'Suggestions',
            icon: Globe,
            badge: suggestionCount > 0 ? String(suggestionCount) : undefined,
          },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.key ? 'shadow-sm' : 'hover:opacity-70'
            }`}
            style={
              tab === t.key
                ? { backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }
                : { color: 'var(--text-secondary)' }
            }
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.badge && (
              <Badge variant="secondary" className="text-xs py-0 px-1.5">
                {t.badge}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {/* Message banner */}
      {message && (
        <div
          className={`mb-4 p-4 rounded-xl flex items-center gap-3 ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-100 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-100 dark:border-red-800'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : (
            <AlertCircle className="w-5 h-5" />
          )}
          <span className="font-medium">{message.text}</span>
          <button
            onClick={() => setMessage(null)}
            className="ml-auto text-current opacity-50 hover:opacity-100 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div
            className="flex flex-col items-center justify-center h-64 italic"
            style={{ color: 'var(--text-muted)' }}
          >
            <Loader2 className="w-8 h-8 animate-spin mb-4 opacity-20" />
            <p>Loading knowledge base...</p>
          </div>
        ) : (
          <>
            {tab === 'questionnaire' && (
              <KnowledgeQuestionnaireTab
                totalAnswered={totalAnswered}
                totalQuestions={totalQuestions}
                showUnansweredOnly={showUnansweredOnly}
                onToggleUnansweredOnly={() => setShowUnansweredOnly((v) => !v)}
                savedAnswers={savedAnswers}
                onSaveAnswer={handleSaveAnswer}
                customDocs={docs.filter((d) => d.source === CUSTOM_QUESTION_SOURCE)}
                onAddCustomQuestion={handleAddCustomQuestion}
                onDeleteEntry={handleDelete}
              />
            )}

            {/* Website re-scan (post-onboarding). The initial scan happens in the
                SetupWizard (step 7); this lets an owner re-run it later, e.g. after
                updating their site, without redoing the whole wizard. */}
            <div
              className="mt-4 p-3 border rounded"
              style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-raised)' }}
            >
              <div className="text-sm font-medium mb-1">
                Import policies from your website (beta / optional step)
              </div>
              <div className="text-xs text-muted mb-3">
                Paste URL → AI extracts answers to your questionnaire. Review & approve to populate
                KB (reduces manual entry).
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="url"
                  placeholder="https://www.yourbusiness.com"
                  value={scanUrl}
                  onChange={(e) => setScanUrl(e.target.value)}
                  disabled={scanning}
                  className="flex-1"
                />
                <Button
                  onClick={handleWebsiteScan}
                  disabled={!scanUrl || scanning}
                  isLoading={scanning}
                  variant="primary"
                >
                  Scan website
                </Button>
              </div>
            </div>

            {tab === 'documents' && (
              <KnowledgeDocumentsTab
                docs={docs}
                uploading={uploading}
                fileInputRef={fileInputRef}
                onFileChange={handleFileUpload}
                onDeleteFile={handleDeleteFile}
              />
            )}

            {tab === 'entries' && (
              <KnowledgeEntriesTab
                filteredDocs={filteredDocs}
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                onDelete={handleDelete}
              />
            )}

            {tab === 'suggestions' && (
              <KnowledgeSuggestions tenantId={tenantId} onCountChange={setSuggestionCount} />
            )}
          </>
        )}
      </div>
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
