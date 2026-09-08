import type { Metadata } from 'next';
import { Bebas_Neue, DM_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';
import { Providers } from './providers';
import { VersionBadge } from '../components/ui/VersionBadge';
import React from 'react';

const bebasNeue = Bebas_Neue({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-bebas-neue',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Secretary HQ',
  description: 'AI-powered receptionist for service businesses',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="navy"
      className={`dark ${bebasNeue.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Inline critical theme to prevent white flash before React hydrates */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
          html { background-color: #090E1A; color: #E8F0FF; }
        `,
          }}
        />
        {/* Apply saved theme before React loads */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
          try {
            var t = localStorage.getItem('theme');
            if (t) document.documentElement.setAttribute('data-theme', t);
          } catch(e) {}
        `,
          }}
        />
      </head>
      <body className="antialiased" style={{ fontFamily: 'var(--font-body)' }}>
        <Providers>{children}</Providers>
        <VersionBadge />
      </body>
    </html>
  );
}
