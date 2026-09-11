import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Opportunity Hunter",
  description: "Operator dashboard for reviewing and acting on discovered opportunities.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="app-nav">
          <Link href="/" className="app-nav__brand">
            AI Opportunity Hunter
          </Link>
          <Link href="/">Dashboard</Link>
          <Link href="/opportunities">Opportunities</Link>
          <Link href="/companies">Companies</Link>
          <Link href="/analytics">Analytics</Link>
          <Link href="/companies/new">Research a company</Link>
        </nav>
        <div className="app-shell">{children}</div>
      </body>
    </html>
  );
}
