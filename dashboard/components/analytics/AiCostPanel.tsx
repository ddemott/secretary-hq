'use client';

/**
 * Month-to-date AI spend, with the number the pricing decision actually needs:
 * average cost per call (T-011).
 *
 * OPERATOR-ONLY, and gated in TWO places for two different reasons:
 *   - the SERVER (`requireSuperAdmin` on GET /analytics/ai-cost) is the actual
 *     authorization boundary. Not hiding a panel is not a control: the route is
 *     reachable with any tenant's own JWT and one curl, which is exactly what
 *     the #394 review caught when this file claimed the UI was the gate.
 *   - the CALL SITE (`isAdmin` in AnalyticsView) keeps a non-admin from firing
 *     a request that would only 403 anyway. A component that decides for itself
 *     whether to hide is one `props` change away from not hiding.
 *
 * Why it exists at all: the ledger once undercounted 35x because the production
 * voice LLM was missing from the pricing table, and nobody saw it because
 * nothing rendered the number. Tier pricing was going to be set from that.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { DollarSign, PhoneCall, AlertTriangle } from 'lucide-react';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '../../lib/SessionContext';
import { Card } from '../ui/Card';
import type { AiCostBreakdown } from '../../lib/types';

/** Cents-scale money needs more than 2 decimals to be readable at all. */
function usd(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
}

export default function AiCostPanel() {
  const tenantId = useActiveTenantId();
  const [data, setData] = useState<AiCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await Api.analytics.getAiCost(tenantId));
    } catch (e) {
      setError('Failed to load AI cost data');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId) return;
    void load();
  }, [tenantId, load]);

  if (loading) {
    return (
      <div className="text-sm text-muted" role="status" aria-live="polite">
        Loading AI cost…
      </div>
    );
  }
  // A real fetch failure and "the ledger has nothing yet" are different facts
  // for the operator reading this — only the former is an error worth
  // announcing to assistive tech.
  if (error) {
    return (
      <div className="text-sm text-muted" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return <div className="text-sm text-muted">No AI cost data</div>;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="w-4 h-4" style={{ color: 'var(--accent-soft)' }} />
        <h3 className="font-semibold text-sm">AI cost (month to date) — internal</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mb-4">
        <div>
          <div className="font-medium">Avg cost / call</div>
          <div data-testid="avg-cost-per-call">
            {/* NULL is rendered as "not measured yet", never as $0.00 — a zero
                here would read as "calls are free" and get priced from. */}
            {data.avg_cost_per_call_usd === null ? (
              <span className="text-muted">No calls costed yet</span>
            ) : (
              usd(data.avg_cost_per_call_usd, 4)
            )}
          </div>
        </div>
        <div>
          <div className="font-medium flex items-center gap-1">
            <PhoneCall className="w-3.5 h-3.5" /> Calls costed
          </div>
          <div data-testid="call-count">{data.call_count}</div>
        </div>
        <div>
          <div className="font-medium">Total spend</div>
          <div data-testid="total-cost">{usd(data.total_estimated_cost_usd, 2)}</div>
        </div>
      </div>

      {data.breakdown.length === 0 ? (
        <div className="text-sm text-muted">No AI usage recorded this month.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3">Source</th>
                <th className="py-1 pr-3">Model</th>
                <th className="py-1 pr-3 text-right">In / out tokens</th>
                <th className="py-1 pr-3 text-right">Chars</th>
                <th className="py-1 pr-3 text-right">Audio (s)</th>
                <th className="py-1 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.breakdown.map((row) => (
                <tr key={`${row.source}:${row.provider}:${row.model}`} data-testid="cost-row">
                  <td className="py-1 pr-3">{row.source}</td>
                  <td className="py-1 pr-3">{row.model}</td>
                  <td className="py-1 pr-3 text-right">
                    {row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}
                  </td>
                  <td className="py-1 pr-3 text-right">{row.characters_count.toLocaleString()}</td>
                  <td className="py-1 pr-3 text-right">
                    {Math.round(row.audio_duration_ms / 1000).toLocaleString()}
                  </td>
                  <td className="py-1 text-right">{usd(row.estimated_cost_usd, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* A leg priced at exactly $0 with real usage is the 35x-undercount shape.
          Say so on the screen rather than leaving a zero to be read as cheap. */}
      {data.breakdown.some(
        (r) =>
          r.estimated_cost_usd === 0 &&
          (r.input_tokens > 0 || r.characters_count > 0 || r.audio_duration_ms > 0)
      ) && (
        <div className="mt-3 flex items-start gap-2 text-xs" data-testid="unpriced-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
          <span>
            A model recorded real usage at $0.00 — it is missing from the pricing table in
            <code className="mx-1">src/services/aiCost.ts</code>. This total is an UNDERCOUNT.
          </span>
        </div>
      )}
    </Card>
  );
}
