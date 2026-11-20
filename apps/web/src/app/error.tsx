"use client";

import { useEffect } from "react";

/**
 * Lo que se ve cuando una página no se pudo montar.
 *
 * Casi siempre es la API reiniciándose —un despliegue dura un minuto o dos y
 * mientras tanto no hay a quién preguntar—, así que en vez de la página de
 * error en blanco se dice eso y se vuelve a intentar sola: quien la tenga
 * abierta ve aparecer sus líneas en cuanto la API vuelve, sin tocar nada.
 */
export default function ErrorDePagina({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    const t = setInterval(() => retry(), 5000);
    return () => clearInterval(t);
  }, [retry]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-2xl bg-(--color-hundido) text-(--color-tenue)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
             strokeLinecap="round" className="size-7 animate-spin [animation-duration:2s]">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
      </span>
      <h1 className="text-base font-semibold">Reconectando con Omni…</h1>
      <p className="max-w-sm text-sm text-(--color-tenue)">
        El servidor no responde ahora mismo; suele ser un reinicio que dura un
        minuto. Esta página se recarga sola en cuanto vuelva.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-lg border border-(--color-borde) px-3.5 py-2 text-sm font-medium transition-colors duration-150 hover:bg-(--color-hundido)"
      >
        Reintentar ahora
      </button>
    </main>
  );
}
