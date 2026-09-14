# transfer_call blind spots (question-tree path)

Status: durable ops note from design review (2026-09-14). Not a how-to wire the tool — see `docs/planning/TODO.md` for the open code item.

## What is true today

- `transfer_call` (SIP REFER via LiveKit) is implemented: tool, executor, timeout, outcome recording, loop guard.
- On production question-tree calls (`ChecklistAgent` + `selectedTools()`), the tool is **unreachable**: it is not a base tool, not in `TREE_PASSTHROUGH_TOOLS`, and not a tree action node.
- The greeting still offers **"representative"** when a forward number is set (`CLOSER_WITH_TRANSFER`), so callers can ask for a human while the model has no transfer tool.
- Owner-facing escalation today is **take a message** (optional `is_urgent`), not live handoff.

`docs/operations/RUNBOOK.md` §7c is the first ops check when "transfer fails": tool not in toolset before Telnyx/SIP debugging.

## Failure modes to design before wire-up

Do not allowlist the tool until these have an explicit product answer:

| Area | Modes |
|------|--------|
| Config / offer | No forward number; transfer loop (forward == inbound/forwarded-from); executor null (missing LiveKit SIP participant); greeting offers human without tool (current gap) |
| SIP runtime | REFER reject/error; 10s timeout; cold REFER ok with no human answer; destination shows trunk CID not original caller |
| Double path | Second `transfer_call` on same session; keep talking after success; race with `finish_call`; retry loop after failure |
| Goodbye gate | Transfer mid-open checklist must be a terminal exit (bypass `isResolved` on success); failed transfer then goodbye still blocked until message/book resolved; never claim transferred without tool ok |

## Design lean (open decision)

Prefer an **always-on host-gated tool** when `canOfferTransfer`, not a checklist action node: human request is an exit, not a goal node. On success: terminal transferred/closing without requiring full checklist resolve. On failure: force message path — no "connecting" limbo.

## Live validation alignment

- **Before wire-up:** Dale checklist step 4 = failure-mode observation (no cell ring expected). Prefer word "representative". Pass = clean degrade + transcript. Booking/urgent DoD: `docs/planning/PRODUCT_ROADMAP.md` T-003.
- **After wire-up:** new card — cell rings, Calls tab `transferred`, failure fallback, no double-REFER, mid-checklist exit clean.

## Related files

- `agent/src/tools/transfer.ts`, `agent/src/transferClient.ts`
- `agent/src/checklist/checklistTools.ts` (`selectedTools`, `TREE_PASSTHROUGH_TOOLS`)
- `agent/src/tools/reachability.ts` (`DEFINED_UNREACHABLE_ON_QUESTION_TREE.transfer_call`)
- `agent/src/greeting.ts`, `shared/phone.ts` (`canTransfer`)
- `docs/operations/OWNER_GUIDE.md` (human FAQ), `docs/operations/RUNBOOK.md` §7c
- `docs/planning/TODO.md` P0 §1, `docs/planning/PRODUCT_ROADMAP.md` T-003
