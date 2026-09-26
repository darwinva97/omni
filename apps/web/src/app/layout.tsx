import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omni",
  description: "Plataforma multicanal de mensajería",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
