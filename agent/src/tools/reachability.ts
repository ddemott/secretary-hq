/**
 * Tools that exist in buildTools() but selectedTools() never offers on the
 * production question-tree path. Not a delete list. Each entry is a verdict:
 * why it stays defined, and why it is not wired into a tree.
 *
 * Origin: docs/TODO.md reachability audit (2026-07-27, re-audited 2026-08-03).
 * The four "still undecided" tools are decided here as KEEP-UNWIRED — wiring
 * or deleting them is a product call, not a refactor side effect.
 *
 * transfer_call LEFT this list 2026-09-14: it is now an always-on checklist
 * passthrough when the tenant has a forward number (ALWAYS_ON_PASSTHROUGH_TOOLS
 * + offerTransfer). SIP REFER itself was never the blocker.
 */
export const DEFINED_UNREACHABLE_ON_QUESTION_TREE: Record<string, string> = {
  start_booking: 'ladder router; production runs question trees (ENABLE_QUESTION_TREE)',
  manage_appointment: 'ladder router; production runs question trees',
  book_appointment: 'superseded by book_with_scheduling',
  check_availability: 'superseded by get_available_slots / book_with_scheduling',
  get_scheduling_options: 'superseded by get_available_slots / book_with_scheduling',
  send_self_service_link: 'sms capability; gated off until 10DLC',
  record_sms_consent: 'sms capability; gated off until 10DLC',
  page_owner_via_sms: 'not selected by any tree; kept, not deleted',
  save_customer_preference:
    'not model-facing; remember_preference (host tool in checklistTools) calls it to flush',
  get_detailed_customer_history: 'not on a tree; live identity path uses get_customer_context',
  find_caller_by_name: 'deliberately excluded — name enumeration; never wire without tightening',
  identify_caller: 'host-code-only via maybeIdentify(); never model-facing',
  get_company_policy_answer:
    'model-facing name on trees is answer_question (host wrapper in checklistTools)',
};
