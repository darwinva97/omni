import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RegistrarPwa } from "@/componentes/pwa";

export const metadata: Metadata = {
  title: "Omni",
  description: "Plataforma multicanal de mensajería",
  appleWebApp: { capable: true, title: "Omni", statusBarStyle: "default" },
};

/**
 * `viewport-fit: cover` y el color de tema por esquema.
 *
 * Sin `viewport-fit`, en un móvil con muesca el compositor queda debajo de la
 * barra del sistema. Y el color de tema tiene que cambiar con el esquema o la
 * barra superior se queda clara sobre una aplicación oscura.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#19191f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">
        {children}
        <RegistrarPwa />
      </body>
    </html>
  );
}
