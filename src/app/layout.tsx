import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Contract Analyzer | Production Legal Contract AI',
  description: 'Production-quality legal contract analyzer with verified citations, clause-level comparison, and agentic document research.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-slate-50 text-slate-900 h-screen w-screen overflow-hidden flex flex-col font-sans">
        {children}
      </body>
    </html>
  );
}
