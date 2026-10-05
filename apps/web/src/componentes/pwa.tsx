"use client";

import { useEffect } from "react";

/**
 * Registra el service worker.
 *
 * Va en un componente de cliente y no en el layout del servidor porque
 * `navigator` no existe allí. Se registra después de cargar, no durante: el
 * registro compite con las peticiones de la primera pantalla, y lo que el
 * usuario quiere ver primero son sus conversaciones.
 */
export function RegistrarPwa() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const registrar = (): void => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Que no haya service worker no rompe nada: el panel funciona igual
        // con red, que es el caso normal.
      });
    };
    if (document.readyState === "complete") registrar();
    else window.addEventListener("load", registrar, { once: true });
  }, []);
  return null;
}
