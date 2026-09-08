/**
 * Dashboard appointment validation — thin wrapper over the shared implementation.
 *
 * The shared logic lives in `../../shared/appointmentValidation`.
 * We keep a simple `string | null` return shape for existing form callers.
 */
export {
  MAX_APPOINTMENT_DURATION_HOURS,
  VALID_INCREMENT_MINUTES,
  isFifteenMinuteIncrement,
} from '../../shared/appointmentValidation';

import { validateAppointmentTimeRange as validateShared } from '../../shared/appointmentValidation';

export function validateAppointmentTimeRange(startTime: string, endTime: string): string | null {
  const err = validateShared(startTime, endTime);
  return err ? err.error : null;
}
