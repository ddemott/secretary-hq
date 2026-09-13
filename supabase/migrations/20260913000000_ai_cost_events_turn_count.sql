-- The AI cost ledger could not answer "how many turns did this call take?" —
-- the per-turn latency samples that would answer it exist only transiently in
-- the agent process, and the ONE place they are shipped to the backend
-- (voice-session-end's turn_latency_ms) is immediately folded into a
-- Prometheus histogram and discarded (src/routes/agentTools/session.ts:
-- `for (const ms of args.turn_latency_ms ?? []) turnLatencyMs.observe(ms)`).
-- Nothing persists the count per call, so a repricing decision could only
-- ever look at cost-per-call, never cost-per-turn — and turn count, not
-- wall-clock call length, is what actually drives cost (the checklist state
-- + tool schemas resent every turn dominate token usage).
--
-- Nullable and denormalized onto every ai_cost_events row for a call (see
-- src/routes/agentTools/aiCost.ts) rather than living only on voice_sessions:
-- a call's cost and its turn count need to answer the same question from one
-- table without a join. Only ever set for source='voice_call' — KB
-- ingestion/query/summary rows have no turns and stay NULL.
ALTER TABLE ai_cost_events ADD COLUMN IF NOT EXISTS turn_count INTEGER;

COMMENT ON COLUMN ai_cost_events.turn_count IS
  'Total conversational turns on the call (TurnLatencyCollector.totalCount() — accepted + dropped latency samples, so a long call is not undercounted by the latency array''s own cap). NULL for non-voice_call sources and for calls that predate this column.';
