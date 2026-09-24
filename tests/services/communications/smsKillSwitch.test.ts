/**
 * WHO: every caller of SMSService.sendSMS (reminder worker, confirmations, POST /communications/sms)
 * WHAT: the platform SMS kill switch at the send chokepoint
 * WHEN: ENABLE_SMS is not the literal 'true' and the default provider is a real carrier
 * WHERE: src/services/communications/smsService.ts (smsDeliveryDisabled + sendSMS)
 * WHY: SMS is off until 10DLC — carriers drop every text while Telnyx reports success.
 *      Before this, only two routes read the flag; the rest relied on the consent check.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SMSService,
  smsDeliveryDisabled,
  SMS_DISABLED_ERROR,
} from '../../../src/services/communications/smsService.js';
import { providerRegistry } from '../../../src/services/communications/ProviderRegistry.js';

const OLD = process.env.ENABLE_SMS;
afterEach(() => {
  vi.restoreAllMocks();
  if (OLD === undefined) delete process.env.ENABLE_SMS;
  else process.env.ENABLE_SMS = OLD;
});

function stubProvider(name: string) {
  const sendSMS = vi.fn(async () => ({ messageSid: 'SM1' }));
  vi.spyOn(providerRegistry, 'getDefaultProvider').mockReturnValue({
    getName: () => name,
    sendSMS,
  });
  return sendSMS;
}

describe('smsDeliveryDisabled', () => {
  it('is true for a real carrier when ENABLE_SMS is unset', () => {
    stubProvider('telnyx');
    expect(smsDeliveryDisabled({})).toBe(true);
  });

  it("is true for a real carrier when ENABLE_SMS is anything but 'true'", () => {
    stubProvider('telnyx');
    expect(smsDeliveryDisabled({ ENABLE_SMS: 'false' })).toBe(true);
    expect(smsDeliveryDisabled({ ENABLE_SMS: '1' })).toBe(true);
  });

  it("is false for a real carrier when ENABLE_SMS is 'true'", () => {
    stubProvider('telnyx');
    expect(smsDeliveryDisabled({ ENABLE_SMS: 'true' })).toBe(false);
  });

  it('is false for the mock provider (reaches no handset — tests and sims keep working)', () => {
    stubProvider('mock');
    expect(smsDeliveryDisabled({})).toBe(false);
  });
});

describe('SMSService.sendSMS with the switch off', () => {
  it('SAD: refuses before touching the provider, config or consent, and says why', async () => {
    const providerSend = stubProvider('telnyx');
    delete process.env.ENABLE_SMS;
    const getTenantConfig = vi.fn();
    const canReceiveCommunications = vi.fn();
    const service = new SMSService(
      { getTenantConfig } as never,
      { canReceiveCommunications } as never
    );

    const result = await service.sendSMS('d1111111-1111-4111-8111-111111111111', {
      to: '+15551234567',
      body: 'Your appointment is tomorrow',
    });

    expect(result).toEqual({ success: false, error: SMS_DISABLED_ERROR, smsDisabled: true });
    expect(providerSend).not.toHaveBeenCalled();
    expect(getTenantConfig).not.toHaveBeenCalled();
    expect(canReceiveCommunications).not.toHaveBeenCalled();
  });
});
