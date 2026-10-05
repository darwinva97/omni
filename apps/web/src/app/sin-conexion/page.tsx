/**
 * Lo que se ve sin conexión.
 *
 * Dice lo que pasa y lo que NO se puede hacer, en vez de enseñar mensajes
 * viejos de una caché: creerlos actuales lleva a responder a algo que ya tiene
 * respuesta, y eso es peor que no ver nada.
 */
export const metadata = { title: "Sin conexión · Omni" };

export default function SinConexion() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-2xl bg-(--color-hundido) text-(--color-tenue)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
             strokeLinecap="round" className="size-7">
          <path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L8 9H5a1 1 0 0 0-1 1Z" />
          <path d="m17 10 4 4m0-4-4 4" />
        </svg>
      </span>
      <h1 className="text-base font-semibold">Sin conexión</h1>
      <p className="max-w-sm text-sm text-(--color-tenue)">
        No se guarda copia de las conversaciones a propósito: enseñarte mensajes
        viejos como si fueran los de ahora sería peor que no enseñarte nada.
        Vuelve a intentarlo cuando tengas red.
      </p>
    </main>
  );
}
