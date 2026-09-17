import nodemailer, { type Transporter } from 'nodemailer';
import { emailLogoAttachment, escapeHtml, renderDetailRows, renderEmailShell } from './emailLayout';

/**
 * Where platform-internal notices (port requests, consent-invite admin
 * copies, consent-attestation receipts) go when there's no per-tenant
 * recipient. Same fallback chain as the port-request flow in
 * src/routes/provisioning.ts — no hardcoded address in application logic;
 * the literal here is a last-resort default for local/dev environments
 * that have neither env var set (NODE_ENV !== 'production' routes through
 * the no-op stub transporter anyway, so this never reaches a real inbox
 * unless someone actually configures SMTP locally).
 */
export const PLATFORM_ADMIN_EMAIL: string =
  process.env.PLATFORM_ADMIN_EMAIL || process.env.EMAIL_USER || 'daledemott@gmail.com';

let transporter: Transporter | null = null;

/**
 * Hard ceiling on any single system-email send.
 *
 * THE INCIDENT (2026-07-27): POST /forgot-password on production wrote its
 * token row and then HUNG inside sendMail — 30s later the request had still
 * not answered (HTTP 000), and the logs held an "incoming request" line with
 * no completion and no error, because a hang is not an error. The user gets a
 * spinner; a locked-out owner cannot recover their account; nothing alerts.
 *
 * Same transport as the 2026-07-17 job-inquiry incident: nodemailer → Gmail
 * SMTP from Railway, IPv6 ENETUNREACH, 60–120s per attempt. Whatever the
 * socket does, no caller waits longer than this.
 */
const EMAIL_SEND_DEADLINE_MS = Number(process.env.EMAIL_SEND_DEADLINE_MS ?? 20_000);

function getTransporter(): Transporter {
  if (transporter) return transporter;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    // A STUB THAT RESOLVES IS A MAILER THAT LIES. In production it reports
    // every send as delivered while no mail exists anywhere — the same shape as
    // Telnyx returning success for texts the carriers dropped, and as
    // outcome='message' promising a row that had never been written. Refuse
    // instead: every caller already has a catch path, so this surfaces as a
    // metered, logged failure rather than a 500 or a silence.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EMAIL_USER/EMAIL_PASS unset in production — system email is not configured');
    }
    transporter = {
      sendMail: () => Promise.resolve({ messageId: 'test-message-id' }),
    } as unknown as Transporter;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    // Explicit host/port rather than the `service: 'gmail'` shorthand, so
    // SMTP_HOST / SMTP_PORT can repoint at any provider with no code change.
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    // 2026-07-17: Railway → Gmail resolved over IPv6 and every attempt died on
    // ENETUNREACH after 60–120s. Prefer IPv4 and fail fast. These are a
    // mitigation, not the guarantee — sendSystemMail's deadline is the
    // guarantee, because a transport that ignores its own timeouts is exactly
    // what produced the incident.
    family: 4,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  } as Parameters<typeof nodemailer.createTransport>[0]);
  return transporter;
}

/**
 * The single choke point every system email goes through: applies the From
 * line and the hard deadline.
 *
 * A send that outlives the deadline REJECTS, so a caller's existing catch turns
 * it into a metric and a 5W log instead of an unbounded await. Transport
 * knowledge lives here and nowhere else — swapping Gmail SMTP for an HTTPS
 * provider (Resend/Postmark, the durable fix for Railway's SMTP egress)
 * replaces this function's internals and touches no call site.
 */
async function sendSystemMail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const send = getTransporter().sendMail({
    from: `"SecretaryHQ" <${process.env.EMAIL_USER ?? 'no-reply@secretaryhq.com'}>`,
    ...opts,
    // The shell's header `<img>` points at `cid:secretaryhq-logo`. Attach it on
    // every system send or that image resolves to nothing — attaching here, in
    // the one function all of them funnel through, is what stops a future email
    // from being added without it.
    attachments: [emailLogoAttachment()],
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`system email send exceeded ${EMAIL_SEND_DEADLINE_MS}ms deadline`)),
      EMAIL_SEND_DEADLINE_MS
    );
  });
  try {
    await Promise.race([send, deadline]);
  } finally {
    clearTimeout(timer);
    // The losing `send` may still reject minutes later (that is the whole
    // problem being fixed); swallow it so it cannot surface as an unhandled
    // rejection and take the process down.
    void Promise.resolve(send).catch(() => {});
  }
}

