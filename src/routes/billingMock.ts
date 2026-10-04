/**
 * The pages a customer would see on Stripe's own site, for the mock (STRIPE_MODE=mock):
 * hosted checkout and the billing portal. They let a person click through the whole
 * billing flow locally and let CI do it, with no Stripe account.
 *
 * Every result is delivered to the app the way Stripe delivers it: as a SIGNED POST to the
 * real /billing/webhook route. Nothing here writes to the database itself, so the real
 * webhook handler and its signature gate are exercised, not bypassed.
 *
 * Registered only in mock mode, and every handler re-checks the mode and answers 404
 * otherwise, so these pages cannot exist in production.
 */
import type Stripe from 'stripe';
import type { AppFastifyInstance } from '../types/fastify';
import { getMockStripe, resolveStripeMode, stripeWebhookSecret } from '../services/stripe/gateway';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value: string | number | null | undefined): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{font:16px system-ui,sans-serif;background:#f6f7f9;margin:0;padding:24px;color:#1a1f2b}
  main{max-width:440px;margin:40px auto;background:#fff;border:1px solid #dfe3ea;border-radius:12px;padding:28px}
  .tag{display:inline-block;background:#fff3cd;color:#7a5b00;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:700}
  h1{font-size:20px;margin:12px 0 4px} p{color:#4a5262;margin:8px 0}
  button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 14px;margin:6px 6px 0 0;cursor:pointer}
  .primary{background:#2563eb;color:#fff} .ghost{background:#eef1f6;color:#1a1f2b} .danger{background:#fde8e8;color:#a31616}
  #msg{color:#a31616;min-height:1.4em}
</style></head><body><main>
<span class="tag">MOCK STRIPE: no real card is charged</span>
${body}
</main></body></html>`;
}

const PLAN_BY_PRICE: Record<string, string> = {
  price_mock_solo: 'Solo',
  price_mock_growth: 'Growth',
  price_mock_professional: 'Professional',
};

/**
 * The script both pages share. Buttons carry their values in data- attributes (HTML-escaped as
 * attribute text) and this reads them back, so no request value is ever spliced into script code.
 */
const POST_SCRIPT = `
async function act(btn) {
  const body = Object.assign({}, btn.dataset);
  const url = body.url;
  delete body.url;
  const msg = document.getElementById('msg');
  msg.textContent = '';
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (data.redirect) { window.location.href = data.redirect; return; }
  msg.textContent = data.message || data.error || 'Something went wrong.';
}`;

/** Only send people back to this app's own dashboard, never to an arbitrary URL from the query string. */
export function safeReturnUrl(candidate: string | undefined, env = process.env): string {
  const dashboard = env.DASHBOARD_URL || 'https://localhost:4400';
  try {
    if (candidate && new URL(candidate).origin === new URL(dashboard).origin) return candidate;
  } catch {
    /* fall through */
  }
  return dashboard;
}

/** Deliver events to the real webhook route, signed as Stripe would sign them. */
export async function deliverMockEvents(
  app: AppFastifyInstance,
  events: Stripe.Event[]
): Promise<void> {
  const mock = getMockStripe();
  const secret = stripeWebhookSecret();
  for (const event of events) {
    const { body, header } = mock.sign(event, secret);
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload: body,
    });
    if (res.statusCode !== 200) {
      throw new Error(`Mock webhook delivery of ${event.type} failed with HTTP ${res.statusCode}`);
    }
  }
}

export function registerBillingMockRoutes(app: AppFastifyInstance): void {
  const mockOnly = (reply: {
    status: (n: number) => { send: (b: unknown) => unknown };
  }): boolean => {
    if (resolveStripeMode() === 'mock') return true;
    reply.status(404).send({ success: false, error: 'Not found' });
    return false;
  };

  // ── Hosted checkout ──────────────────────────────────────────────────────
  app.get('/billing/mock/checkout', async (req, reply) => {
    if (!mockOnly(reply)) return;
    const id = (req.query as { session?: string }).session ?? '';
    const session = getMockStripe().getSession(id);
    if (!session || session.status !== 'open') {
      return reply
        .type('text/html')
        .send(
          page(
            'Checkout expired',
            '<h1>This checkout session has expired</h1><p>Start again from Billing in the dashboard.</p>'
          )
        );
    }
    const plan = PLAN_BY_PRICE[session.priceId ?? ''] ?? session.metadata.plan ?? 'plan';
    const trial =
      session.trialDays > 0
        ? `<p>Free for ${esc(session.trialDays)} days, then billed monthly. A card is still required up front.</p>`
        : '<p>Billed monthly, starting today.</p>';
    return reply.type('text/html').send(
      page(
        'Mock checkout',
        `<h1>Subscribe to ${esc(plan)}</h1>${trial}
<p id="msg"></p>
<button class="primary" onclick="act(this)" data-url="/billing/mock/checkout" data-session="${esc(id)}" data-outcome="paid">Pay with test card 4242</button>
<button class="danger" onclick="act(this)" data-url="/billing/mock/checkout" data-session="${esc(id)}" data-outcome="declined">Test card that is declined</button>
<button class="ghost" onclick="act(this)" data-url="/billing/mock/checkout" data-session="${esc(id)}" data-outcome="cancel">Back</button>
<script>${POST_SCRIPT}</script>`
      )
    );
  });

  app.post('/billing/mock/checkout', async (req, reply) => {
    if (!mockOnly(reply)) return;
    const { session: id, outcome } = (req.body ?? {}) as { session?: string; outcome?: string };
    const mock = getMockStripe();
    const session = id ? mock.getSession(id) : undefined;
    if (!session || session.status !== 'open') {
      return reply
        .status(409)
        .send({ success: false, message: 'This checkout session is no longer open.' });
    }
    if (outcome === 'cancel') {
      mock.cancelCheckout(session.id);
      return reply.send({ redirect: session.cancelUrl });
    }
    if (outcome === 'declined') {
      mock.completeCheckout(session.id, 'declined');
      return reply.send({ success: false, message: 'Your card was declined. Try another card.' });
    }
    if (outcome !== 'paid') {
      return reply.status(400).send({ success: false, message: 'Unknown outcome.' });
    }
    await deliverMockEvents(app, mock.completeCheckout(session.id, outcome));
    return reply.send({ redirect: session.successUrl });
  });

  // ── Billing portal ───────────────────────────────────────────────────────
  app.get('/billing/mock/portal', async (req, reply) => {
    if (!mockOnly(reply)) return;
    const q = req.query as { customer?: string; return_url?: string };
    const customer = esc(q.customer ?? '');
    const back = esc(safeReturnUrl(q.return_url));
    return reply.type('text/html').send(
      page(
        'Mock billing portal',
        `<h1>Manage billing</h1><p>Customer ${customer}</p><p id="msg"></p>
<button class="danger" onclick="act(this)" data-url="/billing/mock/portal" data-customer="${customer}" data-return_url="${back}" data-action="cancel">Cancel subscription</button>
<button class="ghost" onclick="act(this)" data-url="/billing/mock/portal" data-customer="${customer}" data-return_url="${back}" data-action="fail_payment">Simulate a failed renewal</button>
<button class="ghost" onclick="act(this)" data-url="/billing/mock/portal" data-customer="${customer}" data-return_url="${back}" data-action="recover_payment">Simulate the payment recovering</button>
<button class="primary" onclick="act(this)" data-url="/billing/mock/portal" data-customer="${customer}" data-return_url="${back}" data-action="back">Back to the app</button>
<script>${POST_SCRIPT}</script>`
      )
    );
  });

  app.post('/billing/mock/portal', async (req, reply) => {
    if (!mockOnly(reply)) return;
    const { customer, action, return_url } = (req.body ?? {}) as {
      customer?: string;
      action?: string;
      return_url?: string;
    };
    const back = safeReturnUrl(return_url);
    if (!customer) return reply.status(400).send({ success: false, message: 'Missing customer.' });
    const mock = getMockStripe();
    if (action === 'cancel') await deliverMockEvents(app, mock.cancelSubscriptionFor(customer));
    else if (action === 'fail_payment') await deliverMockEvents(app, mock.failPaymentFor(customer));
    else if (action === 'recover_payment')
      await deliverMockEvents(app, mock.recoverPaymentFor(customer));
    else if (action !== 'back')
      return reply.status(400).send({ success: false, message: 'Unknown action.' });
    return reply.send({ redirect: back });
  });
}
