'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { CheckCircle, XCircle, Globe, RefreshCw } from 'lucide-react';
import { Api } from '../../lib/api';
import { Button } from '../ui/Button';

interface Suggestion {
  id: string;
  question: string;
  answer: string;
  source_url: string | null;
  confidence: number | null;
  created_at: string;
}

interface Props {
  tenantId: string | null;
  onCountChange?: (count: number) => void;
}

export function KnowledgeSuggestions({ tenantId, onCountChange }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<Record<string, 'approving' | 'rejecting'>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) {
      // No active tenant — clear any state carried over from a previous session
      // and report 0 so the parent badge resets instead of showing a stale count.
      setSuggestions([]);
      setError(null);
      setLoading(false);
      onCountChange?.(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await Api.knowledge.suggestions(tenantId);
      if (res?.success) {
        setSuggestions(res.suggestions ?? []);
        onCountChange?.(res.suggestions?.length ?? 0);
      } else {
        setError('Failed to load suggestions.');
        setSuggestions([]);
      }
    } catch {
      setError('Failed to load suggestions.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, action: 'approving' | 'rejecting') => {
      setActioning((prev) => ({ ...prev, [id]: action }));
      try {
        const res =
          action === 'approving'
            ? await Api.knowledge.approveSuggestion(id, tenantId)
            : await Api.knowledge.rejectSuggestion(id, tenantId);
        if (res?.success) {
          setSuggestions((prev) => {
            const next = prev.filter((s) => s.id !== id);
            onCountChange?.(next.length);
            return next;
          });
        }
      } catch {
        // leave in list so user can retry
      } finally {
        setActioning((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [tenantId, onCountChange]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        Loading suggestions…
      </div>
    );
  }

  if (error) {
    return <div className="text-red-500 text-sm py-4">{error}</div>;
  }

  if (suggestions.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Globe className="w-10 h-10 mx-auto mb-3 text-gray-300" />
        <p className="font-medium">No pending suggestions</p>
        <p className="text-sm mt-1">
          Run a website scan from the Setup Wizard to extract Q&amp;A for review.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        {suggestions.length} item{suggestions.length !== 1 ? 's' : ''} extracted from your website —
        approve to add to your AI&apos;s knowledge, or reject to discard.
      </p>

      {suggestions.map((s) => {
        const busy = actioning[s.id];
        return (
          <div key={s.id} className="border border-gray-200 rounded-lg p-4 bg-white shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 mb-1">{s.question}</p>
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{s.answer}</p>
                {s.source_url && (
                  <p className="text-xs text-gray-400 mt-2 flex items-center gap-1">
                    <Globe className="w-3 h-3" />
                    {s.source_url}
                  </p>
                )}
                {s.confidence != null && (
                  <p className="text-xs text-gray-400 mt-1">
                    Confidence: {Math.round(s.confidence * 100)}%
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="primary"
                  isLoading={busy === 'approving'}
                  disabled={!!busy}
                  onClick={() => void act(s.id, 'approving')}
                  className="flex items-center gap-1"
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={busy === 'rejecting'}
                  disabled={!!busy}
                  onClick={() => void act(s.id, 'rejecting')}
                  className="flex items-center gap-1"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Discard
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
