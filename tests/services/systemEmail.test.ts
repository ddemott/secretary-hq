/**
 * SYSTEM EMAIL TRANSPORT — the guarantees that keep a mail failure loud and bounded.
 *
 * THE INCIDENT (2026-07-27): POST /forgot-password on production wrote its
 * reset token and then HUNG inside nodemailer's sendMail. Thirty seconds later
 * the request had still not answered (HTTP 000); the logs held an "incoming
 * request" line with no completion and no error, because a hang is not an
 * error. A locked-out owner had no way back into their account and nothing
 * anywhere said so.
 *
 * Two properties are pinned here, and neither can be proved by the route tests:
 *
 *   1. A send that never settles REJECTS at the deadline. This is the property
 *      that turns an unbounded hang into a catchable failure.
 *   2. In PRODUCTION, missing credentials THROW rather than silently
 *      substituting a stub that resolves. A stub that reports success is a
 *      mailer that lies — the same shape as Telnyx reporting delivery for texts
 *      the carriers dropped, and as outcome='message' promising a row that had
 *      never been written.
 *
 * Each test re-imports the module (vi.resetModules) because the transporter is
 * a module-level singleton — without that, the first test's transport decision
 * would silently answer for all the others.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['NODE_ENV', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_SEND_DEADLINE_MS'] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** nodemailer mock whose sendMail behaviour each test chooses. */
const sendMailMock = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) },
  createTransport: vi.fn(() => ({ sendMail: sendMailMock })),
}));

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sendMailMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('system email transport', () => {
  it('THE HANG: a send that never settles rejects at the deadline', async () => {
    // WHO: any caller of a system email — /forgot-password is the one that bit.
    // WHAT: sendMail returns a promise that never settles (a hung SMTP socket).
    // WHEN: 2026-07-27 in production, and every time Railway cannot reach Gmail.
    // WHERE: sendSystemMail's Promise.race deadline in systemEmail.ts.
    // WHY: without this the await is unbounded — the caller's catch never runs,
    //      no metric fires, and the user watches a spinner until the browser
    //      gives up. The deadline is what makes the failure CATCHABLE.
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = 'sender@example.test';
    process.env.EMAIL_PASS = 'app-password';
    process.env.EMAIL_SEND_DEADLINE_MS = '50';
    sendMailMock.mockImplementation(() => new Promise(() => {})); // never settles

    const { sendPasswordResetEmail } =
      await import('../../src/services/communications/systemEmail');

    await expect(
      sendPasswordResetEmail('user@example.test', 'https://example.test/reset?token=x', 30)
    ).rejects.toThrow(/deadline/i);
  });

  it('a send that resolves normally still resolves (the deadline is not a tax)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = 'sender@example.test';
    process.env.EMAIL_PASS = 'app-password';
    process.env.EMAIL_SEND_DEADLINE_MS = '5000';
    sendMailMock.mockResolvedValue({ messageId: 'ok-1' });

    const { sendPasswordResetEmail } =
      await import('../../src/services/communications/systemEmail');

    await expect(
      sendPasswordResetEmail('user@example.test', 'https://example.test/reset?token=x', 30)
    ).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(call.to).toBe('user@example.test');
    expect(call.subject).toMatch(/reset/i);
    // The link has to survive into the body — an email without it is useless.
    expect(call.html).toContain('https://example.test/reset?token=x');
  });

  it('PRODUCTION + missing credentials REFUSES instead of pretending to send', async () => {
    // WHO: anyone deploying without EMAIL_USER/EMAIL_PASS.
    // WHAT: the old code substituted a stub resolving { messageId: 'test-message-id' }.
    // WHERE: getTransporter's production guard.
    // WHY: in production that stub means every send "succeeds" and no mail
    //      exists. Callers catch this throw, so it becomes a metric and a log
    //      line — a configuration gap you can SEE, rather than one that looks
    //      exactly like a working mailer.
    process.env.NODE_ENV = 'production';
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    const { sendPasswordResetEmail } =
      await import('../../src/services/communications/systemEmail');

    await expect(
      sendPasswordResetEmail('user@example.test', 'https://example.test/reset?token=x', 30)
    ).rejects.toThrow(/not configured/i);
    expect(
      sendMailMock,
      'nothing may be handed to a transport that does not exist'
    ).not.toHaveBeenCalled();
  });

  it('SAD: non-production without credentials still stubs, so dev and CI are unaffected', async () => {
    // The stub is legitimate off-production: local dev and CI have no mail
    // account and must not need one. Only the production case is a lie.
    process.env.NODE_ENV = 'test';
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    const { sendPasswordResetEmail } =
      await import('../../src/services/communications/systemEmail');

    await expect(
      sendPasswordResetEmail('user@example.test', 'https://example.test/reset?token=x', 30)
    ).resolves.toBeUndefined();
  });
});

