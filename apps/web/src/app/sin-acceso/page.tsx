import Link from "next/link";

/**
 * Lo que se ve al abrir algo que la sesión no alcanza.
 *
 * Antes un 403 mandaba a «entrar», y a quien solo tiene unos chats compartidos
 * eso le parecía que se le había cerrado la sesión: volvía a entrar para
 * chocar otra vez con lo mismo. Aquí se le dice lo que pasa y adónde ir.
 */
export const metadata = { title: "Sin acceso · Omni" };

export default function SinAcceso() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-2xl bg-(--color-hundido) text-(--color-tenue)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
             strokeLinecap="round" strokeLinejoin="round" className="size-7">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
      <h1 className="text-base font-semibold">No tienes acceso a esto</h1>
      <p className="max-w-sm text-sm text-(--color-tenue)">
        Tu sesión sigue abierta, pero lo que intentabas abrir no está entre lo
        que te han compartido. Si crees que deberías verlo, pídeselo a quien
        administra el equipo.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-(--color-acento) px-3.5 py-2 text-sm font-medium text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90"
      >
        Ir a mis conversaciones
      </Link>
    </main>
  );
}
