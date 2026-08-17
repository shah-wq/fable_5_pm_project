import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SolarFlow AI',
  description: 'Solar project management, from intake to PTO.',
  // Installable: the manifest turns the customer portal into a home-screen app
  // on Android and, once added, on iOS — the same code the store wrapper loads
  // (mobile spec §1, §8).
  manifest: '/manifest.webmanifest',
  applicationName: 'SolarFlow',
  appleWebApp: {
    capable: true,
    title: 'SolarFlow',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  formatDetection: { telephone: true },
};

export const viewport: Viewport = {
  themeColor: '#0b1f3a',
  width: 'device-width',
  initialScale: 1,
  // Zoom stays available: a homeowner reading a permit number on a phone needs
  // it, and blocking it is an accessibility failure, not a design choice.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
