# SecretaryHQ — Architecture Diagrams

Companion to `ARCHITECTURE.md`. Every diagram is a Mermaid block — renders natively on GitHub and on claude.ai (paste into chat, or upload this file and ask for an artifact).

**Last synced to architecture doc:** 2026-09-18 (filesystem-verified: migration count, PK names/columns in the ER diagram, call-end path, nav tabs, RLS role)

## Contents

1. [Deployment Topology](#1-deployment-topology)
2. [Data Model (ER)](#2-data-model-er)
3. [Voice Call Flow — Current (LiveKit Agent)](#3-voice-call-flow--current-livekit-agent)
4. [Voice Call Flow — Historical (pre-661d21d, Vapi + Edge Function)](#4-voice-call-flow--historical-pre-661d21d-vapi--edge-function)
5. [Booking — 7-Layer Atomic Check](#5-booking--7-layer-atomic-check)
6. [OAuth Flow (Generic, Calendar Providers)](#6-oauth-flow-generic-calendar-providers)
7. [Calendar + Square CRM Sync Fan-out](#7-calendar--square-crm-sync-fan-out)
8. [Auth Flow (JWT + Refresh + Force-logout)](#8-auth-flow-jwt--refresh--force-logout)
9. [Billing State Machine](#9-billing-state-machine)
10. [Dashboard Component Hierarchy](#10-dashboard-component-hierarchy)
11. [RLS Context Flow (withTenantClient)](#11-rls-context-flow-withtenantclient)
12. [Call Sequencing — Question Trees (the LIVE call architecture)](#12-call-sequencing--question-trees-the-live-call-architecture)

---

## 1. Deployment Topology

Physical layout post-LiveKit migration (`661d21d`, 2026-04-27).

```mermaid
flowchart TB
  Caller([Caller phone])
  Telnyx["Telnyx SIP Trunk<br/>+1 630 822 9086 (live)"]
  Caller -->|PSTN| Telnyx

  LiveKit["LiveKit Cloud<br/>SIP bridge + rooms<br/>dispatch rule SDR_WEL49AwBB4NW"]
  Telnyx -->|SIP via livekit-outbound| LiveKit

  subgraph agentBox["Agent Worker — Railway: secretary-hq-agent"]
    direction TB
    Agent["Node + LiveKit Agents SDK<br/>worker AW_vPmGExrgTeGn"]
    DG["Deepgram Nova-3 STT"]
    OAI["OpenAI GPT-4.1-mini LLM"]
    TTS["Deepgram Aura TTS<br/>(streaming; per-tenant via tenants.tts_voice)"]
    Agent --> DG
    Agent --> OAI
    Agent --> TTS
  end

  LiveKit -->|WebSocket| Agent

  Fastify["Fastify Backend<br/>29 route modules + agentTools dir<br/>secretary-hq-production.up.railway.app<br/>(Railway + Nixpacks, Node 22)"]
  Agent -->|POST /agent-tools/* + x-agent-secret| Fastify

  Postgres[("Postgres + pgvector<br/>Supabase us-west-2<br/>206 migrations")]
  Stripe["Stripe"]
  Integrations["Google / Outlook calendars<br/>+ Square CRM"]
  Dashboard["Next.js 16 Dashboard<br/>dashboard-production-cee3.up.railway.app"]

  Fastify --> Postgres
  Fastify --> Stripe
  Fastify --> Integrations
  Dashboard -->|Api.* calls| Fastify

  style agentBox fill:#1a2a1a,stroke:#484
```

---

## 2. Data Model (ER)

The core tenant-scoped tables and relationships (the full schema has grown to ~40 RLS-enabled tables — see `supabase/baseline.sql`; PKs follow the `<table_singular>_id` convention). `business_templates`, `audit_log`, `record_versions`, `voice_sessions`, `consent_records`, `opt_out_records` are global/platform-scoped and omitted here for clarity. `tenant_integration_settings` (Square OAuth tokens) and `entity_sync_map` (Square local↔external ID mapping) are actively written by the live Square CRM sync — the only external CRM surviving the 2026-06-12 removal of Jobber/HubSpot/ServiceTitan/GoHighLevel. Calendar sync uses `appointment_sync_map`.

```mermaid
erDiagram
  tenants ||--o{ users : "has"
  tenants ||--o{ customers : "owns"
  tenants ||--o{ employees : "employs"
  tenants ||--o{ resources : "owns"
  tenants ||--o{ services : "offers"
  tenants ||--o{ appointments : "books"
  tenants ||--o{ tenant_skills : "defines"
  tenants ||--o{ tenant_docs : "knows"
  tenants ||--o{ call_transcripts : "records"
  tenants ||--o{ call_summaries : "summarizes"
  tenants ||--o{ tenant_integration_settings : "configures"
  tenants ||--o{ tenant_calendar_settings : "configures"
  tenants ||--o{ reminder_schedules : "schedules"
  tenants ||--o{ unanswered_questions : "logs"

  employees ||--o{ employee_schedule : "scheduled"
  employees ||--o{ service_employee : "qualified for"
  services ||--o{ service_employee : "performed by"
  services ||--o{ service_resource : "needs resource"
  resources ||--o{ service_resource : "capable of"

  customers ||--o{ appointments : "books"
  employees ||--o{ appointments : "assigned"
  resources ||--o{ appointments : "occupies"
  services ||--o{ appointments : "for"

  call_transcripts ||--o| call_summaries : "summarized as"
  appointments ||--o{ appointment_sync_map : "external id"
  customers ||--o{ entity_sync_map : "external id"

  tenants {
    uuid tenant_id PK
    text name
    text inbound_phone
    text subscription_status
    text subscription_plan
    text timezone
    int sort_order
  }
  users {
    uuid user_id PK
    uuid tenant_id FK
    text email "unique per (tenant_id, email)"
    text password_hash
  }
  customers {
    uuid customer_id PK
    uuid tenant_id FK
    text phone "E.164"
    text name
    bool is_deleted
  }
  employees {
    uuid employee_id PK
    uuid tenant_id FK
    text name
    text first_name
    text last_name
    bool is_deleted
  }
  employee_schedule {
    uuid tenant_id PK
    uuid employee_id PK
    date shift_date PK
    time start_time
    time end_time "may be cross-midnight"
    bool is_off
  }
  resources {
    uuid resource_id PK
    uuid tenant_id FK
    text name
    bool is_deleted
  }
  services {
    uuid service_id PK
    uuid tenant_id FK
    text name
    int duration_minutes
    numeric price
    bool is_deleted
  }
  appointments {
    uuid appointment_id PK
    uuid tenant_id FK
    timestamptz start_time
    timestamptz end_time
    uuid customer_id FK
    uuid employee_id FK
    uuid resource_id FK
    uuid service_id FK
    text status
    text call_id
  }
  tenant_docs {
    uuid tenant_doc_id PK
    uuid tenant_id FK
    text title
    text source
    text content
    text normalized_text
    vector embedding "dim 1536"
  }
  call_transcripts {
    uuid call_transcript_id PK
    uuid tenant_id FK
    text call_id
    text raw_text
  }
  call_summaries {
    uuid call_summary_id PK
    uuid tenant_id FK
    text call_id
    text summary
    vector embedding
  }
  tenant_integration_settings {
    uuid tenant_id PK
    text provider PK "square only"
    text access_token
    text refresh_token
    timestamptz token_expires_at
    bool is_active
  }
  entity_sync_map {
    uuid entity_sync_map_id PK
    uuid tenant_id FK
    text entity_type
    uuid local_id
    text provider
    text external_id
    timestamptz remote_updated_at
  }
  service_employee {
    uuid tenant_id FK
    uuid service_id FK
    uuid employee_id FK
  }
  service_resource {
    uuid service_id FK
    uuid resource_id FK
  }
```

---

## 3. Voice Call Flow — Current (LiveKit Agent)

Post-migration (`661d21d`, 2026-04-27). Tool calls hit Fastify `/agent-tools/*` directly. Current voice stack: Telnyx → LiveKit Cloud → Deepgram Nova-3 STT → OpenAI GPT-4.1-mini → Deepgram Aura TTS. Live call sequencing is question trees (see `QUESTION_TREE_ARCHITECTURE.md`).

```mermaid
sequenceDiagram
  autonumber
  actor Caller
  participant Telnyx
  participant LK as LiveKit Cloud
  participant Agent as Agent Worker<br/>(Node on Railway)
  participant DG as Deepgram STT
  participant OAI as OpenAI LLM
  participant TTS as Deepgram Aura TTS (per-tenant voice)
  participant API as Fastify<br/>/agent-tools/*
  participant DB as Postgres

  Caller->>Telnyx: Dial +1 (630) 822-9086
  Telnyx->>LK: SIP INVITE → inbound trunk
  LK->>LK: dispatch rule SDR_WEL49AwBB4NW<br/>→ create room, metadata = { tenant_id }
  LK->>Agent: room.created event (WebSocket)
  Agent->>LK: join room
  Agent->>Caller: greeting (TTS audio)

  loop each turn
    Caller->>LK: audio frames
    LK->>Agent: audio stream
    Agent->>DG: STT (Nova-3)
    DG-->>Agent: transcript
    Agent->>OAI: LLM (GPT-4.1-mini)
    OAI-->>Agent: text + tool calls
    opt tool call
      Agent->>API: POST /agent-tools/{name}<br/>+ x-agent-secret<br/>body contains tenant_id
      API->>DB: withTenantClient → RPC
      DB-->>API: result
      API-->>Agent: { success: true, result: ... }
    end
    Agent->>TTS: synthesize
    TTS-->>Agent: audio
    Agent->>LK: publish audio
    LK->>Caller: audio
  end

  Caller--xLK: hangup
  LK->>Agent: room.closed
  Agent->>Agent: post-call summary (callSummary.ts, bounded)
  Agent->>API: POST /agent-tools/voice-session-end<br/>(duration, outcome, transcript, summary, appointment_id)
  API->>DB: end_voice_session() RPC<br/>(voiceSessionReaper backstops a missed call)
  Note over API: calendar + Square sync fires earlier,<br/>fire-and-forget from the booking route
```

---

## 4. Voice Call Flow — Historical (pre-`661d21d`, Vapi + Edge Function)

> **Retired 2026-04-27.** The Vapi orchestration and `supabase/functions/vapi-tools/` Deno edge function were both deleted in commit `661d21d`. Section retained as a reference for anyone debugging old call recordings or transcript schemas.

```mermaid
sequenceDiagram
  autonumber
  actor Caller
  participant Telnyx
  participant Vapi as Vapi Orchestrator
  participant TTS as TTS Proxy<br/>src/routes/tts.ts
  participant XAI as xAI Grok TTS (historical Vapi-era retired flow)
  participant Edge as Edge Fn<br/>vapi-tools
  participant DB as Postgres
  participant API as Fastify /voice

  Caller->>Telnyx: Dial +1 (630) 822-9086
  Telnyx->>Vapi: SIP INVITE
  Vapi->>Vapi: STT warmup (Deepgram)
  Vapi->>Caller: greeting (TTS audio)

  loop each turn
    Caller->>Vapi: speech
    Vapi->>Vapi: STT (Deepgram Nova-2)
    Vapi->>Vapi: LLM (GPT-4o-mini)
    opt LLM issues tool call
      Vapi->>Edge: POST /vapi-tools<br/>+ x-vapi-secret
      Edge->>Edge: Zod validate
      Edge->>DB: RPC or pgvector query
      DB-->>Edge: rows / error code
      Edge-->>Vapi: { results: [...] }<br/>or "ERROR: ..."
    end
    Vapi->>TTS: voice-request + x-vapi-secret
    TTS->>XAI: POST /v1/tts (15s abort)
    XAI-->>TTS: audio stream
    TTS-->>Vapi: audio stream
    Vapi->>Caller: TTS audio
  end

  Caller--xTelnyx: hangup
  Telnyx->>Vapi: BYE
  Vapi->>API: POST /voice/call-ended (webhook)
  API->>API: generate summary + embedding
  API->>DB: INSERT call_summaries<br/>link_orphaned_transcripts()
  API-)API: fire-and-forget CRM + calendar sync
```

---

## 5. Booking — 7-Layer Atomic Check

`book_with_scheduling_atomic()` runs every check inside one transaction. Each specific failure returns a distinct error code (BUG-064) so the LLM can phrase it naturally to the caller.

```mermaid
sequenceDiagram
  autonumber
  participant LLM
  participant Tool as POST /agent-tools/book-with-scheduling<br/>(Fastify)
  participant RPC as book_with_scheduling_atomic()
  participant DB as Postgres

  LLM->>Tool: serviceName, startTime, phone,<br/>name, requiredEmployeeSkills[]
  Tool->>Tool: Zod validate
  Tool->>RPC: BEGIN

  Note over RPC,DB: atomic — all checks or nothing
  RPC->>DB: 1. Past-time check<br/>(now AT TIME ZONE tenant.tz)
  alt in the past
    RPC-->>Tool: PAST_TIME
    Tool-->>LLM: { success: false, error }
  end

  RPC->>DB: 2. Closed-day check (blackout_dates)
  alt business closed that day
    RPC-->>Tool: BUSINESS_CLOSED
  end
  RPC->>DB: 3. Resource availability<br/>(no overlap on resource_id)
  alt resource busy
    RPC-->>Tool: TIMESLOT_OCCUPIED
  end

  RPC->>DB: 4. Staff on shift<br/>(employee_schedule date-based,<br/>night-shift aware, DST-safe)
  alt nobody scheduled
    RPC-->>Tool: EMPLOYEE_NOT_SCHEDULED
  end

  RPC->>DB: 5. Staff expertise<br/>(service_employee ∩ skill)
  alt no qualified employee
    RPC-->>Tool: NO_SKILLED_EMPLOYEE
  end

  RPC->>DB: 6. Resource capability<br/>(service_resource)
  alt no capable resource
    RPC-->>Tool: NO_AVAILABILITY
  end

  RPC->>DB: 7. Customer upsert by phone
  RPC->>DB: auto end_time from service.duration_minutes
  RPC->>DB: INSERT appointments
  RPC->>RPC: COMMIT
  RPC-->>Tool: { appointment_id, customer_id, employee_id, resource_id }
  Tool-->>LLM: success
```

---

## 6. OAuth Flow (Generic, Calendar Providers)

One factory (`oauthCallbackFactory.ts`) + one token refresher (`tokenManagement.ts`) back both calendar integrations: Google Calendar and Outlook. (The competitor-CRM OAuth flows — Jobber, HubSpot, ServiceTitan, GoHighLevel — were removed 2026-06-12.) **Square** — the surviving external CRM sync — uses its own OAuth path in `src/services/crm/squareClient.ts` (`getAuthUrl` / `verifyState` / `exchangeCodeForTokens`) plus webhook HMAC-SHA256 verification (`SQUARE_WEBHOOK_SIGNATURE_KEY`) at `POST /square/webhook`, not the generic calendar factory; its tokens still land in `tenant_integration_settings`.

```mermaid
sequenceDiagram
  autonumber
  actor Owner as Owner (dashboard)
  participant API as Fastify<br/>/{provider}/auth/*
  participant Factory as oauthCallbackFactory
  participant Provider as Provider<br/>(Google/Outlook)
  participant DB as tenant_integration_settings
  participant Token as tokenManagement.ts

  rect rgb(40, 50, 70)
    Note over Owner,DB: Initial connect
    Owner->>API: GET /{provider}/auth/start
    API->>Factory: sign state JWT<br/>(tenant_id, csrf_nonce)
    Factory-->>Owner: 302 to provider authorize URL
    Owner->>Provider: authorize (browser)
    Provider-->>Owner: 302 to callback<br/>?code=...&state=...
    Owner->>API: GET /{provider}/auth/callback
    API->>Factory: verify state JWT (CSRF)
    Factory->>Provider: exchange code<br/>for access+refresh tokens
    Provider-->>Factory: tokens + expires_in
    Factory->>DB: upsert tokens (RLS-scoped)
    Factory-->>Owner: 302 to dashboard
  end

  rect rgb(40, 60, 45)
    Note over API,Token: Later — any call that needs a token
    API->>Token: getValidToken(tenantId, provider)
    Token->>DB: SELECT tokens
    alt expires_at - now < 5min
      Token->>Provider: POST /oauth/token<br/>(refresh_token grant)
      alt refresh ok
        Provider-->>Token: fresh tokens
        Token->>DB: UPDATE tokens
      else refresh fails
        Token->>DB: UPDATE is_active = false
        Token-->>API: throw<br/>(dashboard shows "Reconnect required")
      end
    end
    Token-->>API: access_token
  end
```

---

## 7. Calendar + Square CRM Sync Fan-out

The 4 appointment mutation points fan out through `syncOrchestrator.ts` to 2 calendar providers (push-only) **and** Square (the surviving external CRM sync, bidirectional). Each provider fails independently — one bad provider never blocks another. (The competitor-CRM providers — Jobber/HubSpot/ServiceTitan/GoHighLevel — were removed 2026-06-12; **Square remains live**.)

```mermaid
flowchart LR
  subgraph triggers["Mutation points in routes"]
    A1[appointment create]
    A2[appointment update]
    A3[appointment delete]
    A4[appointment cancel]
  end

  Orch["syncOrchestrator.ts<br/>(fire-and-forget fan-out)"]

  A1 & A2 & A3 & A4 --> Orch

  CalSync["calendarSync.ts"]
  SqSync["crm/squareSync.ts"]

  Orch --> CalSync
  Orch --> SqSync

  subgraph cal["Calendars (push-only)"]
    G[Google Calendar]
    O[Outlook / MS Graph]
  end

  CalSync --> G
  CalSync --> O

  subgraph crm["Square CRM (bidirectional)"]
    SQ[Square API + /square/webhook]
  end

  SqSync --> SQ

  ASM[("appointment_sync_map")]
  ESM[("entity_sync_map")]
  CalSync <--> ASM
  SqSync <--> ESM
```

---

## 8. Auth Flow (JWT + Refresh + Force-logout)

8-hour JWT, client-side pre-emptive refresh 10 min before expiry, force-logout on `TENANT_NOT_FOUND`.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Dash as Dashboard<br/>(SessionContext)
  participant API as Fastify /auth

  Note over User,API: Register
  User->>Dash: register form
  Dash->>API: POST /register<br/>(email, password, company, business_type)
  API->>API: bcrypt hash
  API->>API: INSERT tenants + users<br/>(email unique per-tenant, not global)
  API->>API: jwt.sign(tenant_id, user_id, email)<br/>expires 8h
  API-->>Dash: { token, tenant_id, user_id }
  Dash->>Dash: localStorage.setItem

  Note over User,API: Login
  User->>Dash: login form
  Dash->>API: POST /login<br/>(rate-limit 5 / 5min)
  API->>API: SELECT user → bcrypt.compare
  API-->>Dash: { token }

  Note over Dash,API: Any authenticated call
  Dash->>API: GET /resource<br/>Authorization Bearer jwt

  alt valid
    API-->>Dash: 200 { data }
  else 401 TOKEN_EXPIRED
    API-->>Dash: 401
    Dash->>API: POST /auth/refresh<br/>(verifies signature, ignores exp)
    API-->>Dash: fresh token
    Dash->>API: retry original
  else 401 TENANT_NOT_FOUND
    API-->>Dash: 401
    Dash->>Dash: forceLogout()<br/>clear localStorage + redirect
  else 402 SUBSCRIPTION_REQUIRED
    API-->>Dash: 402 + upgrade_url
    Dash->>Dash: show upgrade modal
  end

  Note over Dash: pre-emptive refresh<br/>10 min before expiry
```

---

## 9. Billing State Machine

Intended Stripe flow in code. The route handles three webhook events once wired, but **no Stripe webhook endpoint is registered yet**, and final public pricing is still provisional. `subscriptionGateMiddleware` returns 402 on tenant-scoped routes whenever `subscription_status` is outside `{active, trialing}`.

```mermaid
stateDiagram-v2
  [*] --> NoSub: tenant created

  NoSub --> Checkout: POST /billing/checkout
  Checkout --> NoSub: user cancels
  Checkout --> Active: checkout.session.completed

  Active --> PastDue: invoice.payment_failed
  PastDue --> Active: payment retry succeeds
  PastDue --> Canceled: customer.subscription.deleted
  Active --> Canceled: customer.subscription.deleted

  Canceled --> NoSub: stripe_subscription_id nulled
  Canceled --> Checkout: re-subscribe

  state Active {
    [*] --> Solo
    Solo: Solo label in code<br/>(pricing provisional)
    Growth: Growth label in code<br/>(pricing provisional)
    Professional: Professional label<br/>(not yet launched)
    Solo --> Growth: plan switch
    Growth --> Solo: plan switch
    Solo --> Professional
    Growth --> Professional
  }

  note right of PastDue
    subscriptionGateMiddleware returns 402
    Exempt: /billing/*, /auth/*, /health
  end note
```

---

## 10. Dashboard Component Hierarchy

Provider tree + single primary tab bar (Primary tabs always visible, Advanced tabs gated to owners + admins). UI primitives under `components/ui/` are consumed throughout.

```mermaid
flowchart TB
  Layout["app/layout.tsx<br/>ErrorBoundary + ToastContainer"]

  subgraph Contexts["React Contexts (dashboard/lib/)"]
    direction LR
    Session["SessionContext<br/>JWT + useActiveTenantId + tenantsVersion"]
    Theme["ThemeContext<br/>8 themes, CSS vars"]
    Vocab["VocabularyContext<br/>3-tier label fallback"]
    ApptDetail["AppointmentDetailContext"]
  end

  Layout --> Contexts
  Layout --> Landing["app/page.tsx<br/>Marketing landing"]
  Contexts --> Shell["app/dashboard/page.tsx<br/>Single-route app shell<br/>?tab=... URL sync"]

  Shell --> Primary["Primary tabs (always visible)"]
  Shell --> Advanced["Advanced tabs (owners + admins)"]
  Shell --> Wizard["SetupWizard — 7 steps<br/>+ WizardModeChooser (solo/team)"]

  Primary --> Home["Home<br/>dashboard"]
  Primary --> Schedule["Schedule<br/>NewSchedulerView"]
  Primary --> CRMView["Customers"]
  Primary --> Calls["Calls"]

  Schedule --> StaffRow["StaffRow"]
  Schedule --> ResCol["ResourceColumns"]
  Schedule --> QuickBook["QuickBookPanel"]
  Schedule --> DayFocus["EmployeeDayFocusPanel"]
  Schedule --> Profile["StaffProfileCard"]

  Advanced --> Setup["Setup<br/>My Business / My Team / Business Settings sub-tabs"]
  Advanced --> AIInsights["Phone Assistant<br/>persona / knowledge base / analytics"]

  subgraph UI["components/ui/ — shared primitives (subset shown)"]
    direction LR
    Button
    Card
    Modal
    ConfirmModal
    Toast
    FolderTabs
    Input
    Select
    Badge
    Feedback[FeedbackButton]
    Coverage[CoverageBar]
    Phone[PhoneInput]
    TimeInput
  end

  Shell -.consumes.-> UI
  Primary -.consumes.-> UI
  Advanced -.consumes.-> UI
  Wizard -.consumes.-> UI

  API["lib/api.ts<br/>Api.{resource}.{action}() — fully typed"]
  Shell -.HTTP.-> API
  API -->|Bearer JWT| Fastify["Fastify Backend"]
```

---

## 11. RLS Context Flow (withTenantClient)

Shows how per-request tenant isolation is enforced on a single shared `DATABASE_URL` pool, and why production must connect as the non-bypass role `app_user` (not a superuser) for the policies to bind.

```mermaid
sequenceDiagram
  autonumber
  participant Route as Fastify Route
  participant WTC as withTenantClient()
  participant Pool as pg Pool<br/>(DATABASE_URL, single)
  participant Client as Postgres client
  participant RLS as RLS Policy

  Route->>WTC: withTenantClient(pool, tenantId,<br/>async (c) => { ... })
  WTC->>Pool: pool.connect()
  Pool-->>WTC: client

  WTC->>Client: SELECT set_tenant_context($1)
  Note right of Client: sets app.current_tenant_id<br/>on this session
  Client-->>WTC: ok

  WTC->>Route: invoke handler(client)
  Route->>Client: SELECT * FROM customers
  Client->>RLS: evaluate USING clause
  Note right of RLS: tenant_id =<br/>current_setting('app.current_tenant_id')::uuid
  RLS-->>Client: filtered rows
  Client-->>Route: rows (this tenant only)

  Note over Client,RLS: Production connects as app_user<br/>(non-superuser, no BYPASSRLS) so the<br/>policy really applies. FORCE ROW LEVEL<br/>SECURITY also binds the table owner,<br/>but never a superuser/BYPASSRLS role.

  Route-->>WTC: handler returns value
  WTC->>Client: set_config('app.current_tenant_id', '', false)
  WTC->>Client: client.release()
  WTC-->>Route: result

  Note over Route: Admin routes (super-admin tenant<br/>00000000-0000-0000-0000-000000000000)<br/>skip set_tenant_context entirely.<br/>tenants, users, business_templates<br/>have admin-bypass policies:<br/>if context is NULL, allow all rows.
```

---

## 12. Call Sequencing — Question Trees (the LIVE call architecture)

Diagram 3 shows the MEDIA pipeline (audio in, audio out). This shows how the
conversation is SEQUENCED — which is a separate thing, chosen by flag in
`agent/src/index.ts`, and the part most likely to be misread from older docs.

Production runs `ChecklistAgent` (`ENABLE_QUESTION_TREE`, on unless set to `"false"`).
The prompt ladder (`tenants.system_prompt`) and the TaskGroup rungs are fallbacks and
are **not** what a live call executes.

```mermaid
flowchart TB
  Start["index.ts — session start"] --> Greet["session.say(buildGreeting(tenantConfig))<br/>pre-generated; runs on EVERY flow"]
  Greet --> Flag{"ENABLE_QUESTION_TREE<br/>!== 'false'"}
  Flag -->|yes — PRODUCTION| CA["ChecklistAgent<br/>persona = ONE identity line"]
  Flag -->|no| TG{"ENABLE_TASK_GROUP"}
  TG -->|true| Rungs["CallRootAgent — TaskGroup rungs<br/>(agent/src/tasks/) — superseded"]
  TG -->|false| Ladder["SpeakingAgent — prompt ladder<br/>(tenants.system_prompt) — original"]

  CA --> Purpose["model: set_purpose(trees)"]
  Purpose --> Tracker["ChecklistTracker merges the selected trees<br/>shared node ids dedupe to ONE node"]
  Tracker --> Render["renderState() into the model's context<br/>[ASK] / [listen] / [ACTION NOW] / [✓]"]
  Render --> Turn{"caller speaks"}
  Turn --> Rec["model: record_answer<br/>(any order, several per breath)"]
  Rec --> Tracker
  Render --> Act["model: call the action tool"]
  Act --> Wrap["wrapAction gate:<br/>done → refuse (anti-double-book)<br/>blocked → name unmet nodes<br/>backfill omitted args from tracker<br/>2 failures → 'stop, take a message'"]
  Wrap --> Success{"real success id<br/>in the response?"}
  Success -->|yes| Done["tracker.completeAction() → [✓]"]
  Success -->|no| Render
  Done --> Gate{"isResolved()?<br/>every selected node resolved"}
  Render --> Gate
  Gate -->|no| Render
  Gate -->|yes| Finish["finish_call speaks the goodbye,<br/>then closes on a macrotask"]
```

**The load-bearing ideas**

| Idea | Where | Why |
|---|---|---|
| Questions are DATA, not prose | `checklist/trees.ts` | 10 hand-written trees + 30 vertical intake trees; a call's checklist is the MERGE of the trees its purpose selects, and the tenant's PRESET decides which trees are selectable at all |
| Host code owns state | `checklist/tracker.ts` | the model is never trusted to remember what is done |
| Actions complete on a real id | `wrapAction` | "booked" cannot be said into existence |
| The goodbye gate | `tracker.isResolved()` | replaced book-first sequencing — a stated goal can't be forgotten because the call can't END on it |
| Tools follow the selection | `selectedTools()` | 26 defined, 12 offered; `updateTools` deferred to a macrotask, never inside a tool's own `execute` |
