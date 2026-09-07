# Deposit Collection via Stripe Payment Links

## Status
Active development — Tony driving, pending Dale direction

## Problem
The AI needs to collect deposits and cancellation fees for certain businesses (salons, restaurants, real estate). Taking credit card numbers over the phone or through the AI is a PCI compliance risk we should not own.

## Approach
Use Stripe's hosted payment pages. We never touch raw card data.

## How It Works

### Flow 1: Deposit at Booking
```
AI: "To secure your appointment, we need a [X]% deposit.
     I'll send you a secure link right now."

AI sends Stripe Payment Link via SMS/email
Customer clicks link → Stripe's hosted page → enters card
Stripe charges card → webhook to secretary-hq → appointment confirmed
```

### Flow 2: Cancellation/No-Show Fee
```
Customer cancels late or no-shows
AI or admin triggers charge against saved Stripe Customer ID
No human confrontation needed — policy was disclosed at booking
```

## PCI Scope
Zero. Card data lives on Stripe's servers. Our system only sees:
- Payment Link URL
- Stripe Customer ID
- Payment status (succeeded/failed)

## What We Need to Build

### 1. Stripe Integration
- Stripe SDK installed
- API keys in environment
- Payment Link generation (one API call per booking)
- Customer creation and storage (Stripe Customer ID, not card data)
- Webhook handler for payment success/failure

### 2. SMS/Email Sending
- Twilio for SMS (send Payment Link)
- SendGrid or Stripe's built-in email for confirmation
- Fallback: simple email if SMS fails

### 3. Business Rules Config
Per tenant, configure:
- Which services require deposits
- Deposit amount (% or fixed)
- Cancellation policy window (24h, 48h, 72h)
- Cancellation fee amount (% of service)
- Stripe Price/Product ID per service

### 4. Dispatch Note
When a deposit is required:
```
Deposit required: YES
Amount: $[X]
Payment link sent: [timestamp]
Payment status: [pending/confirmed/failed]
Appointment confirmed: [conditional on payment]
```

## Stripe APIs Used
- `paymentLinks.create` — generate link
- `customers.create` — save customer for future charges
- `customers.update` — attach payment method
- `invoices.finalizeInvoice` + `invoices.pay` — charge saved customer for cancellation fees
- Webhooks: `payment_intent.succeeded`, `payment_intent.payment_failed`

## Security Notes
- Never log raw card data
- Store only Stripe Customer ID
- Webhook signature verification required
- Rate limit Payment Link generation per tenant

## Risks
- Customer abandons payment link → appointment stays unconfirmed, needs follow-up
- Stripe webhook delivery delays → brief window of "pending" state
- PCI compliance if we ever add card input ourselves (don't)

## Questions for Dale
- Which demo tenant should get this first? Salon seems natural.
- Do we charge cancellation fees automatically, or flag for human review first?
- SMS via Twilio or Stripe's own messaging?
