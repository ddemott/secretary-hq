import type { SessionContext } from '../sessionContext.js';
import type { ToolResponse, ToolsClient } from '../toolsClient.js';
import type { CallOutcomeTracker } from '../callOutcome.js';
import type { CallPhase } from '../toolPhases.js';
import type { TransferCapability } from './types.js';

export interface ToolBuildDeps {
  ctx: SessionContext;
  client: ToolsClient;
  transfer?: TransferCapability;
  outcome?: CallOutcomeTracker;
  speakFiller?: (phrase: string) => void;
  hasVerification: boolean;
  /**
   * Can this deployment actually SEND a text? (`ENABLE_SMS`.)
   *
   * The booking tool's `reminder_lead_minutes` parameter describes itself in terms
   * of texting, and the model reads parameter descriptions. With SMS off and
   * nothing saying so, it invented a consent flow out of that one description: on
   * 2026-09-09 (SCL_HQNeyh5cVKd9, SCL_A9GtJeZF7EwF) it told two callers "you
   * haven't given consent for text reminders yet", asked, got a yes, and said "I'll
   * note that you want a text reminder." `consent_records` is empty and no text can
   * leave the platform until 10DLC lands. Promising a text it cannot send is the
   * defect this whole product keeps relearning, so the parameter now DESCRIBES
   * ITSELF HONESTLY when texting is off, rather than relying on a prompt line to
   * out-argue it.
   */
  smsEnabled: boolean;
  canOfferTransfer: boolean;
  transferOrMessage: string;
  gateVerificationAdvice: (res: ToolResponse) => string;
  routeTo: (phase: CallPhase, reply: string) => Promise<string>;
}
