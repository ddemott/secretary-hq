export interface EmailMessage {
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  template?: string;
  templateData?: Record<string, unknown>;
}

export interface SMSMessage {
  to: string;
  body?: string;
  template?: string;
  templateData?: Record<string, unknown>;
}

export interface CommunicationResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** Set when the send was refused by the platform SMS kill switch (ENABLE_SMS off). */
  smsDisabled?: boolean;
}

export interface AppointmentData {
  customerName: string;
  serviceName: string;
  staffName: string;
  dateTime: string;
  duration: number;
  notes?: string;
  /** UUID of the appointment — used to generate self-service cancel links. */
  appointmentId?: string;
}

export interface ReminderData extends AppointmentData {
  hoursUntilAppointment: number;
}