/**
 * Invite a new user to a tenant. The invite reuses the password-reset
 * token flow under the hood (the user "sets" their password rather than
 * "resets" it), but the framing is different: the recipient hasn't been
 * here before, so the copy welcomes them and tells them which business
 * invited them and what role they'll have when they sign in.
 */
export async function sendUserInviteEmail(
  to: string,
  resetLink: string,
  ttlMinutes: number,
  businessName: string,
  role: 'owner' | 'front_desk'
): Promise<void> {
  const roleLabel = role === 'front_desk' ? 'Front Desk' : 'Owner';
  const subject = `You're invited to ${businessName} on SecretaryHQ`;
  const text = `${businessName} invited you to join their SecretaryHQ workspace as ${roleLabel}.

Set your password to sign in (link expires in ${ttlMinutes} minutes):

${resetLink}

If you weren't expecting this invitation, you can safely ignore this email — no account will be created against your name.`;

  // businessName is tenant-supplied, so it is escaped rather than interpolated
  // raw — it reaches this template straight from the tenants table.
  const safeBusiness = escapeHtml(businessName);
  const html = renderEmailShell({
    heading: `You're invited to ${businessName}`,
    preheader: `Set your password to join ${businessName} as ${roleLabel}.`,
    bodyHtml: `<p style="margin:0 0 16px">${safeBusiness} added you to their SecretaryHQ workspace as <strong>${escapeHtml(roleLabel)}</strong>. Set a password to sign in.</p>`,
    cta: { label: 'Set my password', url: resetLink },
    footerHtml:
      `This link expires in ${ttlMinutes} minutes. If the button doesn't work, paste this URL into your browser:<br>` +
      `<span style="word-break:break-all">${escapeHtml(resetLink)}</span>` +
      `<br><br>If you weren't expecting this, you can safely ignore the email — no account will be created against your name.`,
  });

  await sendSystemMail({ to, subject, text, html });
}

export async function sendPasswordResetEmail(
  to: string,
  resetLink: string,
  ttlMinutes: number
): Promise<void> {
  const subject = 'Reset your SecretaryHQ password';
  const text = `Someone requested a password reset for your SecretaryHQ account.

If this was you, follow the link below to set a new password (expires in ${ttlMinutes} minutes):

${resetLink}

If you did not request this, you can safely ignore this email — your password will not change.`;

  const html = renderEmailShell({
    heading: 'Reset your SecretaryHQ password',
    preheader: `Set a new password — this link expires in ${ttlMinutes} minutes.`,
    bodyHtml:
      '<p style="margin:0 0 16px">Someone requested a password reset for your SecretaryHQ account.</p>',
    cta: { label: 'Set a new password', url: resetLink },
    footerHtml:
      `This link expires in ${ttlMinutes} minutes. If the button doesn't work, paste this URL into your browser:<br>` +
      `<span style="word-break:break-all">${escapeHtml(resetLink)}</span>` +
      `<br><br>If you did not request this, you can safely ignore this email — your password will not change.`,
  });

  await sendSystemMail({ to, subject, text, html });
}

/** Structured fields captured during a voice job-inquiry intake. */
export interface JobInquiryFields {
  /** Where the work would actually happen — the end client. */
  clientCompany?: string | null;
  /** The agency that rang. Who you will actually be negotiating with. */
  callerCompany?: string | null;
  representsCompany?: boolean | null;
  employmentType?: string | null;
  /** The role in the caller's own words — title, tech, responsibilities. */
  roleDescription?: string | null;
  rateRange?: string | null;
  duration?: string | null;
  locationType?: string | null;
  address?: string | null;
  timezone?: string | null;
  callerName?: string | null;
  callbackPhone?: string | null;
}

/**
 * Notify the business owner that a recruiter called asking about availability
 * for work. This is an OWNER notification (same class as password-reset /
 * invite), NOT a customer marketing message — it deliberately uses this
 * consent-free path rather than EmailService.sendEmail (which consent-gates).
 *
 * The caller is separately asked to email a full job description; this email is
 * the structured summary of what the agent collected on the call so the owner
 * has the gist before the JD arrives.
 */
