"use client";
import { useEffect, useState } from "react";

/**
 * Dentro del panel de una plataforma (un iframe), quien llega aquí no tiene contraseña de Omni: entra
 * con el enlace de un solo uso del panel. En vez del formulario, se avisa al panel (`omni-sin-sesion`)
 * para que abra una entrada nueva, y se dice qué hacer si no llega.
 */
export function SinSesionEmbebido({ children }: { children: React.ReactNode }) {
  const [embebido, setEmbebido] = useState(false);
  useEffect(() => {
    let dentro = false;
    try {
      dentro = window.self !== window.top;
    } catch {
      dentro = true;
    }
    if (!dentro) return;
    setEmbebido(true);
    window.parent.postMessage({ tipo: "omni-sin-sesion" }, "*");
  }, []);
  if (!embebido) return <>{children}</>;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 text-center">
      <p className="text-sm font-medium">Abriendo tu WhatsApp…</p>
      <p className="mt-2 text-xs text-(--color-tenue)">
        Si no se abre, pulsa «Abrir en otra pestaña» en tu panel.
      </p>
    </main>
  );
}
