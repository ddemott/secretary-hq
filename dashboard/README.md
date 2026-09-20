# SecretaryHQ Dashboard

This is the **management UI** for the SecretaryHQ SaaS. It lets owners and admins:

- View and manage appointments across tenants/resources.
- See unified customer profiles with upcoming/past appointments, AI call summaries, and internal notes.
- Cancel appointments directly from the CRM detail view.
- Search customers by name, phone, or email.
- Tweak AI persona settings (system prompt, voice, working hours).
- Manage employee attributes (name, email, phone) and shift schedules.

The dashboard is built with **Next.js (App Router)** and **Tailwind CSS**. It calls the Fastify backend API (route count verified separately; see docs/planning/TODO.md for live counts), which enforces RLS via `withTenantClient()` and reads/writes to the shared Postgres database (Supabase or local Docker). Bookings created by the voice AI tools and the dashboard all hit the same source of truth.

---

## Prerequisites

- Node.js and npm.
- A Postgres database (Supabase project, or the local Docker DB on port 5433) with this repo's migrations applied, and the backend running (`npm start` from the repo root brings up both the backend and the dashboard).
- Environment variables configured in `.env.local`:
  - `NEXT_PUBLIC_API_BASE_URL` (defaults to `https://localhost:4001`)

---

## Running Locally

From the project root (or inside the `dashboard/` folder):

```bash
cd dashboard
npm install
npm run dev
```

`npm run dev` runs `server.js`, a custom HTTPS dev server that uses the shared self-signed certs in `../certs/`. Open [https://localhost:4000](https://localhost:4000) to access the dashboard (accept the self-signed cert warning).

You should see:

- A multi-tenant appointment view (list/calendar).
- Unified CRM with customer details, upcoming/past appointments, AI call history, and cancel flow.
- Employee management with shift scheduling.
- Knowledge base for RAG document management.
- Analytics dashboard with call volume and revenue metrics.

---

## Deployment

The dashboard (and full stack) is deployed on **Railway** in production (each service has its own config: `railway.json` + `nixpacks.toml` in the repo root for the backend, `dashboard/railway.json` for the dashboard, `agent/railway.json` for the voice agent).

For local/self-host development:

```bash
cd dashboard
npm install
npm run build
npm start
```

Set `NEXT_PUBLIC_API_BASE_URL` to point to your deployed (or local) backend.

Once deployed, owners log in using the app's own `users`-table-backed login flow (via the backend `/login` endpoint); Supabase Auth can be wired in later if desired but is not required for the current MVP.

(Older references to Vercel as "recommended" have been retired; Railway is the production path for the entire SaaS.)
