'use client';

/**
 * Owner-only "explain this answer" RAG debugger. Posts a question to
 * /knowledge/explain and shows which knowledge-base chunks the AI retrieves,
 * their similarity scores, and which ones would actually be fed to the model
 * in production (top-N above the threshold) — so an owner can see WHY the AI
 * answers (or doesn't) and decide what KB content to add or reword.
 */

import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/EmptyState';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '../../lib/SessionContext';
import { showToast } from '../ui/Toast';
import type { KnowledgeExplainResponse } from '../../lib/types';

export default function ExplainAnswerView() {
  const tenantId = useActiveTenantId();
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KnowledgeExplainResponse | null>(null);

  async function runExplain() {
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await Api.knowledge.explain(tenantId, q);
      if (res.success) {
        setResult(res);
      } else {
        showToast(res.error || 'Failed to explain answer', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to explain answer', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Answer Debugger">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Type a question a caller might ask. This shows exactly which knowledge-base entries the AI
          would consider and how strongly each matches — so you can tell whether the AI has enough
          to answer.
        </p>

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              label="Caller question"
              value={question}
              placeholder="e.g. Do you take walk-ins?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runExplain();
              }}
            />
          </div>
          <Button
            variant="primary"
            isLoading={loading}
            disabled={!question.trim()}
            onClick={() => void runExplain()}
          >
            Explain
          </Button>
        </div>

        {result && (
          <div className="space-y-3">
            <div
              className={`rounded-md p-3 text-sm ${
                result.would_answer ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
              }`}
            >
              {result.would_answer
                ? `The AI would answer this — ${result.candidates.filter((c) => c.used_in_production).length} knowledge entr${
                    result.candidates.filter((c) => c.used_in_production).length === 1 ? 'y' : 'ies'
                  } clear the match threshold and feed the response.`
                : 'The AI would NOT answer this from the knowledge base — nothing clears the match threshold. Consider adding or rewording content for this topic.'}
            </div>

            {result.composed_answer && (
              <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
                <p className="text-xs font-semibold text-gray-500 mb-1">
                  What the AI would draw from
                </p>
                <pre className="text-sm whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300 font-sans">
                  {result.composed_answer}
                </pre>
              </div>
            )}

            {result.candidates.length === 0 ? (
              <EmptyState
                title="No knowledge entries matched"
                description="The knowledge base has nothing related to this question."
              />
            ) : (
              <div className="space-y-2">
                {result.candidates.map((c) => (
                  <div
                    key={c.tenant_doc_id}
                    className={`rounded-md border p-3 ${
                      c.used_in_production ? 'border-green-300 bg-green-50/40' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-500">#{c.rank}</span>
                      <Badge variant={c.above_threshold ? 'success' : 'secondary'}>
                        {(c.similarity * 100).toFixed(0)}% match
                      </Badge>
                      {c.used_in_production && <Badge variant="primary">Used by AI</Badge>}
                    </div>
                    <p className="text-sm text-gray-700 line-clamp-3">{c.content}</p>
                  </div>
                ))}
                <p className="text-xs text-gray-400">
                  Production uses the top {result.production_match_count} entries that score at
                  least {(result.production_threshold * 100).toFixed(0)}%.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
