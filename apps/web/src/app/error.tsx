"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Lo que se ve cuando algo falla al cargar una página, en vez del «This page couldn't load»
 * de Next en inglés y sin salida. Dice qué pasó en palabras normales, deja reintentar y volver
 * a las líneas. El detalle técnico va a la consola del servidor; aquí sólo el código para
 * poder buscarlo (`digest`).
 */
export default function ErrorDePagina({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="flex h-full min-h-[60dvh] items-center justify-center bg-(--color-lienzo) px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-(--color-borde) bg-(--color-panel) p-6 text-center">
        <p className="text-base font-semibold">No se pudo cargar esta pantalla</p>
        <p className="mt-2 text-sm text-(--color-tenue)">
          Puede ser un corte momentáneo o algo que no se pudo guardar. Vuelve a intentarlo; si se
          repite, vuelve a tus líneas y entra otra vez.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-(--color-acento) px-4 py-2 text-sm font-medium text-(--color-sobre-acento) hover:opacity-90"
          >
            Reintentar
          </button>
          <Link href="/" className="rounded-lg border border-(--color-borde) px-4 py-2 text-sm font-medium hover:bg-(--color-hundido)">
            Ir a mis líneas
          </Link>
        </div>
        {error.digest && <p className="mt-4 text-[11px] text-(--color-apagado)">Código: {error.digest}</p>}
      </div>
    </div>
  );
}