export async function sendJobInquiryEmail(to: string, fields: JobInquiryFields): Promise<void> {
  const yesNo = (v: boolean | null | undefined): string =>
    v === true ? 'Yes' : v === false ? 'No' : 'Not stated';
  const orDash = (v: string | null | undefined): string => (v && v.trim() ? v : '—');

  const employment =
    fields.employmentType === 'full_time' ? 'Full time' : orDash(fields.employmentType);
  const rateLabel = fields.employmentType === 'full_time' ? 'Salary range' : 'Rate range';

  // Build the field list, omitting position fields irrelevant to the branch
  // (duration only for contract; address for onsite/hybrid; timezone for remote).
  const rows: Array<[string, string]> = [
    ['Caller', orDash(fields.callerName)],
    ['Callback', orDash(fields.callbackPhone)],
    // BOTH companies, labelled so they cannot be confused at a glance. A lead that
    // says only "Blue Cross" leaves the owner ringing back an agency he cannot name.
    ['Client (where the work is)', orDash(fields.clientCompany)],
    ['Caller works for', orDash(fields.callerCompany)],
    ['In-house at the client', yesNo(fields.representsCompany)],
    // The role itself — WHAT job this is. The one field the owner reads first,
    // and the one the pipeline used to lose (dropped end-to-end until 2026-07-30).
    ['Role', orDash(fields.roleDescription)],
    ['Employment type', employment],
    [rateLabel, orDash(fields.rateRange)],
  ];
  if (fields.employmentType !== 'full_time' && fields.duration) {
    rows.push(['Contract length', orDash(fields.duration)]);
  }
  rows.push(['Location', orDash(fields.locationType)]);
  if (fields.address) rows.push(['Address', fields.address]);
  if (fields.timezone) rows.push(['Timezone', fields.timezone]);

  // The subject line is what he sees on his phone, so it leads with the CLIENT (is
  // this work I want?) and names the agency second (who is asking?).
  const subject =
    `New job inquiry` +
    (fields.clientCompany ? ` — ${fields.clientCompany}` : '') +
    (fields.callerCompany && fields.callerCompany !== fields.clientCompany
      ? ` (via ${fields.callerCompany})`
      : '');
  const text =
    `A caller asked whether you're available for work. Details collected on the call:\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nThe caller was asked to email a full job description to your inbox with their name and company in the subject line.`;

  // Caller-provided values (company, name, address) come straight off the call,
  // so every one is escaped — but each is escaped exactly ONCE, by the thing
  // that emits the markup: `renderDetailRows` for the table, `renderEmailShell`
  // for the preheader (it calls escapeHtml on whatever it is handed). Pass RAW
  // text in here. Escaping at the call site too yields `&amp;lt;` in the inbox
  // preview line — the caller's own words, mangled, in the first thing the
  // owner reads.
  const html = renderEmailShell({
    heading: 'New job inquiry',
    // The owner reads this next to the subject on a phone: lead with the role,
    // which is the "do I want this?" signal.
    preheader: fields.roleDescription
      ? `${fields.roleDescription} — details collected on the call.`
      : 'A caller asked whether you are available for work.',
    bodyHtml:
      `<p style="margin:0 0 4px">A caller asked whether you're available for work. Details collected on the call:</p>` +
      renderDetailRows(rows),
    footerHtml:
      'The caller was asked to email a full job description with their name and company in the subject line.',
  });

  await sendSystemMail({ to, subject, text, html });
}

/** Fields captured when an owner asks to port their existing number into Telnyx. */
export interface PortRequestFields {
  tenantId: string;
  tenantName: string;
  phoneNumber: string;
  notes?: string | null;
}

/**
 * Notify the platform admin (Dale) that an owner wants to port their real
 * number into Telnyx, replacing forwarding entirely. This is a PLATFORM
 * notification (same class as password-reset/invite), not a tenant-facing
 * email — no porting API is invoked here or anywhere; a real LNP port always
 * needs a human (LOA + carrier cutover), so this is just the structured
 * heads-up that starts that manual process. Deliberately no credentials or
 * carrier-account details are collected or emailed — see design doc
 * (docs/superpowers/specs/2026-07-05-wizard-phase-b-design.md §3) for why
 * that was cut from the original proposal.
 */
