import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Branchpoint",
  description: "Agent-driven QA scenario trees, forked in parallel on Runloop.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Kumo resolves light/dark from data-mode. The design is committed to light.
  return (
    <html lang="en" data-mode="light">
      <body className="bg-kumo-canvas text-kumo-default antialiased">{children}</body>
    </html>
  );
}
