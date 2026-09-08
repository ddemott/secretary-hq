/**
 * AiCostPanel — the operator's view of what a call costs (T-011).
 *
 * WHO: the platform operator setting tier prices.
 * WHAT: avg cost/call, the per-model breakdown, and a loud warning when a leg
 *       recorded real usage at $0.00.
 * WHEN: CI.
 * WHERE: dashboard/components/analytics/AiCostPanel.tsx.
 * WHY: the ledger once undercounted 35x — the production voice LLM was missing
 *      from the pricing table and every row for it read $0.00. Nothing broke,
 *      nothing was rendered, and tier pricing was about to be set from it. The
 *      two cases below are the two ways this screen could lie: showing $0.00
 *      where nothing was measured, and showing a total that silently omits a leg.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
}));

const { mockApi } = vi.hoisted(() => ({
  mockApi: { analytics: { getAiCost: vi.fn() } },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import AiCostPanel from './AiCostPanel';

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  source: 'voice_call',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  input_tokens: 120000,
  output_tokens: 2400,
  characters_count: 0,
  audio_duration_ms: 0,
  estimated_cost_usd: 0.05184,
  ...over,
});

beforeEach(() => {
  mockApi.analytics.getAiCost.mockReset();
});

describe('AiCostPanel', () => {
  test('HAPPY: shows the per-call average to four decimals and the breakdown rows', async () => {
    // Two decimals would render a $0.0612 call as "$0.06" — which is the whole
    // number, rounded away. Cost-of-goods at this scale needs the digits.
    mockApi.analytics.getAiCost.mockResolvedValue({
      breakdown: [
        row(),
        row({ model: 'nova-3', provider: 'deepgram', estimated_cost_usd: 0.0086 }),
      ],
      total_estimated_cost_usd: 0.1,
      call_count: 2,
      voice_call_cost_usd: 0.1224,
      avg_cost_per_call_usd: 0.0612,
    });

    render(<AiCostPanel />);

    expect(await screen.findByTestId('avg-cost-per-call')).toHaveTextContent('$0.0612');
    expect(screen.getByTestId('call-count')).toHaveTextContent('2');
    expect(screen.getAllByTestId('cost-row')).toHaveLength(2);
  });

  test('SAD: no costed call renders "No calls costed yet", NOT $0.00', async () => {
    // "We have not measured one" and "our calls are free" are different claims.
    // A $0.00 here is a number someone would price a tier from.
    mockApi.analytics.getAiCost.mockResolvedValue({
      breakdown: [],
      total_estimated_cost_usd: 0,
      call_count: 0,
      voice_call_cost_usd: 0,
      avg_cost_per_call_usd: null,
    });

    render(<AiCostPanel />);

    expect(await screen.findByTestId('avg-cost-per-call')).toHaveTextContent('No calls costed yet');
    expect(screen.getByTestId('avg-cost-per-call')).not.toHaveTextContent('$0.00');
  });

  test('SAD: a leg with real usage priced at $0 raises the undercount warning', async () => {
    // THE 35x bug, exactly: usage recorded, cost zero, total still plausible.
    mockApi.analytics.getAiCost.mockResolvedValue({
      breakdown: [row({ model: 'gpt-5-mini', estimated_cost_usd: 0 })],
      total_estimated_cost_usd: 0,
      call_count: 1,
      voice_call_cost_usd: 0,
      avg_cost_per_call_usd: 0,
    });

    render(<AiCostPanel />);

    expect(await screen.findByTestId('unpriced-warning')).toHaveTextContent(/UNDERCOUNT/);
  });

  test('SAD: a fully-priced breakdown does NOT raise the warning', async () => {
    // The warning has to be rare to be read. If it fired on every render it
    // would be furniture within a week.
    mockApi.analytics.getAiCost.mockResolvedValue({
      breakdown: [row()],
      total_estimated_cost_usd: 0.05184,
      call_count: 1,
      voice_call_cost_usd: 0.05184,
      avg_cost_per_call_usd: 0.05184,
    });

    render(<AiCostPanel />);

    await screen.findByTestId('avg-cost-per-call');
    expect(screen.queryByTestId('unpriced-warning')).not.toBeInTheDocument();
  });

  test('SAD: a failed fetch says so instead of rendering an empty $0 dashboard', async () => {
    mockApi.analytics.getAiCost.mockRejectedValue(new Error('500'));
    render(<AiCostPanel />);
    expect(await screen.findByText(/Failed to load AI cost data/i)).toBeInTheDocument();
  });
});
