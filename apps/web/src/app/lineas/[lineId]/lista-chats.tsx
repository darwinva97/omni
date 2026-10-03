"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Chat } from "@/lib/api";
import { useEventos } from "@/lib/eventos";

/**
 * La lista de conversaciones, viva.
 *
 * Antes era estática y había que recargar para ver que alguien había escrito,
 * que es justo lo que un panel de mensajería no debe obligar a hacer. Ahora
 * escucha el mismo WebSocket que la conversación.
 *
 * Un mensaje de un chat DESCONOCIDO no se puede pintar con lo que trae el
 * evento: el nombre hay que resolverlo, y eso vive en el servidor. Así que se
 * pide esa conversación concreta —una sola, no la lista entera— y se inserta.
 */
export function ListaChats({ lineId, iniciales }: { lineId: string; iniciales: Chat[] }) {
  const [chats, setChats] = useState<Chat[]>(iniciales);
  const { conectado, suscribir } = useEventos(lineId);

  useEffect(() => suscribir(async (evento, data) => {
    if (!evento.startsWith("message.") && !evento.startsWith("chat.")) return;

    const key = (data["key"] ?? {}) as { remoteJid?: string; fromMe?: boolean };
    const direccion = key.remoteJid ?? (data["chat"] as string | undefined);
    if (!direccion) return;

    const cuando = new Date(Number(data["timestamp"] ?? Date.now())).toISOString();
    const conocido = chats.some((c) => c.address === direccion);

    if (!conocido) {
      // Se pide solo esa: traer la lista entera por cada mensaje de un chat
      // nuevo multiplicaría el trabajo justo cuando llega una ráfaga.
      const r = await fetch(
        `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(direccion)}`,
      );
      if (!r.ok) return;
      const { data: nuevo } = (await r.json()) as { data: Chat };
      setChats((prev) =>
        prev.some((c) => c.address === nuevo.address) ? prev : [nuevo, ...prev]);
      return;
    }

    setChats((prev) => {
      const movida = prev.map((c) =>
        c.address === direccion
          ? {
              ...c,
              lastMessageAt: cuando,
              unreadCount: evento === "message.received" && !key.fromMe
                ? c.unreadCount + 1
                : evento === "chat.read"
                  ? 0
                  : c.unreadCount,
            }
          : c);
      // La que acaba de recibir sube arriba, como en cualquier mensajería.
      return [...movida].sort((a, b) =>
        (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    });
  }), [lineId, chats, suscribir]);

  if (chats.length === 0) {
    return (
      <p className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-4 py-6 text-center text-sm text-(--color-tenue)">
        Sin conversaciones todavía.
      </p>
    );
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-2 text-xs text-(--color-tenue)">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${conectado ? "bg-green-500" : "bg-(--color-tenue)"}`}
        />
        {conectado ? "en vivo" : "reconectando…"}
      </div>
      <ul className="divide-y divide-(--color-borde) overflow-hidden rounded-lg border border-(--color-borde) bg-(--color-panel)">
        {chats.map((c) => (
          <li key={c.address}>
            <Link
              href={`/lineas/${lineId}/chats/${encodeURIComponent(c.address)}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-(--color-ajeno)"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.displayName}</span>
                <span className="block truncate text-xs text-(--color-tenue)">
                  {c.kind === "group" ? "grupo" : "contacto"}
                  {/* La dirección, como detalle: es lo que hace falta para la
                      API, pero no es con lo que uno reconoce a nadie. */}
                  {` · ${c.phone ? `+${c.phone.split("@")[0]}` : c.address}`}
                  {c.lastMessageAt && ` · ${new Date(c.lastMessageAt).toLocaleString("es")}`}
                </span>
              </span>
              {c.unreadCount > 0 && (
                <span className="rounded-full bg-(--color-acento) px-2 py-0.5 text-xs text-white">
                  {c.unreadCount}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
