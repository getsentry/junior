import type { ReactNode } from "react";

/**
 * Minimal root layout export for apps that do not provide one yet.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
