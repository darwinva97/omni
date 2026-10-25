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
    const aplicar = (tema, acento, marco, marcoClaro) => {
      if (tema === "oscuro" || tema === "claro") { html.dataset.tema = tema; localStorage.setItem("omni.tema", tema); }
      if (ok(acento)) { html.style.setProperty("--acento-plataforma", acento.trim()); html.dataset.acento = "1"; localStorage.setItem("omni.acento", acento.trim()); }
      if (ok(marco)) {
        const claro = marcoClaro === true || marcoClaro === "1";
        html.style.setProperty("--marco-plataforma", marco.trim());
        html.dataset.marco = claro ? "claro" : "oscuro";
        localStorage.setItem("omni.marco", marco.trim() + "|" + (claro ? "1" : "0"));
      }
    };
    const url = new URL(location.href);
    const [marcoGuardado, claroGuardado] = (localStorage.getItem("omni.marco") || "").split("|");
    aplicar(
      url.searchParams.get("tema") || localStorage.getItem("omni.tema"),
      url.searchParams.get("acento") || localStorage.getItem("omni.acento"),
      url.searchParams.get("marco") || marcoGuardado,
      url.searchParams.has("marco") ? url.searchParams.get("marcoClaro") : claroGuardado,
    );
    if (["tema", "acento", "marco", "marcoClaro"].some((k) => url.searchParams.has(k))) {
      for (const k of ["tema", "acento", "marco", "marcoClaro"]) url.searchParams.delete(k);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || e.data.tipo !== "bepanel-tema") return;
      aplicar(e.data.tema, e.data.acento, e.data.marco, e.data.marcoClaro);
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
