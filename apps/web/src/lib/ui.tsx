import Link from "next/link";

export function Cabecera({
  titulo, detalle, volver,
}: {
  titulo: string;
  /** La dirección y el teléfono: hacen falta, pero no identifican a nadie. */
  detalle?: string;
  volver?: { href: string; texto: string };
}) {
  return (
    <header className="border-b border-(--color-borde) bg-(--color-panel)">
      <div className="mx-auto flex max-w-5xl items-baseline gap-4 px-5 py-4">
        <Link href="/" className="text-sm font-semibold tracking-tight">omni</Link>
        {volver && (
          <Link href={volver.href} className="text-sm text-(--color-acento) hover:underline">
            ← {volver.texto}
          </Link>
        )}
        <div className="ml-auto min-w-0 text-right">
          <h1 className="truncate text-sm">{titulo}</h1>
          {detalle && (
            <p className="truncate text-[11px] text-(--color-tenue)">{detalle}</p>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Píldora de estado.
 *
 * El color acompaña, pero el TEXTO lleva el significado: quien no distingue
 * rojo de verde tiene que poder leer el estado igual.
 */
export function Estado({ estado }: { estado: string }) {
  const tono: Record<string, string> = {
    connected: "bg-(--color-propio) text-(--color-texto)",
    "awaiting-link": "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    "logged-out": "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  };
  const etiqueta: Record<string, string> = {
    connected: "conectada",
    connecting: "conectando",
    "awaiting-link": "esperando enlace",
    disconnected: "desconectada",
    "logged-out": "desvinculada",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${tono[estado] ?? "bg-(--color-ajeno) text-(--color-tenue)"}`}>
      {etiqueta[estado] ?? estado}
    </span>
  );
}

export function Vacio({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-(--color-borde) px-4 py-8 text-center text-sm text-(--color-tenue)">
      {children}
    </p>
  );
}

export function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {children}
    </div>
  );
}
