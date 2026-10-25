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


/*
 * Tema y acento de la plataforma que aloja el panel (BePanel lo abre dentro del
 * suyo): llegan una vez por la dirección (`?tema=oscuro&acento=…`) y se
 * recuerdan; con el panel abierto, la plataforma los cambia por `postMessage`.
 * Va en el <head> y antes de pintar: si no, se vería un destello del tema del
 * sistema. Sin nada guardado, el panel sigue al sistema como siempre.
 */
const TEMA_DE_PLATAFORMA = `(() => {
  try {
    const ok = (a) => typeof a === "string" && /^(#[0-9a-fA-F]{3,8}|oklch\\([0-9.% ]{5,40}\\)|rgb\\([0-9., %]{5,40}\\))$/.test(a.trim());
    const html = document.documentElement;
    const aplicar = (tema, acento) => {
      if (tema === "oscuro" || tema === "claro") { html.dataset.tema = tema; localStorage.setItem("omni.tema", tema); }
      if (ok(acento)) { html.style.setProperty("--acento-plataforma", acento.trim()); html.dataset.acento = "1"; localStorage.setItem("omni.acento", acento.trim()); }
    };
    const url = new URL(location.href);
    aplicar(url.searchParams.get("tema") || localStorage.getItem("omni.tema"), url.searchParams.get("acento") || localStorage.getItem("omni.acento"));
    if (url.searchParams.has("tema") || url.searchParams.has("acento")) {
      url.searchParams.delete("tema"); url.searchParams.delete("acento");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || e.data.tipo !== "bepanel-tema") return;
      aplicar(e.data.tema, e.data.acento);
    });
  } catch {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: TEMA_DE_PLATAFORMA }} />
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <RegistrarPwa />
      </body>
    </html>
  );
}
