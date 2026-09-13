import type { TenantConfigService } from '../tenants/index.js';
import { formatLeadTime } from './formatLead.js';

/**
 * Escape a value for safe interpolation inside an HTML attribute
 * (double-quoted). logoUrl and businessName both ultimately come from
 * owner-editable tenant fields, and generateBaseTemplate interpolates
 * them raw into `<img src="..." alt="...">` — an unescaped quote or
 * angle bracket breaks out of the attribute (Copilot review, PR #452).
 * The route-level validation on logo_url (src/routes/tenants.ts) is the
 * primary defense; this is defense-in-depth for any other writer.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface EmailTemplateData {
  customerName: string;
  serviceName: string;
  staffName: string;
  dateTime: string;
  duration: number;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  businessAddress?: string;
  notes?: string;
  reason?: string;
  hoursUntil?: number;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  cancelLink?: string | null;
  rescheduleLink?: string | null;
}

export class EmailTemplateService {
  constructor(private configService: TenantConfigService) {}

  /**
   * Generate professional HTML email template with business branding
   */
  private generateBaseTemplate(content: string, data: EmailTemplateData): string {
    const primaryColor = data.primaryColor || '#3B82F6';
    const secondaryColor = data.secondaryColor || '#64748B';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.businessName} - Appointment Notification</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #374151;
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .header {
      background: linear-gradient(135deg, ${primaryColor}, ${primaryColor}dd);
      color: white;
      padding: 30px 40px;
      text-align: center;
    }
    .logo {
      max-width: 150px;
      height: auto;
      margin-bottom: 15px;
    }
    .business-name {
      font-size: 24px;
      font-weight: bold;
      margin: 0;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }
    .content {
      padding: 40px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 20px;
    }
    .appointment-card {
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 25px;
      margin: 25px 0;
    }
    .appointment-detail {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #e5e7eb;
    }
    .appointment-detail:last-child {
      border-bottom: none;
    }
    .detail-label {
      font-weight: 600;
      color: #374151;
      min-width: 120px;
    }
    .detail-value {
      color: #6b7280;
      text-align: right;
    }
    .highlight-box {
      background: ${primaryColor}15;
      border-left: 4px solid ${primaryColor};
      padding: 20px;
      margin: 25px 0;
      border-radius: 0 6px 6px 0;
    }
    .highlight-text {
      color: ${primaryColor};
      font-weight: 600;
      margin: 0;
    }
    .footer {
      background: #f8fafc;
      padding: 30px 40px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .contact-info {
      margin-bottom: 20px;
    }
    .contact-item {
      display: inline-block;
      margin: 0 15px;
      color: #6b7280;
      text-decoration: none;
    }
    .contact-item:hover {
      color: ${primaryColor};
    }
    .unsubscribe {
      font-size: 12px;
      color: #9ca3af;
      margin-top: 20px;
    }
    .button {
      display: inline-block;
      background: ${primaryColor};
      color: white;
      padding: 12px 24px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      margin: 10px 5px;
      transition: background-color 0.2s;
    }
    .button:hover {
      background: ${primaryColor}dd;
    }
    .button.secondary {
      background: ${secondaryColor};
    }
    .button.secondary:hover {
      background: ${secondaryColor}dd;
    }
    @media (max-width: 600px) {
      .container {
        margin: 10px;
        border-radius: 0;
      }
      .header, .content, .footer {
        padding: 20px;
      }
      .appointment-detail {
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
      }
      .detail-value {
        text-align: left;
      }
      .contact-item {
        display: block;
        margin: 5px 0;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${data.logoUrl ? `<img src="${escapeHtmlAttr(data.logoUrl)}" alt="${escapeHtmlAttr(data.businessName)}" class="logo">` : ''}
      <h1 class="business-name">${data.businessName}</h1>
    </div>

    <div class="content">
      ${content}
    </div>

    <div class="footer">
      <div class="contact-info">
        ${
          data.businessPhone
            ? `<a href="tel:${data.businessPhone}" class="contact-item">📞 ${data.businessPhone}</a>`
            : ''
        }
        ${
          data.businessEmail
            ? `<a href="mailto:${data.businessEmail}" class="contact-item">✉️ ${data.businessEmail}</a>`
            : ''
        }
        ${data.businessAddress ? `<div class="contact-item">📍 ${data.businessAddress}</div>` : ''}
      </div>
      <div class="unsubscribe">
        You're receiving this because you have an appointment with us.<br>
        <a href="#" style="color: #9ca3af;">Unsubscribe</a> from future emails.
      </div>
      <!--
        Platform attribution, footer-only and deliberately small. This email is
        the BUSINESS writing to THEIR customer, so the masthead stays theirs;
        the vendor mark belongs down here, at "powered by" size, or the customer
        is left wondering who SecretaryHQ is. Rendered as text rather than the
        logo image so it needs no attachment on the tenant send path.
      -->
      <div style="margin-top:14px;font-size:12px;color:#9ca3af">
        Powered by <span style="color:#1B2B4B;font-weight:bold">Secretary</span><span style="color:#5E8DD6;font-weight:bold">HQ</span>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Generate appointment confirmation email
   */
  generateAppointmentConfirmation(data: EmailTemplateData): {
    subject: string;
    html: string;
    text: string;
  } {
    const content = `
      <h2 class="greeting">Hi ${data.customerName},</h2>

      <p>Great news! Your appointment has been confirmed and we're excited to see you.</p>

      <div class="appointment-card">
        <h3 style="margin-top: 0; color: #1f2937;">📅 Appointment Details</h3>
        <div class="appointment-detail">
          <span class="detail-label">Service:</span>
          <span class="detail-value">${data.serviceName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">With:</span>
          <span class="detail-value">${data.staffName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">Date & Time:</span>
          <span class="detail-value">${data.dateTime}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">Duration:</span>
          <span class="detail-value">${data.duration} minutes</span>
        </div>
        ${
          data.notes
            ? `
        <div class="appointment-detail">
          <span class="detail-label">Notes:</span>
          <span class="detail-value">${data.notes}</span>
        </div>
        `
            : ''
        }
      </div>

      <div class="highlight-box">
        <p class="highlight-text">💡 What to expect: Arrive 10 minutes early. Bring any relevant documents or photos.</p>
      </div>

      ${
        data.cancelLink || data.rescheduleLink
          ? ''
          : '<p>If you need to reschedule or cancel, please contact us at least 24 hours in advance.</p>'
      }

      <div style="text-align: center; margin: 30px 0;">
        ${data.cancelLink ? `<a href="${data.cancelLink}" class="button secondary" style="background: #64748B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 10px 5px; display: inline-block;">Cancel Appointment</a>` : ''}
        ${data.rescheduleLink ? `<a href="${data.rescheduleLink}" class="button secondary" style="background: #64748B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 10px 5px; display: inline-block;">Request Reschedule</a>` : ''}
      </div>

      <p>We look forward to seeing you!</p>
      <p>Best regards,<br><strong>The ${data.businessName} Team</strong></p>
    `;

    const text = `
Hi ${data.customerName},

Great news! Your appointment has been confirmed.

APPOINTMENT DETAILS:
Service: ${data.serviceName}
With: ${data.staffName}
Date & Time: ${data.dateTime}
Duration: ${data.duration} minutes
${data.notes ? `Notes: ${data.notes}` : ''}

What to expect: Arrive 10 minutes early. Bring any relevant documents or photos.

${data.cancelLink || data.rescheduleLink ? '' : 'If you need to reschedule or cancel, please contact us at least 24 hours in advance.\n'}${data.cancelLink ? `Cancel: ${data.cancelLink}\n` : ''}${data.rescheduleLink ? `Reschedule: ${data.rescheduleLink}\n` : ''}
We look forward to seeing you!

Best regards,
The ${data.businessName} Team

${data.businessPhone ? `Phone: ${data.businessPhone}` : ''}
${data.businessEmail ? `Email: ${data.businessEmail}` : ''}
${data.businessAddress ? `Address: ${data.businessAddress}` : ''}
    `;

    return {
      subject: `✅ Appointment Confirmed - ${data.serviceName}`,
      html: this.generateBaseTemplate(content, data),
      text,
    };
  }

  /**
   * Generate appointment reminder email
   */
  generateAppointmentReminder(data: EmailTemplateData & { hoursUntil: number }): {
    subject: string;
    html: string;
    text: string;
  } {
    const urgencyEmoji = data.hoursUntil <= 2 ? '🚨' : data.hoursUntil <= 24 ? '🔔' : '📅';
    // Say the real lead. A sub-hour lead (the voice flow's 30-minute default)
    // used to fall into the "in just a few hours" bucket, which is both vague
    // and wrong — the appointment is in 30 minutes, not a few hours.
    const urgencyText = `in ${formatLeadTime(data.hoursUntil * 60)}`;

    const content = `
      <h2 class="greeting">Hi ${data.customerName},</h2>

      <p>This is a friendly reminder about your upcoming appointment.</p>

      <div class="appointment-card">
        <h3 style="margin-top: 0; color: #1f2937;">${urgencyEmoji} Appointment Reminder</h3>
        <div class="appointment-detail">
          <span class="detail-label">Service:</span>
          <span class="detail-value">${data.serviceName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">With:</span>
          <span class="detail-value">${data.staffName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">Date & Time:</span>
          <span class="detail-value">${data.dateTime}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">Duration:</span>
          <span class="detail-value">${data.duration} minutes</span>
        </div>
      </div>

      <div class="highlight-box">
        <p class="highlight-text">⏰ Your appointment is ${urgencyText}. Please arrive 10 minutes early.</p>
      </div>

      ${
        data.cancelLink || data.rescheduleLink
          ? ''
          : '<p>If you need to reschedule or cancel, please contact us immediately.</p>'
      }

      <div style="text-align: center; margin: 30px 0;">
        ${data.cancelLink ? `<a href="${data.cancelLink}" class="button secondary" style="background: #64748B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 10px 5px; display: inline-block;">Cancel Appointment</a>` : ''}
        ${data.rescheduleLink ? `<a href="${data.rescheduleLink}" class="button secondary" style="background: #64748B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 10px 5px; display: inline-block;">Request Reschedule</a>` : ''}
      </div>

      <p>See you soon!</p>
      <p>Best regards,<br><strong>The ${data.businessName} Team</strong></p>
    `;

    const text = `
Hi ${data.customerName},

This is a reminder about your upcoming appointment.

APPOINTMENT DETAILS:
Service: ${data.serviceName}
With: ${data.staffName}
Date & Time: ${data.dateTime}
Duration: ${data.duration} minutes

Your appointment is ${urgencyText}. Please arrive 10 minutes early.

${data.cancelLink || data.rescheduleLink ? '' : 'If you need to reschedule or cancel, please contact us immediately.\n'}${data.cancelLink ? `Cancel: ${data.cancelLink}\n` : ''}${data.rescheduleLink ? `Reschedule: ${data.rescheduleLink}\n` : ''}
See you soon!

Best regards,
The ${data.businessName} Team

${data.businessPhone ? `Phone: ${data.businessPhone}` : ''}
${data.businessEmail ? `Email: ${data.businessEmail}` : ''}
${data.businessAddress ? `Address: ${data.businessAddress}` : ''}
    `;

    return {
      subject: `${urgencyEmoji} Appointment Reminder - ${data.hoursUntil}h away`,
      html: this.generateBaseTemplate(content, data),
      text,
    };
  }

  /**
   * Generate appointment cancellation email
   */
  generateAppointmentCancellation(data: EmailTemplateData & { reason?: string }): {
    subject: string;
    html: string;
    text: string;
  } {
    const content = `
      <h2 class="greeting">Hi ${data.customerName},</h2>

      <p>We're writing to confirm that your appointment has been cancelled.</p>

      <div class="appointment-card">
        <h3 style="margin-top: 0; color: #dc2626;">❌ Cancelled Appointment</h3>
        <div class="appointment-detail">
          <span class="detail-label">Service:</span>
          <span class="detail-value">${data.serviceName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">With:</span>
          <span class="detail-value">${data.staffName}</span>
        </div>
        <div class="appointment-detail">
          <span class="detail-label">Date & Time:</span>
          <span class="detail-value">${data.dateTime}</span>
        </div>
        ${
          data.reason
            ? `
        <div class="appointment-detail">
          <span class="detail-label">Reason:</span>
          <span class="detail-value">${data.reason}</span>
        </div>
        `
            : ''
        }
      </div>

      <p>We understand that plans can change, and we'd be happy to help you reschedule for another time that works better for you.</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="#" class="button">Book New Appointment</a>
        <a href="#" class="button secondary">Contact Us</a>
      </div>

      <p>Thank you for letting us know in advance.</p>
      <p>Best regards,<br><strong>The ${data.businessName} Team</strong></p>
    `;

    const text = `
Hi ${data.customerName},

We're writing to confirm that your appointment has been cancelled.

CANCELLED APPOINTMENT:
Service: ${data.serviceName}
With: ${data.staffName}
Date & Time: ${data.dateTime}
${data.reason ? `Reason: ${data.reason}` : ''}

We'd be happy to help you reschedule for another time that works better for you.

Please contact us to book a new appointment.

Thank you for letting us know in advance.

Best regards,
The ${data.businessName} Team

${data.businessPhone ? `Phone: ${data.businessPhone}` : ''}
${data.businessEmail ? `Email: ${data.businessEmail}` : ''}
${data.businessAddress ? `Address: ${data.businessAddress}` : ''}
    `;

    return {
      subject: `❌ Appointment Cancelled - ${data.serviceName}`,
      html: this.generateBaseTemplate(content, data),
      text,
    };
  }

  /**
   * Generate welcome email for new customers
   */
  generateWelcomeEmail(data: Partial<EmailTemplateData> & { businessName: string }): {
    subject: string;
    html: string;
    text: string;
  } {
    const content = `
      <h2 class="greeting">Welcome to ${data.businessName}!</h2>

      <p>Thank you for choosing us. We're excited to have you as a customer and look forward to providing you with exceptional service.</p>

      <div class="highlight-box">
        <p class="highlight-text">🎉 Your account has been created successfully. You can now book appointments online and manage your preferences.</p>
      </div>

      <p>Here's what you can do with your account:</p>
      <ul>
        <li>📅 Book appointments online 24/7</li>
        <li>📱 Receive SMS and email reminders</li>
        <li>🔄 Reschedule or cancel appointments easily</li>
        <li>💬 Get AI-powered assistance for questions</li>
      </ul>

      <div style="text-align: center; margin: 30px 0;">
        <a href="#" class="button">Book Your First Appointment</a>
      </div>

      <p>If you have any questions, please don't hesitate to contact us.</p>
      <p>Welcome aboard!</p>
      <p>Best regards,<br><strong>The ${data.businessName} Team</strong></p>
    `;

    const text = `
Welcome to ${data.businessName}!

Thank you for choosing us. We're excited to have you as a customer.

Your account has been created successfully. You can now:
- Book appointments online 24/7
- Receive SMS and email reminders
- Reschedule or cancel appointments easily
- Get AI-powered assistance for questions

If you have any questions, please contact us.

Welcome aboard!

Best regards,
The ${data.businessName} Team

${data.businessPhone ? `Phone: ${data.businessPhone}` : ''}
${data.businessEmail ? `Email: ${data.businessEmail}` : ''}
${data.businessAddress ? `Address: ${data.businessAddress}` : ''}
    `;

    return {
      subject: `🎉 Welcome to ${data.businessName}!`,
      html: this.generateBaseTemplate(content, data as EmailTemplateData),
      text,
    };
  }
}
