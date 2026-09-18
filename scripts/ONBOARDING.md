# Client Onboarding Runbook

> ## ⚠️ THE VOICE-SCRIPT STEPS NO LONGER AFFECT CALLS (verified 2026-07-27)
>
> `setup-voice-script.ts`, `install-script.ts`, and `ladder-builder --build` all write
> `tenants.system_prompt` — the **prompt ladder**. Production runs the **question-tree**
> architecture (`agent/src/checklist/`, `ENABLE_QUESTION_TREE`, on unless set to
> `"false"`), and under it `ChecklistAgent` receives a ONE-LINE persona; the composed
> `system_prompt` is never passed to the model. **Installing a script onto a new tenant
> changes nothing about how their calls go.** Each tenant runs its OWN copy
> of the trees (`tenant_question_trees` / `tenant_question_nodes`, copied from the
> per-vertical templates when the business is created; existing tenants are rolled out
> with `npm run trees:rollout`). `PLATFORM_TREE_LIBRARY` in `agent/src/checklist/trees.ts`
> is the template content and the runtime fallback for a tenant with no rows.
>
> **What DOES shape a new tenant's calls:** their checklist preset (`tenants.checklist_preset_id`,
> derived from `business_type` unless pinned, plus `checklist_overrides` — Business Settings →
> Call checklist), their `tenants` row — `persona_name`,
> `first_message`, `call_disclosure`, `greeting_menu`, `greeting_closer` (the spoken
> greeting, composed by `agent/src/greeting.ts` on every flow), `timezone`, `tts_voice`
> — plus their business shape (services, employees, `employee_schedule`) and knowledge
> base. Those steps below are all still correct and still required.
>
> The script installers are kept for the `ENABLE_QUESTION_TREE=false` rollback path.
> See `docs/voice/QUESTION_TREE_ARCHITECTURE.md` and CLAUDE.md → `/agent`.

The exact order of operations to take a new client from "signed up" to "their AI answers the phone" — and the cleanup tools around it. Safety model: the **data-destroying** scripts (`clear-call-data`, `remove-customer`, `purge-soft-deleted`) are dry-run by default and need `--execute --yes` to act; the **script installers** (`setup-voice-script`, `ladder-builder --build`, `install-script`) always diff against and print the script they replace (and `ladder-builder` backs it up to `scripts/script-backups/` first). Everything that writes refuses a non-local database without `--force`.

## The scripts at a glance

| Script                  | What it does                                                                                                                      | Safety                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `onboard-tenant.ts`     | Tenant + secured owner login (+ optional voice preset) in one shot                                                                | Local-only guard; temp password printed once     |
| `setup-voice-script.ts` | **LADDER-ONLY — no effect on live calls.** Installs a business-type voice-script preset into `tenants.system_prompt`               | Diffs + prints what it replaces; `--dry-run`     |
| `install-script.ts`     | **LADDER-ONLY — no effect on live calls.** Bespoke voice script from a JSON composition                                            | Same diff behavior                               |
| `ladder-builder.ts`     | **LADDER-ONLY — `--build` has no effect on live calls.** Rung catalog (`--list`/`--show`), regenerates `docs/CALL_LADDER.md` (`--docs`; the committed copy is now `docs/voice/CALL_LADDER.md`) | Diff + automatic pre-install backup; `--dry-run` |
| `remove-customer.ts`    | Remove ONE customer + everything of theirs                                                                                        | Dry-run default; `--execute --yes` to act        |
| `clear-call-data.ts`    | Wipe ALL transactional data (customers, appointments, calls, audit trails) leaving the business shape intact; `--tenant` to scope | Dry-run default; `--execute --yes` to act        |
| `purge-soft-deleted.ts` | Hard-destroy soft-deleted tenants (maintenance window act)                                                                        | Dry-run default                                  |

## Onboarding a client, step by step

### 1. Create the tenant + owner login

```bash
npx tsx scripts/onboard-tenant.ts \
  --name "Bella's Hair Studio" --type salon \
  --owner-email bella@bellashair.com --owner-name "Bella Ramos" \
  --owner-phone "+16305551234" \
  --voice-preset salon --assistant-name Bella
```

This prints a **one-time temporary password**. Security rules baked into the flow:

- Deliver the temp password over a trusted channel (phone/in person — not email).
- The owner changes it at first login. Sessions expire after 8h; changing the password invalidates old tokens.
- Staff never share the owner login — invite them from **Setup → Team Access** with role `front_desk` (they see only Home/Schedule/Customers/Calls).
- Tenant isolation is middleware-enforced; there is nothing per-client to configure.

### 2. Business shape — run the Setup Wizard WITH the owner

Log in as the owner and walk the dashboard **Setup Wizard**. It seeds services/resources from the business-type template, collects staff and working days, and expands the weekly schedule. Don't script around it — the wizard is the product's onboarding UX and asking the vertical's questions with the client in the room is where you catch the "oh, we also do X" surprises.

### 3. Voice script — **SKIP THIS. It does nothing under question trees.**

Formerly: `setup-voice-script.ts --tenant <id> --type salon`, or a JSON composition via
`install-script.ts`. Both write `tenants.system_prompt`, which the live call flow never
reads (see the banner at the top). Running them is harmless but pointless; the
`--voice-preset` flag on `onboard-tenant.ts` in step 1 is equally inert.

**There is no per-tenant call SCRIPT.** What a tenant's calls ask is set by its question
trees (its own DB copy, `tenant_question_trees` / `tenant_question_nodes`) and by its
checklist preset (`tenants.checklist_preset_id` + `checklist_overrides`, editable in Business
Settings → Call checklist with a next-call dry-run). The preset decides which trees a call can
reach — overrides can only SUBTRACT blocks, never add one. The tree the caller lands in is
chosen at call time from their opener. A business whose calls need a question that no
preset's trees carry needs a **new tree** (`agent/src/checklist/trees.ts` /
`verticalIntakeTrees.ts` + a preset that offers it — a code change + deploy), not a script.

What actually differentiates this tenant's calls is step 4, plus their business shape from
step 2. Go there.

### 4. Teach the AI + pick the voice

- **Phone Assistant → Knowledge Base**: website scan / FAQ upload / Teach-Your-AI questionnaire.
- **Phone Assistant → AI Persona**: voice (6 options), style toggles, greeting, caller disclosure (attestation-gated). The speed slider is saved but inert under Deepgram Aura (the UI says so).
- If ANY TTS setting changes at the engine level: `cd agent && npm run verify:tts` is **mandatory** before prod ("it compiles" ≠ "it makes noise").

### 5. Verify before go-live (no phone needed)

```bash
./scripts/simulate.sh status --env local      # systems up
./scripts/simulate.sh tools                   # agent-tools journey works
./scripts/simulate.sh toolselect              # LLM picks the right tools
./scripts/simulate.sh call --tenant <id>      # talk to it in a browser with a mic
```

### 6. Go-live

- Provision their number: `POST /provisioning/activate` (search → purchase → assign to SIP connection).
- Make a **real PSTN test call** from a different carrier before handing over.
- Billing: attach Stripe from the Billing sub-tab when they subscribe.
- SMS stays **off** until that tenant's own 10DLC brand+campaign is registered (per-tenant legal name/EIN/address; ~$12-13/mo; 1–3 business days). Until then the agent makes no texting promises — don't either.

## Cleanup tools

```bash
# Reset the whole (local) system to just-set-up: keeps tenants/users/staff/services/shifts/KB,
# removes customers, appointments, calls, messages, reminders, and audit trails.
npx tsx scripts/clear-call-data.ts                    # dry run
npx tsx scripts/clear-call-data.ts --execute --yes    # do it
npx tsx scripts/clear-call-data.ts --tenant <id> --execute --yes   # one tenant only

# Remove a single customer and everything of theirs
npx tsx scripts/remove-customer.ts --tenant <id> --phone "(630) 555-1234"   # dry run
npx tsx scripts/remove-customer.ts --customer <uuid> --execute --yes
```

Note on `remove-customer.ts` vs the legal-hold purge: PR #68 (`POST /customers/:id/purge`) is the **product** GDPR-erasure feature and stays unmerged pending owner + legal sign-off. `remove-customer.ts` is a manual operator tool in the `purge-soft-deleted.ts` tradition — destruction as a deliberate human act with the blast radius shown first. Aiming it at production for a real erasure request is a human decision made with legal context.
