import Link from 'next/link';
import type { ReactNode, ReactElement } from 'react';

export const LEGAL_EFFECTIVE = 'August 14, 2026';
export const LEGAL_PROVIDER = 'Thinking Hammer LLC';
export const LEGAL_DBA = 'Secretary HQ';
export const LEGAL_ADDRESS = '331 Ridley St, North Aurora, IL 60542, United States';
export const LEGAL_EMAIL = 'legal@secretaryhq.com';
export const LEGAL_PRIVACY_EMAIL = 'privacy@secretaryhq.com';

export function LegalDocLayout(props: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="legal-doc min-h-screen" style={{ background: '#090E1A', color: '#E8F0FF' }}>
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <Link href="/" className="text-sm font-bold tracking-[0.18em] text-sky-300">
            SECRETARY HQ
          </Link>
          <nav className="flex gap-5 text-sm text-slate-300">
            <Link href="/privacy" className="hover:text-white">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-white">
              Terms
            </Link>
            <Link href="/dpa" className="hover:text-white">
              DPA
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-400">Legal</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">{props.title}</h1>
        <p className="mt-3 text-slate-300">{props.subtitle}</p>
        <p className="mt-2 text-sm text-slate-400">Effective {LEGAL_EFFECTIVE}.</p>
        <div className="legal-prose mt-10 space-y-6 text-[15px] leading-7 text-slate-200">
          {props.children}
        </div>
      </main>
      <footer className="border-t border-white/10 py-8 text-center text-sm text-slate-400">
        <p>
          © 2026 {LEGAL_PROVIDER} d/b/a {LEGAL_DBA}.{' '}
          <Link href="/" className="text-sky-300 hover:underline">
            Home
          </Link>
        </p>
      </footer>
    </div>
  );
}

export function LegalNotice(): ReactElement {
  return (
    <aside className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
      These pages implement published, lawyer-committee templates (Bonterms Standard Agreements, CC
      BY 4.0) plus a privacy notice written for this product. They are{' '}
      <strong>not a substitute for advice from your own lawyer</strong>. Bonterms is not a party to
      your agreement with us.
    </aside>
  );
}
