import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receipt-to-Ledger — Clocked Build Challenge",
  description:
    "Photograph a receipt. Clocked AI extracts every line, exact arithmetic verifies it, and it becomes an exportable ledger for small shop owners.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
