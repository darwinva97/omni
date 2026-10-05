"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Menú contextual.
 *
 * Dos formas de abrirlo, y las dos hacen falta: el botón de tres puntos, que
 * se ve, y el clic derecho, que es lo que la gente hace por costumbre. Solo
 * con el clic derecho nadie lo encontraría; solo con el botón, quien viene de
 * WhatsApp probaría el derecho y no pasaría nada.
 *
 * Va en `fixed` y en el nivel más alto a propósito: dentro de la lista de
 * conversaciones, que tiene `overflow-y-auto`, un menú posicionado dentro se
 * recorta justo cuando se abre en la última fila.
 */

export interface OpcionMenu {
  texto: string;
  onSelect: () => void | Promise<void>;
  /** Pinta la opción como destructiva y la separa del resto. */
  peligro?: boolean;
  Icono?: (p: { className?: string }) => React.ReactElement;
}

export function useMenu() {
  const [punto, setPunto] = useState<{ x: number; y: number } | null>(null);
  return {
    punto,
    abierto: punto !== null,
    cerrar: () => setPunto(null),
    /** Para el clic derecho: abre donde está el puntero. */
    enContexto: (e: React.MouseEvent) => {
      e.preventDefault();
      setPunto({ x: e.clientX, y: e.clientY });
    },
    /** Para un botón: abre pegado a él. */
    enBoton: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      setPunto({ x: r.right, y: r.bottom + 4 });
    },
  };
}

export function Menu({
  punto, opciones, onCerrar,
}: {
  punto: { x: number; y: number } | null;
  opciones: readonly OpcionMenu[];
  onCerrar: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [ajuste, setAjuste] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!punto) { setAjuste(null); return; }
    const el = caja.current;
    if (!el) return;
    // Se mide DESPUÉS de pintar y se corrige: abierto cerca del borde
    // derecho o del pie, un menú de ancho fijo se sale de la pantalla.
    const r = el.getBoundingClientRect();
    setAjuste({
      left: Math.min(punto.x, window.innerWidth - r.width - 8),
      top: Math.min(punto.y, window.innerHeight - r.height - 8),
    });
  }, [punto]);

  useEffect(() => {
    if (!punto) return;
    const fuera = (e: MouseEvent): void => {
      if (!caja.current?.contains(e.target as Node)) onCerrar();
    };
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    // `capture` para enterarse antes de que el clic llegue a la fila de debajo
    // y la abra, que es lo que pasaría al elegir «cerrar» pulsando fuera.
    document.addEventListener("mousedown", fuera, true);
    document.addEventListener("keydown", tecla);
    // Al desplazar, el menú dejaría de apuntar a lo que se eligió.
    window.addEventListener("scroll", onCerrar, true);
    return () => {
      document.removeEventListener("mousedown", fuera, true);
      document.removeEventListener("keydown", tecla);
      window.removeEventListener("scroll", onCerrar, true);
    };
  }, [punto, onCerrar]);

  if (!punto) return null;

  return (
    <div
      ref={caja}
      role="menu"
      className="fixed z-50 min-w-48 overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) py-1 shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
      style={{
        left: ajuste?.left ?? punto.x,
        top: ajuste?.top ?? punto.y,
        // Invisible hasta medir: así no se ve saltar de sitio.
        visibility: ajuste ? "visible" : "hidden",
      }}
    >
      {opciones.map((o, i) => {
        const anterior = opciones[i - 1];
        return (
          <div key={o.texto}>
            {o.peligro && anterior && !anterior.peligro && (
              <hr className="my-1 border-(--color-borde-sutil)" />
            )}
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                onCerrar();
                await o.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                o.peligro
                  ? "text-(--color-error) hover:bg-(--color-error-tenue)"
                  : "hover:bg-(--color-hundido)"
              }`}
            >
              {o.Icono && <o.Icono className="size-4 shrink-0 opacity-70" />}
              {o.texto}
            </button>
          </div>
        );
      })}
    </div>
  );
}
