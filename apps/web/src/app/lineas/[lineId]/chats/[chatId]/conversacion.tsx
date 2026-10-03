"use client";

import { useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import type { Medio as TipoMedio, Mensaje } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { Medio } from "@/componentes/medio";

/**
 * La conversación, con los mensajes que llegan en vivo.
 *
 * El histórico lo trae el servidor; a partir de ahí, el WebSocket. Recargar la
 * página para ver si alguien ha contestado es exactamente lo que un panel de
 * mensajería no debe obligar a hacer.
 */
/** Los tipos que se pintan como fichero y no como texto. */
const MEDIOS = new Set(["image", "sticker", "video", "audio", "document"]);

export function Conversacion({
  lineId,
  chat,
  iniciales,
  enviar,
}: {
  lineId: string;
  chat: string;
  iniciales: Mensaje[];
  enviar: (texto: string) => Promise<Mensaje | null>;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>(iniciales);
  // Un solo socket por página, compartido con la lista de conversaciones.
  const { conectado, suscribir } = useEventos(lineId);
  const fondo = useRef<HTMLDivElement>(null);
  const formulario = useRef<HTMLFormElement>(null);

  // Lo enviado aparece al instante y se marca como "enviando": esperar al
  // servidor para pintar lo que el usuario acaba de escribir se siente roto.
  const [conPendientes, añadirPendiente] = useOptimistic(
    mensajes,
    (actuales: Mensaje[], texto: string) => [
      ...actuales,
      {
        id: `pendiente-${texto}`, providerMessageId: null, fromMe: true,
        kind: "text", body: texto, state: "enviando",
        timestamp: new Date().toISOString(),
      },
    ],
  );

  useEffect(() => suscribir((evento, data) => {
    if (!evento.startsWith("message.")) return;

    const key = (data["key"] ?? {}) as { id?: string; remoteJid?: string; fromMe?: boolean };

    /*
     * Los acuses se aplican por IDENTIFICADOR, sin mirar la conversación.
     *
     * WhatsApp puede reportar el chat de un acuse con otra forma de la misma
     * dirección —teléfono donde nosotros tenemos un LID—, y filtrar por chat
     * hacía que el estado de un mensaje propio no se actualizara nunca.
     */
    if (evento === "message.receipt") {
      const estado = String(data["state"] ?? "");
      setMensajes((prev) =>
        prev.map((x) => (x.providerMessageId === key.id ? { ...x, state: estado } : x)));
      return;
    }

    /*
     * El fichero de un medio llega DESPUÉS del mensaje: la descarga va en una
     * cola, así que el mensaje ya se pintó con un hueco. Este aviso lo rellena
     * sin recargar.
     */
    if (evento === "message.updated") {
      const medio = data["media"] as TipoMedio | undefined;
      if (!medio) return;
      setMensajes((prev) =>
        prev.map((x) =>
          x.providerMessageId === key.id ? { ...x, media: medio, mediaError: null } : x));
      return;
    }

    // `upsert` duplica lo que ya llegó por `received`/`sent`: se ignora.
    if (evento === "message.upsert") return;
    if (key.remoteJid !== chat) return;

    setMensajes((prev) => {
      if (key.id && prev.some((x) => x.providerMessageId === key.id)) return prev;

      /*
       * Un mensaje PROPIO que vuelve por el socket es el eco del que ya
       * fijamos al enviarlo: no se añade otra vez, se le pone el
       * identificador del proveedor, que es lo que falta para que los acuses
       * lo encuentren.
       */
      if (key.fromMe) {
        const texto = (data["text"] as string | null) ?? null;
        const i = prev.findLastIndex((x) => x.fromMe && !x.providerMessageId && x.body === texto);
        if (i >= 0) {
          const copia = [...prev];
          copia[i] = { ...copia[i]!, providerMessageId: key.id ?? null, state: "sent" };
          return copia;
        }
      }

      return [...prev, {
        id: key.id ?? crypto.randomUUID(),
        providerMessageId: key.id ?? null,
        fromMe: key.fromMe ?? false,
        kind: String(data["kind"] ?? "text"),
        body: (data["text"] as string | null) ?? null,
        state: key.fromMe ? "sent" : "delivered",
        timestamp: new Date(Number(data["timestamp"] ?? Date.now())).toISOString(),
      }];
    });
  }), [chat, suscribir]);

  useEffect(() => {
    fondo.current?.scrollIntoView({ behavior: "smooth" });
  }, [conPendientes.length]);

  return (
    <main className="mx-auto flex h-[calc(100dvh-57px)] max-w-3xl flex-col px-5">
      <div className="flex items-center gap-2 py-2 text-xs text-(--color-tenue)">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${conectado ? "bg-green-500" : "bg-(--color-tenue)"}`}
        />
        {conectado ? "en vivo" : "reconectando…"}
      </div>

      <ol className="flex-1 space-y-2 overflow-y-auto py-2">
        {conPendientes.map((m) => (
          <li key={m.id} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                m.fromMe ? "bg-(--color-propio)" : "bg-(--color-ajeno)"
              }`}
            >
              {MEDIOS.has(m.kind) ? (
                <div className="space-y-1">
                  <Medio kind={m.kind} medio={m.media} error={m.mediaError} />
                  {/* El pie, cuando lo trae: en WhatsApp una foto puede venir
                      con texto y perderlo sería perder la mitad del mensaje. */}
                  {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {m.body ?? <em className="text-(--color-tenue)">{m.kind}</em>}
                </p>
              )}
              <p className="mt-1 text-[10px] text-(--color-tenue)">
                {new Date(m.timestamp).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                {m.fromMe && ` · ${m.state}`}
              </p>
            </div>
          </li>
        ))}
        <div ref={fondo} />
      </ol>

      <form
        ref={formulario}
        action={async (formData) => {
          const texto = String(formData.get("texto") ?? "").trim();
          if (!texto) return;
          formulario.current?.reset();
          startTransition(() => añadirPendiente(texto));

          /*
           * Lo enviado se FIJA en el estado real con lo que devuelve el
           * servidor. El estado optimista se descarta en cuanto la acción
           * termina, así que sin esto el mensaje desaparecía de la pantalla y
           * parecía no haberse enviado. Esperar al eco del WebSocket tampoco
           * vale: puede tardar, y puede no llegar nunca si el transporte
           * reporta la dirección de otra forma.
           */
          const enviado = await enviar(texto);
          if (enviado) {
            setMensajes((prev) =>
              prev.some((x) => x.id === enviado.id) ? prev : [...prev, enviado]);
          }
        }}
        className="flex gap-2 border-t border-(--color-borde) py-3"
      >
        <input
          name="texto" autoComplete="off" placeholder="Escribe un mensaje…"
          className="flex-1 rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)"
        />
        <button className="rounded-lg bg-(--color-acento) px-4 py-2 text-sm text-white hover:opacity-90">
          Enviar
        </button>
      </form>
    </main>
  );
}
