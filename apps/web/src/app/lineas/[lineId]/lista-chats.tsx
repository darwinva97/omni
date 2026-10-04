"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Chat, Linea } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { cuando, resumen } from "@/lib/formato";
import { Avatar } from "@/componentes/piezas";
import { IconoBuscar, IconoCerrar } from "@/componentes/iconos";

/**
 * La columna de conversaciones.
 *
 * Tres cosas la hacen útil y las tres son decisiones, no adornos:
 *
 * 1. **Viva.** Escucha el mismo socket que el hilo abierto. Recargar para ver
 *    si alguien ha contestado es lo que un panel de mensajería no debe pedir.
 * 2. **Ordenada por lo último.** Lo que acaba de llegar sube. Es la única
 *    ordenación que sirve cuando hay sesenta conversaciones.
 * 3. **Buscable sin ir al servidor.** Con doscientas cargadas, filtrar en el
 *    navegador es instantáneo; pedirlo al servidor añade un viaje por letra
 *    para un resultado idéntico.
 */
export function ListaChats({ linea, iniciales }: { linea: Linea; iniciales: Chat[] }) {
  const [chats, setChats] = useState<Chat[]>(iniciales);
  const [busqueda, setBusqueda] = useState("");
  const { conectado, suscribir } = useEventos(linea.id);
  const params = useParams<{ chatId?: string }>();
  const abierto = params.chatId ? decodeURIComponent(params.chatId) : null;

  useEffect(() => suscribir(async (evento, data) => {
    if (!evento.startsWith("message.") && !evento.startsWith("chat.")) return;

    const key = (data["key"] ?? {}) as { remoteJid?: string; fromMe?: boolean };
    const direccion = key.remoteJid ?? (data["chat"] as string | undefined);
    if (!direccion) return;

    const cuandoISO = new Date(Number(data["timestamp"] ?? Date.now())).toISOString();
    const texto = (data["text"] as string | null) ?? null;
    const tipo = String(data["kind"] ?? "text");

    setChats((prev) => {
      const i = prev.findIndex((c) => c.address === direccion);
      if (i < 0) return prev;
      const actual = prev[i]!;
      const copia = [...prev];
      copia[i] = {
        ...actual,
        lastMessageAt: cuandoISO,
        ultimo: resumen(tipo, texto),
        ultimoPropio: key.fromMe === true,
        // Lo que se está mirando no acumula pendientes: el contador existiría
        // para avisar de algo que ya se tiene delante.
        unreadCount:
          evento === "message.received" && !key.fromMe && direccion !== abierto
            ? actual.unreadCount + 1
            : evento === "chat.read" || direccion === abierto
              ? 0
              : actual.unreadCount,
      };
      return copia.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    });

    // Una conversación que no estaba en la lista no se puede pintar con lo que
    // trae el evento: el nombre hay que resolverlo, y eso vive en el servidor.
    if (!chats.some((c) => c.address === direccion)) {
      const r = await fetch(`/api/omni/v1/lines/${linea.id}/chats/${encodeURIComponent(direccion)}`);
      if (!r.ok) return;
      const { data: nuevo } = (await r.json()) as { data: Chat };
      setChats((prev) =>
        prev.some((c) => c.address === nuevo.address) ? prev : [nuevo, ...prev]);
    }
  }), [linea.id, chats, suscribir, abierto]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) =>
      c.displayName.toLowerCase().includes(q)
      || c.address.toLowerCase().includes(q)
      || (c.phone ?? "").includes(q));
  }, [chats, busqueda]);

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-r border-(--color-borde) bg-(--color-panel)">
      <header className="border-b border-(--color-borde) px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{linea.name}</h1>
            <p className="truncate text-xs text-(--color-tenue)">
              {linea.address ? `+${linea.address.split("@")[0]}` : linea.channelKind}
            </p>
          </div>
          <span
            title={conectado ? "Recibiendo en vivo" : "Reconectando"}
            className="flex items-center gap-1.5 text-xs text-(--color-tenue)"
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                conectado ? "bg-(--color-exito)" : "bg-(--color-apagado)"
              }`}
            />
            {conectado ? "en vivo" : "…"}
          </span>
        </div>

        <div className="relative mt-3">
          <IconoBuscar className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-(--color-apagado)" />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar conversación"
            aria-label="Buscar conversación"
            className="w-full rounded-lg bg-(--color-hundido) py-2 pr-8 pl-8.5 text-sm outline-none placeholder:text-(--color-apagado) focus:bg-(--color-panel) focus:ring-2 focus:ring-(--color-acento)"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda("")}
              aria-label="Limpiar búsqueda"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-(--color-apagado) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          )}
        </div>
      </header>

      <div className="scroll-discreto flex-1 overflow-y-auto">
        {visibles.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-(--color-tenue)">
            {busqueda ? `Nada que coincida con «${busqueda}»` : "Sin conversaciones todavía."}
          </p>
        ) : (
          <ul>
            {visibles.map((c) => {
              const activo = c.address === abierto;
              return (
                <li key={c.address}>
                  <Link
                    href={`/lineas/${linea.id}/chats/${encodeURIComponent(c.address)}`}
                    aria-current={activo ? "page" : undefined}
                    className={`flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 ${
                      activo ? "bg-(--color-acento-tenue)" : "hover:bg-(--color-hundido)"
                    }`}
                  >
                    <Avatar nombre={c.displayName} direccion={c.address} kind={c.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{c.displayName}</span>
                        <span
                          className={`shrink-0 text-[11px] ${
                            c.unreadCount > 0
                              ? "font-semibold text-(--color-acento-fuerte)"
                              : "text-(--color-apagado)"
                          }`}
                        >
                          {cuando(c.lastMessageAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-(--color-tenue)">
                          {c.ultimo
                            ? `${c.ultimoPropio ? "Tú: " : ""}${c.ultimo}`
                            : c.phone
                              ? `+${c.phone.split("@")[0]}`
                              : c.address}
                        </span>
                        {c.unreadCount > 0 && (
                          <span className="flex min-w-5 shrink-0 justify-center rounded-full bg-(--color-acento) px-1.5 text-[11px] leading-5 font-semibold text-(--color-sobre-acento)">
                            {c.unreadCount > 99 ? "99+" : c.unreadCount}
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
