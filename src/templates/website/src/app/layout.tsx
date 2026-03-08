import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "{{name}}",
  description: "{{description}}",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-sm">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <a href="/" className="text-lg font-bold text-[var(--accent)]">
              {{name}}
            </a>
            <div className="flex gap-6 text-sm">
              <a href="#features" className="text-[var(--muted)] hover:text-[var(--foreground)] transition-colors">
                Features
              </a>
              <a href="#about" className="text-[var(--muted)] hover:text-[var(--foreground)] transition-colors">
                About
              </a>
              <a
                href="#cta"
                className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-white font-medium hover:opacity-90 transition-opacity"
              >
                Get Started
              </a>
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="border-t border-[var(--border)] py-8 text-center text-sm text-[var(--muted)]">
          <p>&copy; {new Date().getFullYear()} {{name}}. All rights reserved.</p>
        </footer>
      </body>
    </html>
  );
}
