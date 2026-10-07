"use client";

import { useEffect, useRef, useState } from "react";
import type { Lista } from "@/lib/api";
import { IconoCerrar } from "./iconos";

/**
 * Listas de Omni: pestañas propias para agrupar conversaciones.
 *
 * Son nuestras y no de WhatsApp —no se ven en el teléfono— y eso se dice en el
 * propio diálogo. Quien las crea tiene que saber que «Clientes» existe aquí y
 * no en su móvil, o la buscará allí.
 */

/** El color de cada lista, del juego corto que admite la API. */
export const COLOR_DE_LISTA: Record<string, string> = {
  gris: "oklch(0.6 0.01 240)",
  rojo: "oklch(0.6 0.17 25)",
  "ámbar": "oklch(0.72 0.14 75)",
  verde: "oklch(0.62 0.13 150)",
  azul: "oklch(0.6 0.13 245)",
  violeta: "oklch(0.58 0.15 300)",
};

const COLORES = Object.keys(COLOR_DE_LISTA);

function Dialogo({
  titulo, onCerrar, children,
}: {
  titulo: string;
  onCerrar: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onCerrar]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="w-full max-w-sm overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-1">
          <h2 className="truncate text-sm font-semibold">{titulo}</h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="flex size-7 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido)"
          >
            <IconoCerrar className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** El selector de color: seis puntos, el elegido con anillo. */
function Colores({ valor, onCambiar }: { valor: string; onCambiar: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex gap-2">
      {COLORES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={valor === c}
          aria-label={c}
          title={c}
          onClick={() => onCambiar(c)}
          className={`size-6 rounded-full transition-transform duration-100 ${
            valor === c
              ? "ring-2 ring-(--color-texto) ring-offset-2 ring-offset-(--color-panel)"
              : "hover:scale-110"
          }`}
          style={{ background: COLOR_DE_LISTA[c] }}
        />
      ))}
    </div>
  );
}

/**
 * Crear o editar una lista.
 *
 * El mismo diálogo para las dos cosas: lo que se puede cambiar de una lista es
 * exactamente lo que se elige al crearla.
 */
export function EditarLista({
  lista, onGuardar, onCerrar,
}: {
  /** `null` para crear una nueva. */
  lista: Lista | null;
  onGuardar: (datos: { name: string; color: string }) => Promise<string | null>;
  onCerrar: () => void;
}) {
  const [nombre, setNombre] = useState(lista?.name ?? "");
  const [color, setColor] = useState(lista?.color ?? "azul");
  const [problema, setProblema] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  useEffect(() => { campo.current?.focus(); }, []);

  return (
    <Dialogo titulo={lista ? "Editar lista" : "Nueva lista"} onCerrar={onCerrar}>
      <form
        className="space-y-3 px-4 pt-2 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const limpio = nombre.trim();
          if (!limpio) return;
          setGuardando(true);
          // El error vuelve del servidor y se ENSEÑA: el caso típico es un
          // nombre repetido, y cerrar el diálogo sin decirlo parecería que se
          // guardó.
          const error = await onGuardar({ name: limpio, color });
          setGuardando(false);
          if (error) setProblema(error);
          else onCerrar();
        }}
      >
        <label className="block">
          <span className="text-xs text-(--color-tenue)">Nombre</span>
          <input
            ref={campo}
            value={nombre}
            onChange={(e) => { setNombre(e.target.value); setProblema(null); }}
            maxLength={60}
            placeholder="Clientes, Trabajo, Familia…"
            className="mt-1 w-full rounded-lg bg-(--color-hundido) px-3 py-2 text-sm outline-none placeholder:text-(--color-apagado) focus:ring-2 focus:ring-(--color-acento)"
          />
        </label>

        <div>
          <span className="text-xs text-(--color-tenue)">Color</span>
          <div className="mt-1.5"><Colores valor={color} onCambiar={setColor} /></div>
        </div>

        {problema && <p role="alert" className="text-xs text-(--color-error)">{problema}</p>}

        <p className="text-xs text-(--color-apagado)">
          Las listas son de Omni: agrupan conversaciones aquí y no aparecen en
          tu WhatsApp.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCerrar}
            className="rounded-lg px-3 py-1.5 text-sm text-(--color-tenue) hover:bg-(--color-hundido)"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={guardando || !nombre.trim()}
            className="rounded-lg bg-(--color-acento) px-3 py-1.5 text-sm font-medium text-(--color-sobre-acento) disabled:opacity-40"
          >
            {lista ? "Guardar" : "Crear"}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}

/**
 * En qué listas está una conversación.
 *
 * Casillas y no un menú de una sola opción: una conversación puede estar en
 * «Clientes» y en «Urgente» a la vez, y obligar a elegir una es lo que hace
 * que la gente deje de usar las listas.
 */
export function ListasDeChat({
  nombre, listas, actuales, onGuardar, onNueva, onCerrar,
}: {
  nombre: string;
  listas: readonly Lista[];
  actuales: readonly string[];
  onGuardar: (ids: string[]) => Promise<void>;
  onNueva: () => void;
  onCerrar: () => void;
}) {
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set(actuales));
  const [guardando, setGuardando] = useState(false);

  return (
    <Dialogo titulo={`Listas de ${nombre}`} onCerrar={onCerrar}>
      <div className="px-2 pt-1 pb-2">
        {listas.length === 0 ? (
          <p className="px-2 py-3 text-sm text-(--color-tenue)">
            Todavía no hay listas. Crea una para agrupar conversaciones en su
            propia pestaña.
          </p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {listas.map((l) => (
              <li key={l.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-(--color-hundido)">
                  <input
                    type="checkbox"
                    checked={marcadas.has(l.id)}
                    onChange={(e) => {
                      const siguiente = new Set(marcadas);
                      if (e.target.checked) siguiente.add(l.id);
                      else siguiente.delete(l.id);
                      setMarcadas(siguiente);
                    }}
                    className="size-4 accent-(--color-acento)"
                  />
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: COLOR_DE_LISTA[l.color ?? "gris"] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{l.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={onNueva}
          className="mt-1 w-full rounded-lg px-2 py-2 text-left text-sm text-(--color-acento-fuerte) hover:bg-(--color-hundido)"
        >
          + Nueva lista
        </button>
      </div>

      <div className="flex justify-end gap-2 border-t border-(--color-borde-sutil) px-4 py-2.5">
        <button
          type="button"
          onClick={onCerrar}
          className="rounded-lg px-3 py-1.5 text-sm text-(--color-tenue) hover:bg-(--color-hundido)"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={guardando}
          onClick={async () => {
            setGuardando(true);
            await onGuardar([...marcadas]);
            setGuardando(false);
            onCerrar();
          }}
          className="rounded-lg bg-(--color-acento) px-3 py-1.5 text-sm font-medium text-(--color-sobre-acento) disabled:opacity-40"
        >
          Guardar
        </button>
      </div>
    </Dialogo>
  );
}