describe('job inquiry email — escaping happens ONCE, at the emitter', () => {
  it('the preheader shows the caller\'s words, not HTML entities for them', async () => {
    // WHO: the business owner, reading the inbox preview line on a phone.
    // WHAT: a role description containing '&' and '<' — ordinary punctuation in
    //       a job title ("R&D lead", "<40hrs/week"), not an attack.
    // WHEN: every job-inquiry call; found on PR #322 review 2026-08-06.
    // WHERE: sendJobInquiryEmail's preheader vs renderEmailShell's own escape.
    // WHY: the call site USED to call escapeHtml on the preheader, and
    //      renderEmailShell escapes whatever it is handed. Two escapes turn
    //      '&' into '&amp;amp;' and '<' into '&amp;lt;', so the FIRST thing the
    //      owner reads is the caller's own words mangled into entity soup.
    //      Escaping is the emitter's job and must happen exactly once.
    // Credentials are set so getTransporter() builds the MOCKED nodemailer
    // transport. The credential-less stub substitutes its own sendMail and
    // would never reach sendMailMock, leaving nothing to assert against.
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_USER = 'sender@example.test';
    process.env.EMAIL_PASS = 'secret';
    sendMailMock.mockResolvedValue({ messageId: 'test-message-id' });

    const { sendJobInquiryEmail } =
      await import('../../src/services/communications/systemEmail');

    await sendJobInquiryEmail('owner@example.test', {
      callerName: 'Pat Quinn',
      callerCompany: 'Acme Staffing',
      roleDescription: 'R&D lead <contract>',
    });

    // The stub transport still records the message it was asked to send.
    const html = String(sendMailMock.mock.calls[0]?.[0]?.html ?? '');
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toContain('&amp;lt;');
    // Escaped exactly once: safe in the markup, faithful when rendered.
    expect(html).toContain('R&amp;D lead &lt;contract&gt; — details collected on the call.');
  });
});

describe('signup email-verification email', () => {
  it('HAPPY: sends the link, the expiry, and a plain-text copy to the new owner', async () => {
    // WHO: a new owner who just signed up (2026-09-24 email verification).
    // WHAT: subject names SecretaryHQ; the HTML and the text part both carry the
    //       exact /verify-email link and the 48-hour expiry.
    // WHY: until this link is clicked, checkout (the trial and the phone line)
    //      is refused — a mail missing the link is a dead end.
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_USER = 'sender@example.test';
    process.env.EMAIL_PASS = 'secret';
    sendMailMock.mockResolvedValue({ messageId: 'id' });

    const { sendEmailVerificationEmail } =
      await import('../../src/services/communications/systemEmail');
    const link = 'https://app.example.test/verify-email?token=abcDEF123_-xyz';
    await sendEmailVerificationEmail('new@owner.test', link, 48);

    const msg = sendMailMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(msg.to).toBe('new@owner.test');
    expect(msg.subject).toBe('Confirm your email for SecretaryHQ');
    expect(msg.text).toContain(link);
    expect(msg.text).toContain('48 hours');
    expect(msg.html).toContain(link);
    expect(msg.html).toContain('48 hours');
    expect(msg.html).toContain('Confirm my email');
  });

  it('SAD: a transport failure rejects, so the caller can meter it', async () => {
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_USER = 'sender@example.test';
    process.env.EMAIL_PASS = 'secret';
    sendMailMock.mockRejectedValue(new Error('SMTP down'));

    const { sendEmailVerificationEmail } =
      await import('../../src/services/communications/systemEmail');
    await expect(
      sendEmailVerificationEmail('new@owner.test', 'https://x.test/verify-email?token=t', 48)
    ).rejects.toThrow('SMTP down');
  });
});
