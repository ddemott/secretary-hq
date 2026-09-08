import type { Metadata } from 'next';
import Link from 'next/link';
import {
  LEGAL_ADDRESS,
  LEGAL_DBA,
  LEGAL_EFFECTIVE,
  LEGAL_EMAIL,
  LEGAL_PROVIDER,
  LegalDocLayout,
  LegalNotice,
} from '../../components/legal/LegalDocLayout';

export const metadata: Metadata = {
  title: 'Data Protection Addendum — Secretary HQ',
  description: 'Secretary HQ DPA, implementing the Bonterms Standard DPA v2.0.',
};

const BONTERMS_DPA = 'https://bonterms.com/standard/dpa-v2-cover-page-version';

export default function DpaPage(): React.ReactElement {
  return (
    <LegalDocLayout
      title="Data Protection Addendum"
      subtitle={`${LEGAL_PROVIDER} d/b/a ${LEGAL_DBA} offers this DPA to business customers. It implements the Bonterms Standard Data Protection Addendum Version 2.0.`}
    >
      <LegalNotice />

      <section>
        <h2 className="text-xl font-semibold text-white">1. How this DPA works</h2>
        <p className="mt-3">
          This page is the Cover Page. It incorporates the{' '}
          <a className="text-sky-300 underline" href={BONTERMS_DPA}>
            Bonterms Data Protection Addendum Version 2.0 (Cover Page Version)
          </a>
          , released under{' '}
          <a className="text-sky-300 underline" href="https://creativecommons.org/licenses/by/4.0/">
            CC BY 4.0
          </a>{' '}
          and reviewed by privacy lawyers across the US, UK, and EU. That Standard DPA (including
          Exhibits A and B) is part of this DPA.
        </p>
        <p className="mt-3">
          This DPA is part of the{' '}
          <Link className="text-sky-300 underline" href="/terms">
            Terms of Service
          </Link>{' '}
          (the Main Agreement). It applies when we Process Customer Personal Data for you. You agree
          by using the Cloud Service or by signing an Order that references these pages.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">2. Cover Page — Key Terms</h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-[12rem_1fr]">
          <dt className="text-slate-400">Provider</dt>
          <dd>
            {LEGAL_PROVIDER} d/b/a {LEGAL_DBA}
          </dd>
          <dt className="text-slate-400">Provider address</dt>
          <dd>{LEGAL_ADDRESS}</dd>
          <dt className="text-slate-400">Customer</dt>
          <dd>The business that creates a Secretary HQ account or signs an Order</dd>
          <dt className="text-slate-400">Main Agreement</dt>
          <dd>
            The{' '}
            <Link className="text-sky-300 underline" href="/terms">
              Secretary HQ Terms of Service
            </Link>
          </dd>
          <dt className="text-slate-400">DPA Effective Date</dt>
          <dd>
            {LEGAL_EFFECTIVE}, or the date you first use the Cloud Service, whichever is later
          </dd>
          <dt className="text-slate-400">Roles</dt>
          <dd>
            Customer is Controller (or a Processor for its own customers). Provider is Processor of
            Customer Personal Data in call transcripts, caller contact details, appointments, and
            messages.
          </dd>
          <dt className="text-slate-400">Designated EU governing law / member state</dt>
          <dd>Ireland (if EU GDPR transfer terms apply)</dd>
          <dt className="text-slate-400">Security incident notice</dt>
          <dd>48 hours after we become aware, as in the Standard DPA</dd>
          <dt className="text-slate-400">Notice</dt>
          <dd>
            <a className="text-sky-300 underline" href={`mailto:${LEGAL_EMAIL}`}>
              {LEGAL_EMAIL}
            </a>
          </dd>
        </dl>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">3. Processing details</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong>Subject matter:</strong> providing the AI receptionist Cloud Service — answer
            inbound calls, transcribe, book or change appointments, take messages, and show that
            activity in the dashboard.
          </li>
          <li>
            <strong>Duration:</strong> the subscription, then deletion on request within 60 days as
            in the Main Agreement, subject to backups and law.
          </li>
          <li>
            <strong>Types of personal data:</strong> caller name and phone number, appointment
            times, message content, call transcripts, and account-user name and email.
          </li>
          <li>
            <strong>Special / sensitive data:</strong> not intended. The Cloud Service must not be
            used for PHI or other Sensitive Data. HIPAA verticals are excluded.
          </li>
          <li>
            <strong>Data subjects:</strong> your staff (account users) and people who call your
            business line.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">4. Subprocessor list</h2>
        <p className="mt-3">
          We may use these subprocessors to Process Customer Personal Data. We will update this list
          and give at least 30 days’ notice before a new subprocessor Processes Customer Personal
          Data, as required by the Standard DPA.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>Railway — application hosting (United States)</li>
          <li>LiveKit — realtime voice transport (United States)</li>
          <li>Telnyx — telephony / PSTN (United States)</li>
          <li>Deepgram — speech-to-text and text-to-speech (United States)</li>
          <li>OpenAI — language model inference (United States)</li>
          <li>Stripe — subscription billing (United States)</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white">5. Security measures</h2>
        <p className="mt-3">
          If the Standard DPA needs Security Measures on the Cover Page and none are listed in an
          Order, we use: TLS in transit, access control and tenant isolation on stored data
          (including row-level security in the application database), least-privilege production
          access, and vendor subprocessors under written terms. Details may be updated as the
          product changes; material reductions will not be made during a paid Subscription Term
          without notice.
        </p>
      </section>

      <p className="text-sm text-slate-400">
        Attribution: © Bonterms. DPA v2.0 used under CC BY 4.0. Bonterms is not a law firm and is
        not a party to this DPA.
      </p>
    </LegalDocLayout>
  );
}
