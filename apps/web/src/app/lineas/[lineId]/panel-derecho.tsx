"use client";

import { usePathname } from "next/navigation";

/**
 * La columna derecha, que en móvil solo aparece cuando hay algo abierto.
 *
 * La decisión depende de la RUTA y el layout del servidor no la conoce: él
 * solo sabe que tiene hijos, y siempre los tiene. Aquí sí, y `usePathname`
 * está disponible al renderizar en el servidor, así que el HTML sale ya
 * correcto y no hay un salto al hidratar.
 */
export function PanelDerecho({ lineId, children }: { lineId: string; children: React.ReactNode }) {
  const ruta = usePathname();
  const hayAlgoAbierto = ruta !== `/lineas/${lineId}`;

  return (
    <section
      className={`${
        hayAlgoAbierto ? "flex" : "hidden md:flex"
      } min-w-0 flex-1 flex-col`}
    >
      {children}
    </section>
  );
}
