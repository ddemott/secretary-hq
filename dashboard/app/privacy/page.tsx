import type { Metadata } from 'next';
import Link from 'next/link';
import {
  LEGAL_ADDRESS,
  LEGAL_DBA,
  LEGAL_PRIVACY_EMAIL,
  LEGAL_PROVIDER,
  LegalDocLayout,
  LegalNotice,
} from '../../components/legal/LegalDocLayout';

export const metadata: Metadata = {
  title: 'Privacy Policy — Secretary HQ',
  description: 'How Secretary HQ collects, uses, and shares personal information.',
};

/**
 * Structure follows the UK ICO controller privacy-notice headings (proven public
 * template). Call-handling language is the product’s published consent draft
 * (docs/legaldocs/AI_Secretary_Consent_and_Privacy_Language.md).
 */
export default function PrivacyPage(): React.ReactElement {
  return (
    <LegalDocLayout
      title="Privacy Policy"
      subtitle={`How ${LEGAL_PROVIDER} d/b/a ${LEGAL_DBA} collects and uses personal information on this website, in the dashboard, and when we answer a call for a business customer.`}
    >
      <LegalNotice />

      <section>
        <h2 className="text-xl font-semibold text-white">1. Who we are</h2>
        <p className="mt-3">
          {LEGAL_PROVIDER}, an Illinois limited liability company, doing business as {LEGAL_DBA}.
          Address: {LEGAL_ADDRESS}. Contact:{' '}
          <a className="text-sky-300 underline" href={`mailto:${LEGAL_PRIVACY_EMAIL}`}>
            {LEGAL_PRIVACY_EMAIL}
          </a>
          .
        </p>
        <p className="mt-3">
          For your <strong>Secretary HQ account</strong> (name, email, billing), we are the
          controller. For <strong>people who call a business that uses Secretary HQ</strong>, that
          business is the controller and we are their processor — see the{' '}
          <Link className="text-sky-300 underline" href="/dpa">
            DPA
          </Link>
          .
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">2. What we collect and why</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong>Account data:</strong> name, email, password hash, business name and type — to
            create and secure your account (contract).
          </li>
          <li>
            <strong>Billing data:</strong> processed by Stripe. We store subscription status and
            Stripe identifiers, not full card numbers (contract / legal obligation).
          </li>
          <li>
            <strong>Usage data:</strong> product logs, approximate technical metadata — to operate,
            secure, and improve the service (legitimate interests).
          </li>
          <li>
            <strong>Call handling (on behalf of a business customer):</strong> see section 3.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">3. AI call handling</h2>
        <p className="mt-3">
          When you call a business that uses Secretary HQ, your call is answered by an{' '}
          <strong>AI assistant</strong> that books appointments and answers questions on that
          business’s behalf.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong>What we process:</strong> the contents of the call (converted to text), and the
            contact and appointment details you provide.
          </li>
          <li>
            <strong>Why:</strong> to provide the service — answer the call, book or change
            appointments, and pass messages to the business.
          </li>
          <li>
            <strong>Recording:</strong> where a business enables recording, callers are notified at
            the start of the call. We do not use “training” as the spoken purpose. Default product
            posture is transcription for the service, not a separate training corpus.
          </li>
          <li>
            <strong>Model training:</strong> we do <strong>not</strong> use your call audio or
            transcripts to train foundation models unless the business has separately opted in, and
            then only de-identified text — never voiceprints.
          </li>
          <li>
            <strong>Your choices:</strong> to request access or deletion, contact the business you
            called, or write to {LEGAL_PRIVACY_EMAIL} and we will route the request.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">4. Who we share data with</h2>
        <p className="mt-3">
          We use vendors under contract, only to provide the service: Railway (hosting), LiveKit
          (voice transport), Telnyx (phone network), Deepgram (speech), OpenAI (language model), and
          Stripe (payments). We do not sell personal information.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">5. How long we keep it</h2>
        <p className="mt-3">
          Account data lasts for the life of the account, then as needed for tax and dispute
          records. Call transcripts and appointment records last as long as the business customer’s
          account needs them, or until that customer or a caller successfully asks us to delete
          them, subject to backups and law. Automated mass deletion is not enabled.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">6. Your rights</h2>
        <p className="mt-3">
          Depending on where you live (including California and the EEA/UK), you may have rights to
          access, correct, delete, or export personal information, to object or restrict certain
          processing, and to appeal a denial. Email {LEGAL_PRIVACY_EMAIL}. We will not discriminate
          against you for exercising these rights. If we process call data only as a processor, we
          will refer you to the business customer or handle the request on their instructions.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">7. Security and children</h2>
        <p className="mt-3">
          We use TLS, access control, and tenant isolation. No method is perfectly secure. The
          service is not directed at children under 16.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">8. International transfers</h2>
        <p className="mt-3">
          We and our subprocessors operate primarily in the United States. Cross-border transfers of
          Customer Personal Data, if any, are addressed in the{' '}
          <Link className="text-sky-300 underline" href="/dpa">
            DPA
          </Link>{' '}
          (Bonterms DPA v2.0, including standard contractual clauses where they apply).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">9. Changes</h2>
        <p className="mt-3">
          We will post updates on this page and change the effective date. Material changes to how
          we handle Customer Personal Data during a paid term will be notified as required by the
          Terms.
        </p>
      </section>
    </LegalDocLayout>
  );
}