export async function sendPortRequestEmail(to: string, fields: PortRequestFields): Promise<void> {
  const orDash = (v: string | null | undefined): string => (v && v.trim() ? v : '—');

  const subject = `Port request — ${fields.tenantName}`;
  const text =
    `${fields.tenantName} (tenant ${fields.tenantId}) wants to port their existing number ` +
    `${fields.phoneNumber} into Telnyx instead of forwarding.\n\n` +
    `Notes: ${orDash(fields.notes)}\n\n` +
    `This requires a manual port in the Telnyx portal — no automated action was taken.`;

  const portHtml = renderEmailShell({
    heading: `Port request — ${fields.tenantName}`,
    preheader: `${fields.tenantName} wants to port ${fields.phoneNumber} into Telnyx.`,
    bodyHtml:
      `<p style="margin:0 0 4px"><strong>${escapeHtml(fields.tenantName)}</strong> wants to port their existing number into Telnyx instead of forwarding.</p>` +
      renderDetailRows([
        ['Number to port', fields.phoneNumber],
        ['Tenant', fields.tenantId],
        ['Notes', orDash(fields.notes)],
      ]),
    footerHtml: 'This requires a manual port in the Telnyx portal — no automated action was taken.',
  });

  await sendSystemMail({ to, subject, text, html: portHtml });
}

/**
 * The attestation copy, word-for-word identical to the /register page's
 * legal-consent checkbox (dashboard/app/register/page.tsx) — the admin
 * create flow's consent-invite email must say the SAME thing the self-serve
 * checkbox says, or the two consent flows are legally inconsistent with
 * each other.
 */
export const TENANT_CONSENT_ATTESTATION_TEXT =
  'I am authorized to set up Secretary HQ for this business. I agree to the Terms of Service, ' +
  'Privacy Policy, and Data Protection Addendum. I understand an AI assistant answers calls on ' +
  'my behalf and I am responsible for informing my callers as required by law.';

/**
 * Sent to the OWNER of an admin-provisioned tenant (POST /tenants/create).
 *
 * An admin creating a tenant on someone else's behalf isn't the business
 * owner attesting anything — nobody has agreed to the ToS/Privacy/DPA on
 * this tenant yet, and per general clickwrap-agreement law an admin
 * "attesting on their behalf" would capture nothing legally. This email is
 * the first-login gate: the owner cannot use their dashboard
 * (POST /login refuses with error_code 'consent_required') until they
 * click through and confirm.
 *
 * Copy is deliberately unambiguous that this is NOT optional — Dale's own
 * instruction was "word it that they need to do this before proceeding."
 */
export async function sendTenantConsentInviteEmail(
  to: string,
  consentLink: string,
  businessName: string
): Promise<void> {
  const safeBusiness = escapeHtml(businessName);
  const subject = `Action required — confirm your Secretary HQ agreement for ${businessName}`;
  const text = `Secretary HQ set up a workspace for ${businessName} on your behalf.

Before you can sign in and use your dashboard, you must confirm the following:

${TENANT_CONSENT_ATTESTATION_TEXT}

Click the link below to confirm and unlock your dashboard:

${consentLink}

You cannot access your dashboard until you do this — it is not optional and there is nothing else to review first.`;

  const html = renderEmailShell({
    heading: 'Action required before you can sign in',
    preheader: `Confirm your agreement to unlock the ${businessName} dashboard.`,
    bodyHtml:
      `<p style="margin:0 0 16px">Secretary HQ set up a workspace for <strong>${safeBusiness}</strong> on your behalf.</p>` +
      `<p style="margin:0 0 16px"><strong>Before you can sign in and use your dashboard</strong>, you must confirm:</p>` +
      `<p style="margin:0 0 16px;padding:12px 16px;background:#F4F6FA;border-radius:6px">${escapeHtml(TENANT_CONSENT_ATTESTATION_TEXT)}</p>`,
    cta: { label: 'Confirm and unlock my dashboard', url: consentLink },
    footerHtml:
      `You cannot access your dashboard until you confirm — this is required, not optional. ` +
      `If the button doesn't work, paste this URL into your browser:<br>` +
      `<span style="word-break:break-all">${escapeHtml(consentLink)}</span>`,
  });

  await sendSystemMail({ to, subject, text, html });
}

