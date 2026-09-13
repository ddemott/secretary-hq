/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import nodemailer from 'nodemailer';
import type { TenantConfigService } from '../tenants/index.js';
import type { ConsentService } from '../consentService.js';
import type { EmailMessage, CommunicationResult } from './types.js';
import { EmailTemplateService, type EmailTemplateData } from './emailTemplates.js';
import { recordCommunicationHistory } from './communicationHistory.js';
import {
  EMAIL_LOGO_CID,
  emailLogoAttachment,
  escapeHtml,
  renderEmailShell,
} from './emailLayout.js';

export class EmailService {
  private transporter: nodemailer.Transporter;
  private templateService: EmailTemplateService;
  private static simulationNoticeLogged = false;

  constructor(
    private configService: TenantConfigService,
    private consentService?: ConsentService
  ) {
    const isTest = process.env.NODE_ENV === 'test';
    const hasCreds = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

    if (isTest || !hasCreds) {
      // Stub transporter — active in two cases:
      //   (a) NODE_ENV=test: correct, tests never send real email.
      //   (b) EMAIL_USER/EMAIL_PASS missing in prod/dev: simulation mode —
      //       emails appear to succeed but are never delivered.
      // Satisfies just the `sendMail` slot we exercise; the rest of
      // nodemailer.Transporter isn't reachable via this path.
      this.transporter = {
        sendMail: () => Promise.resolve({ messageId: 'test-message-id' }),
      } as unknown as nodemailer.Transporter;

      if (!isTest && !hasCreds && !EmailService.simulationNoticeLogged) {
        console.warn(
          '📧 Email Service running in simulation mode — EMAIL_USER / EMAIL_PASS not set; emails will NOT be delivered.'
        );
        EmailService.simulationNoticeLogged = true;
      }
    } else {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
    }

    this.templateService = new EmailTemplateService(configService);
  }

