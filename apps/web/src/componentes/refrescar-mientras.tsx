"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Vuelve a pedir la página al servidor cada pocos segundos mientras algo está a medias.
 *
 * La página de una línea se pinta en el servidor y no tiene a quién preguntar el estado: con el
 * QR a la vista, el teléfono enlazaba y la pantalla seguía enseñando el QR hasta recargar a mano
 * (y el QR, que caduca, tampoco se renovaba). Refrescar trae el estado y el QR nuevos; al quedar
 * conectada, la página ya no monta este componente y se deja de preguntar.
 */
export function RefrescarMientras({ cadaMs = 3000 }: { cadaMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, cadaMs);
    return () => clearInterval(t);
  }, [router, cadaMs]);
  return null;
}
