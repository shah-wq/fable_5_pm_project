import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SolarFlow AI',
  description: 'Solar project management, from intake to PTO.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