  /**
   * Send an email message with consent checking
   */
  async sendEmail(tenantId: string, message: EmailMessage): Promise<CommunicationResult> {
    // Hoisted so the send-failure catch can record the same subject/body the
    // success path would have logged (templated when a template is used).
    let subject = message.subject;
    let text = message.text;
    try {
      const tenantConfig = await this.configService.getTenantConfig(tenantId);
      if (!tenantConfig) {
        throw new Error(`Tenant '${tenantId}' configuration not found`);
      }

      // Check consent before sending email
      if (this.consentService) {
        const consentCheck = await this.consentService.canReceiveCommunications(
          tenantId,
          message.to, // email address
          undefined // no phone for email
        );

        if (!consentCheck.canReceiveEmail) {
          console.log(`⚠️ Email not sent to ${message.to} - no consent for tenant ${tenantId}`);
          return {
            success: false,
            error: 'Customer has not consented to email communications',
          };
        }
      }

      // Prepare email content
      let html = message.html;

      // Apply template if specified
      if (message.template) {
        const templateResult = await this.applyTemplate(message.template, {
          ...message.templateData,
          tenantId,
        });
        subject = templateResult.subject || subject;
        text = templateResult.text || text;
        html = templateResult.html || html;
      }

      const businessName = await this.configService.getBusinessName(tenantId);
      const mailOptions = {
        from: `"${businessName}" <${process.env.EMAIL_USER}>`,
        to: message.to,
        subject,
        text,
        html,
        // Attach the inline logo ONLY when the body actually references it.
        // Tenant→customer templates deliberately carry no platform logo (see
        // `logoUrl` below), and an attachment nothing points at surfaces in the
        // client as a stray file the sender appears to have meant to send.
        ...(html?.includes(`cid:${EMAIL_LOGO_CID}`)
          ? { attachments: [emailLogoAttachment()] }
          : {}),
      };

      const result = await this.transporter.sendMail(mailOptions);

      console.log(`✅ Email sent to ${message.to} for tenant ${tenantId}`);

      // Record the send in communications_history (best-effort, never throws —
      // a failed log must not turn a successful send into a failure).
      await recordCommunicationHistory(tenantId, {
        channel: 'email',
        recipient: message.to,
        subject,
        body: text,
        status: 'sent',
        providerMessageId: result.messageId,
      });

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      console.error('❌ Error sending email:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Record the FAILED delivery so the dashboard failed-delivery drill-down
      // (?status=failed) has real rows. Best-effort — the recorder never throws,
      // but we still guard so a history-write hiccup can't mask the send error.
      await recordCommunicationHistory(tenantId, {
        channel: 'email',
        recipient: message.to,
        subject,
        body: text,
        status: 'failed',
        error: errorMessage,
      }).catch(() => {});
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Apply email template with enhanced professional templates
   */
  public async applyTemplate(
    template: string,
    data: Record<string, unknown>
  ): Promise<{
    subject?: string;
    text?: string;
    html?: string;
  }> {
    // Templates accept a permissive bag (callers vary); narrow at the boundary
    // into a typed shape so downstream code reads concrete fields, not unknown.
    const d = data as {
      tenantId: string;
      customerName?: string;
      serviceName?: string;
      staffName?: string;
      dateTime?: string;
      duration?: number;
      notes?: string;
      reason?: string;
      hoursUntil?: number;
      subject?: string;
      message?: string;
    };

    const businessName = await this.configService.getBusinessName(d.tenantId);
    const notificationPrefs = await this.configService.getNotificationPreferences(d.tenantId);
    const tenantConfig = await this.configService.getTenantConfig(d.tenantId);

    const templateData: EmailTemplateData = {
      customerName: d.customerName || 'Valued Customer',
      serviceName: d.serviceName || 'Service',
      staffName: d.staffName || 'Our Team',
      dateTime: d.dateTime || 'TBD',
      duration: d.duration || 60,
      businessName: businessName,
      businessPhone: notificationPrefs.contactInfo?.phone,
      businessEmail: undefined, // No tenant-level email column today
      businessAddress: undefined, // Not currently stored
      notes: d.notes,
      reason: d.reason,
      hoursUntil: d.hoursUntil,
      // This template is a TENANT-to-CUSTOMER email: Thinking Hammer LLC
      // writing to their customer. The header belongs to the business, whose
      // name is already the masthead. Putting the SecretaryHQ mark there brands
      // the business's mail with its vendor's logo — the customer has no
      // relationship with SecretaryHQ and would rightly wonder who sent this.
      // The platform mark instead appears once, small, in the footer (see
      // `generateBaseTemplate`), which is the honest placement.
      //
      // Per-tenant logo (2026-09-13, tenants.logo_url): a plain URL the owner
      // pastes on Business Settings — no upload/storage, that's a separate
      // product decision this migration didn't make. undefined for a tenant
      // that hasn't set one, same as before.
      logoUrl: tenantConfig?.logoUrl,
      primaryColor: undefined, // Not currently stored
      secondaryColor: undefined, // Not currently stored
    };

    switch (template) {
      case 'appointment-confirmation':
        return this.templateService.generateAppointmentConfirmation(templateData);

      case 'appointment-reminder':
        return this.templateService.generateAppointmentReminder({
          ...templateData,
          hoursUntil: d.hoursUntil || 24,
        });

      case 'appointment-cancellation':
        return this.templateService.generateAppointmentCancellation(templateData);

      case 'welcome':
        return this.templateService.generateWelcomeEmail({
          businessName,
          businessPhone: notificationPrefs.contactInfo?.phone,
          businessEmail: undefined, // No tenant-level email column today
          businessAddress: undefined,
        });

      default: {
        // Generic passthrough message. Previously emitted a bare `<p>${message}</p>`
        // — unstyled (so it read as plain text in a client) AND unescaped, which
        // let message content inject markup. Both fixed by going through the shell.
        const body = d.message || 'You have a message from AI Secretary';
        return {
          subject: d.subject || 'Message from AI Secretary',
          text: body,
          html: renderEmailShell({
            heading: d.subject || `Message from ${businessName}`,
            preheader: body.slice(0, 90),
            bodyHtml: `<p style="margin:0">${escapeHtml(body)}</p>`,
          }),
        };
      }
    }
  }
}
