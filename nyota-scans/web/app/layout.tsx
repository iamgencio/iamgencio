import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import { Header } from '@/components/Header';

export const metadata: Metadata = {
  title: { default: 'Nyota Scans — Mangas & BD africaines en streaming', template: '%s · Nyota Scans' },
  description: "Le Netflix des scans : lisez mangas, manhwas et BD africaines légalement, par Starlight Network.",
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <AuthProvider>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <div>
              <b>Nyota Scans</b> · une plateforme <b>Starlight Network</b>
              <p>Chaque histoire est une étoile. Œuvres publiées par leurs créateurs ou sous licence.</p>
            </div>
            <div className="footer-links">
              <Link href="/browse">Catalogue</Link><Link href="/premium">Premium</Link><Link href="/register?role=creator">Publier vos œuvres</Link>
            </div>
          </footer>
        </AuthProvider>
      </body>
    </html>
  );
}