/** Fields for the platform-admin "new tenant pending consent" notice. */
export interface TenantConsentPendingFields {
  businessName: string;
  ownerEmail: string;
  createdAt: Date;
}

/**
 * Notify the platform admin that a new admin-provisioned tenant was
 * created and is waiting on the owner's consent confirmation. Informational
 * only — no action is required from the admin; the owner's own resend
 * self-service (POST /consent/resend) covers the "never confirmed" case.
 */
export async function sendTenantConsentPendingAdminNotice(
  to: string,
  fields: TenantConsentPendingFields
): Promise<void> {
  const subject = `New tenant created — pending owner consent: ${fields.businessName}`;
  const createdAtLabel = fields.createdAt.toISOString();
  const text =
    `A new tenant was created and is pending the owner's consent confirmation. No action is needed from you.\n\n` +
    `Business: ${fields.businessName}\n` +
    `Owner email: ${fields.ownerEmail}\n` +
    `Created: ${createdAtLabel}`;

  const html = renderEmailShell({
    heading: 'New tenant created — pending owner consent',
    preheader: `${fields.businessName} is waiting on the owner to confirm their agreement.`,
    bodyHtml:
      `<p style="margin:0 0 4px">A new tenant was created and is pending the owner's consent confirmation. No action is needed from you.</p>` +
      renderDetailRows([
        ['Business', fields.businessName],
        ['Owner email', fields.ownerEmail],
        ['Created', createdAtLabel],
      ]),
  });

  await sendSystemMail({ to, subject, text, html });
}

/** Fields for the post-attestation receipt, sent to both the owner and the platform admin. */
export interface TenantConsentAttestedFields {
  businessName: string;
  ownerEmail: string;
  attestedAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Sent to BOTH the owner and the platform admin immediately after
 * POST /consent/confirm succeeds — a receipt of what was attested and when,
 * described in prose rather than raw headers. Two separate calls (one per
 * recipient) rather than a bcc, so each email's framing (audience === 'owner'
 * vs 'admin') can differ slightly while the facts stay identical.
 */
export async function sendTenantConsentAttestedEmail(
  to: string,
  fields: TenantConsentAttestedFields,
  audience: 'owner' | 'admin'
): Promise<void> {
  const attestedAtLabel = fields.attestedAt.toISOString();
  const ipLabel = fields.ip ?? 'not recorded';
  const uaLabel = fields.userAgent ?? 'not recorded';

  const subject =
    audience === 'owner'
      ? `Your Secretary HQ agreement is confirmed — ${fields.businessName}`
      : `Consent confirmed — ${fields.businessName}`;

  const intro =
    audience === 'owner'
      ? `This confirms you agreed to the Secretary HQ Terms of Service, Privacy Policy, and Data Protection Addendum for ${fields.businessName}. Your dashboard is now unlocked.`
      : `The owner of ${fields.businessName} confirmed their consent. No action is needed.`;

  const text =
    `${intro}\n\n` +
    `Business: ${fields.businessName}\n` +
    `Owner email: ${fields.ownerEmail}\n` +
    `Confirmed at: ${attestedAtLabel}\n` +
    `Confirmed from IP: ${ipLabel}\n` +
    `Browser: ${uaLabel}`;

  const html = renderEmailShell({
    heading: audience === 'owner' ? 'Your agreement is confirmed' : 'Consent confirmed',
    preheader: intro,
    bodyHtml:
      `<p style="margin:0 0 4px">${escapeHtml(intro)}</p>` +
      renderDetailRows([
        ['Business', fields.businessName],
        ['Owner email', fields.ownerEmail],
        ['Confirmed at', attestedAtLabel],
        ['Confirmed from IP', ipLabel],
        ['Browser', uaLabel],
      ]),
  });

  await sendSystemMail({ to, subject, text, html });
}
