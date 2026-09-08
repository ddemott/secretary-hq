import type { Metadata } from 'next';
import Link from 'next/link';
import {
  LEGAL_ADDRESS,
  LEGAL_DBA,
  LEGAL_EMAIL,
  LEGAL_PROVIDER,
  LegalDocLayout,
  LegalNotice,
} from '../../components/legal/LegalDocLayout';

export const metadata: Metadata = {
  title: 'Terms of Service — Secretary HQ',
  description:
    'Secretary HQ terms of service, incorporating the Bonterms Standard Online Cloud Terms.',
};

const BONTERMS_TERMS = 'https://bonterms.com/standard/online-cloud-terms';

export default function TermsPage(): React.ReactElement {
  return (
    <LegalDocLayout
      title="Terms of Service"
      subtitle={`${LEGAL_PROVIDER} d/b/a ${LEGAL_DBA} provides the Secretary HQ cloud service under the Bonterms Standard Online Cloud Terms (Version 1.0), plus the Provider-Specific Terms below.`}
    >
      <LegalNotice />

      <section>
        <h2 className="text-xl font-semibold text-white">1. How these Terms work</h2>
        <p className="mt-3">
          These Terms are implemented by reference from this Website, which is how the{' '}
          <a className="text-sky-300 underline" href={BONTERMS_TERMS}>
            Bonterms Standard Online Cloud Terms (Version 1.0)
          </a>{' '}
          are designed to be used. Those Standard Terms are free to use under{' '}
          <a className="text-sky-300 underline" href="https://creativecommons.org/licenses/by/4.0/">
            CC BY 4.0
          </a>{' '}
          and were drafted by the Bonterms committee of 120+ lawyers.
        </p>
        <p className="mt-3">
          <strong>The Agreement</strong> is: (i) the Provider-Specific Terms on this page, (ii) the
          Bonterms Standard Online Cloud Terms (Version 1.0) at the URL above, and (iii) any Order
          (including a self-serve signup or paid subscription). You agree when you first access the
          Cloud Service or enter an Order, whichever is earlier.
        </p>
        <p className="mt-3">
          If those parts conflict, this page (Provider-Specific Terms) controls over the Standard
          Terms, except that a later signed Amendment controls over both.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">2. Provider-Specific Terms (Cover)</h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr]">
          <dt className="text-slate-400">Provider</dt>
          <dd>
            {LEGAL_PROVIDER}, an Illinois limited liability company, doing business as {LEGAL_DBA}
          </dd>
          <dt className="text-slate-400">Address</dt>
          <dd>{LEGAL_ADDRESS}</dd>
          <dt className="text-slate-400">Notice</dt>
          <dd>
            <a className="text-sky-300 underline" href={`mailto:${LEGAL_EMAIL}`}>
              {LEGAL_EMAIL}
            </a>
          </dd>
          <dt className="text-slate-400">Website</dt>
          <dd>https://www.secretaryhq.com</dd>
          <dt className="text-slate-400">Cloud Service</dt>
          <dd>
            Secretary HQ — multi-tenant AI receptionist (voice, scheduling, messaging, and related
            dashboard) for service businesses
          </dd>
          <dt className="text-slate-400">Governing law / venue</dt>
          <dd>Illinois, United States; state and federal courts in Kane County, Illinois</dd>
          <dt className="text-slate-400">DPA</dt>
          <dd>
            The{' '}
            <Link className="text-sky-300 underline" href="/dpa">
              Data Protection Addendum
            </Link>{' '}
            on this Website
          </dd>
          <dt className="text-slate-400">Privacy</dt>
          <dd>
            The{' '}
            <Link className="text-sky-300 underline" href="/privacy">
              Privacy Policy
            </Link>{' '}
            on this Website
          </dd>
          <dt className="text-slate-400">Support / SLA</dt>
          <dd>
            Email support at {LEGAL_EMAIL}. No separate paid SLA unless an Order says otherwise.
            Standard Terms default availability (commercially reasonable / 99.9% if no SLA is named)
            applies.
          </dd>
        </dl>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">3. Additional Terms (AI receptionist)</h2>
        <p className="mt-3">These additions modify the Standard Terms for this product:</p>
        <ol className="mt-3 list-decimal space-y-3 pl-5">
          <li>
            <strong>Roles.</strong> You (the business customer) are the controller of your callers’
            personal data. We process that data as your processor to answer calls, book or change
            appointments, take messages, and operate the dashboard. See the DPA.
          </li>
          <li>
            <strong>AI disclosure.</strong> The Cloud Service answers the phone with an AI
            assistant. You are responsible for informing your callers as required where you and they
            are located. We supply a spoken disclosure. You must not disable a disclosure required
            by law.
          </li>
          <li>
            <strong>Transcripts, not training.</strong> We transcribe calls to provide the service.
            We do not use your call audio or transcripts to train foundation models unless an Order
            or in-product setting you opt into says otherwise. Voiceprints are not collected.
          </li>
          <li>
            <strong>No HIPAA / no PHI.</strong> The Cloud Service is not designed for High-Risk
            Activities or Sensitive Data as defined in the Standard Terms, including protected
            health information. Medical, dental, chiropractic, optometry, and veterinary uses are
            not permitted.
          </li>
          <li>
            <strong>SMS.</strong> Outbound text messaging is off unless we enable it in writing
            after 10DLC (or equivalent) registration. The assistant must not promise a text we
            cannot send.
          </li>
          <li>
            <strong>Third-Party Platforms</strong> used to deliver the Cloud Service include LiveKit
            (voice), Telnyx (telephony), Deepgram (speech), OpenAI (language model), Stripe
            (billing), and our hosting providers. Your use of an optional integration you enable
            (for example a calendar) is governed by that provider’s terms.
          </li>
          <li>
            <strong>Trials.</strong> A self-serve trial or demo tenant is a Trial under Section 18
            of the Standard Terms (no warranty, indemnity, SLA, or Support; liability cap US $1,000)
            unless an Order says otherwise.
          </li>
        </ol>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">4. Standard Terms (incorporated)</h2>
        <p className="mt-3">
          The full Bonterms Standard Online Cloud Terms (Version 1.0) are incorporated here:{' '}
          <a className="text-sky-300 underline" href={BONTERMS_TERMS}>
            {BONTERMS_TERMS}
          </a>
          . They cover permitted use, users, affiliates, customer data, security, DPA pointer, usage
          data, warranties and disclaimers, usage rules (including Sensitive Data), fees,
          suspension, term, IP, liability caps, indemnities, confidentiality, trials, and
          definitions.
        </p>
        <p className="mt-3 text-sm text-slate-400">
          Attribution: © Bonterms. Standard Online Cloud Terms v1.0 used under CC BY 4.0. Bonterms
          is not a law firm and is not a party to this Agreement.
        </p>
      </section>
    </LegalDocLayout>
  );
}
