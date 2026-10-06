"use client";

import { useEffect, useRef } from "react";
import { IconoCampanaTachada } from "./iconos";

/**
 * Durante cuánto se silencia una conversación.
 *
 * Las tres de WhatsApp y en su orden. No es un capricho de paridad: silenciar
 * «para siempre» un grupo que hoy está insoportable es lo que luego hace que
 * alguien se pierda un aviso dentro de un mes, y por eso lo corto va primero.
 *
 * Sale como diálogo y no como submenú porque el menú de la conversación se
 * abre también con el dedo, y un submenú que se despliega al pasar por encima
 * no existe en un teléfono.
 */

const OPCIONES = [
  { texto: "8 horas", ms: 8 * 3600 * 1000 },
  { texto: "1 semana", ms: 7 * 24 * 3600 * 1000 },
  // Un año, no «para siempre»: WhatsApp guarda un instante, no un infinito.
  { texto: "Siempre", ms: 365 * 24 * 3600 * 1000 },
] as const;

export function Silenciar({
  nombre, onElegir, onCerrar,
}: {
  nombre: string;
  onElegir: (hasta: Date) => void | Promise<void>;
  onCerrar: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("keydown", tecla);
    // El foco entra en el diálogo: con el teclado, si no, se sigue navegando
    // por la lista de detrás sin saber que hay algo abierto delante.
    caja.current?.querySelector("button")?.focus();
    return () => document.removeEventListener("keydown", tecla);
  }, [onCerrar]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}
    >
      <div
        ref={caja}
        role="dialog"
        aria-modal="true"
        aria-label={`Silenciar ${nombre}`}
        className="w-full max-w-xs overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-2">
          <IconoCampanaTachada className="mt-0.5 size-5 shrink-0 text-(--color-tenue)" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Silenciar {nombre}</h2>
            <p className="mt-0.5 text-xs text-(--color-tenue)">
              Deja de sonar aquí y en tu teléfono. Los mensajes siguen llegando.
            </p>
          </div>
        </div>

        <ul className="py-1">
          {OPCIONES.map((o) => (
            <li key={o.texto}>
              <button
                type="button"
                onClick={() => {
                  onCerrar();
                  void onElegir(new Date(Date.now() + o.ms));
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-(--color-hundido)"
              >
                {o.texto}
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-(--color-borde-sutil) px-2 py-2 text-right">
          <button
            type="button"
            onClick={onCerrar}
            className="rounded-lg px-3 py-1.5 text-sm text-(--color-tenue) hover:bg-(--color-hundido)"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
