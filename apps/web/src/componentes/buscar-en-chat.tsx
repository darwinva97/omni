"use client";

import { useEffect, useRef, useState } from "react";
import { IconoBuscar, IconoCerrar } from "./iconos";
import { diaDeSeparador, hora } from "@/lib/formato";
import { fragmentoConCoincidencia } from "@/lib/buscar";

export interface Resultado {
  id: string;
  providerMessageId: string | null;
  timestamp: string;
  fromMe: boolean;
  senderName: string | null;
  kind: string;
  texto: string;
}

/**
 * Buscar mensajes en la conversación abierta, como el panel de WhatsApp.
 *
 * Busca en el servidor y no en lo cargado: el hilo trae los últimos cien, y
 * lo que se busca casi nunca está ahí —si estuviera, se vería—. Elegir un
 * resultado salta a él aunque sea de hace meses.
 */
export function BuscarEnChat({
  lineId, chat, esGrupo, onElegir, onCerrar,
}: {
  lineId: string;
  chat: string;
  esGrupo: boolean;
  onElegir: (r: Resultado) => void;
  onCerrar: () => void;
}) {
  const [q, setQ] = useState("");
  const [resultados, setResultados] = useState<Resultado[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [elegido, setElegido] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => { campo.current?.focus(); }, []);
  // Con el campo vacío no hay resultados que enseñar, aunque quedaran los de
  // la búsqueda anterior.
  const mostrar = q.trim() ? resultados : null;

  useEffect(() => {
    const limpio = q.trim();
    // Sin texto no se busca; lo que se enseña lo decide `mostrar`, abajo.
    if (!limpio) return;
    /*
     * Se espera a que se deje de teclear un momento. Una petición por letra
     * contesta a búsquedas que ya nadie quiere, y la última respuesta en
     * llegar no siempre es la de la última letra.
     */
    const control = new AbortController();
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await fetch(
          `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/search`
          + `?q=${encodeURIComponent(limpio)}`,
          { signal: control.signal },
        );
        if (!r.ok) { setResultados([]); return; }
        const { data } = (await r.json()) as { data: Resultado[] };
        setResultados(data);
      } catch {
        // Cancelada porque se siguió escribiendo: la siguiente contestará.
      } finally {
        if (!control.signal.aborted) setBuscando(false);
      }
    }, 250);
    return () => { clearTimeout(t); control.abort(); };
  }, [q, lineId, chat]);

  return (
    <aside
      aria-label="Buscar mensajes"
      className="absolute inset-0 z-20 flex flex-col border-l border-(--color-borde) bg-(--color-panel) md:static md:w-[22rem] md:shrink-0"
    >
      <header className="flex items-center gap-2 border-b border-(--color-borde) px-3 py-2.5">
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar la búsqueda"
          className="flex size-9 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
        >
          <IconoCerrar className="size-5" />
        </button>
        <h2 className="text-sm font-semibold">Buscar mensajes</h2>
      </header>

      <div className="border-b border-(--color-borde) px-3 py-2.5">
        <div className="relative">
          <IconoBuscar className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-(--color-apagado)" />
          <input
            ref={campo}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onCerrar(); }}
            placeholder="Buscar…"
            aria-label="Buscar en esta conversación"
            className="w-full rounded-lg bg-(--color-hundido) py-2 pr-3 pl-8.5 text-sm outline-none placeholder:text-(--color-apagado) focus:bg-(--color-panel) focus:ring-2 focus:ring-(--color-acento)"
          />
        </div>
      </div>

      <div className="scroll-discreto flex-1 overflow-y-auto" aria-live="polite">
        {mostrar === null ? (
          <p className="px-5 py-10 text-center text-sm text-(--color-tenue)">
            Busca palabras de esta conversación. Da igual las tildes y las mayúsculas.
          </p>
        ) : mostrar.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-(--color-tenue)">
            {buscando ? "Buscando…" : `Ningún mensaje con «${q.trim()}».`}
          </p>
        ) : (
          <ul>
            {mostrar.map((r) => {
              const quien = r.fromMe ? "Tú" : esGrupo ? r.senderName : null;
              const trozo = fragmentoConCoincidencia(r.texto, q.trim());
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => { setElegido(r.id); onElegir(r); }}
                    aria-current={elegido === r.id ? "true" : undefined}
                    className={`block w-full border-b border-(--color-borde-sutil) px-4 py-2.5 text-left transition-colors duration-100 ${
                      elegido === r.id ? "bg-(--color-acento-tenue)" : "hover:bg-(--color-hundido)"
                    }`}
                  >
                    <span className="block text-[11px] text-(--color-apagado)">
                      {diaDeSeparador(r.timestamp)} · {hora(r.timestamp)}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-sm wrap-anywhere">
                      {quien && <span className="text-(--color-tenue)">{quien}: </span>}
                      {trozo.antes}
                      <mark className="rounded-sm bg-(--color-acento-tenue) px-0.5 font-semibold text-(--color-acento-fuerte)">
                        {trozo.coincide}
                      </mark>
                      {trozo.despues}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
