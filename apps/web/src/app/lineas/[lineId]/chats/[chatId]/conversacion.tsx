"use client";

import { useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import type { Medio as TipoMedio, Mensaje } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { Medio } from "@/componentes/medio";
import {
  campoPara, ETIQUETAS, MAX_BYTES, tamanoLegible, type CampoDeMedio,
} from "@/lib/adjuntar";

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
  enviarMedio,
}: {
  lineId: string;
  chat: string;
  iniciales: Mensaje[];
  enviar: (texto: string) => Promise<Mensaje | null>;
  enviarMedio: (
    campo: string, storageKey: string, pie: string, fileName: string,
  ) => Promise<Mensaje | null>;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>(iniciales);
  // Un solo socket por página, compartido con la lista de conversaciones.
  const { conectado, suscribir } = useEventos(lineId);
  const fondo = useRef<HTMLDivElement>(null);
  const formulario = useRef<HTMLFormElement>(null);
  const selector = useRef<HTMLInputElement>(null);
  const [adjunto, setAdjunto] = useState<{ file: File; campo: CampoDeMedio } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);

  /**
   * Sube el fichero y pide el envío.
   *
   * Dos pasos a propósito: la subida devuelve una clave del almacén y el envío
   * la reutiliza, así que un reintento no vuelve a subir los bytes. El fichero
   * va por el intermediario del panel, que nunca entrega una clave de API al
   * navegador.
   */
  const mandarAdjunto = async (pie: string): Promise<void> => {
    if (!adjunto) return;
    setProblema(null);
    setSubiendo(true);
    try {
      const cuerpo = new FormData();
      cuerpo.append("file", adjunto.file);
      cuerpo.append("lineId", lineId);
      const r = await fetch("/api/omni/v1/media", { method: "POST", body: cuerpo });
      if (!r.ok) {
        const detalle = (await r.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(detalle?.detail ?? `la subida falló (${r.status})`);
      }
      const { data } = (await r.json()) as { data: { storageKey: string } };

      const enviado = await enviarMedio(
        adjunto.campo, data.storageKey, pie, adjunto.file.name,
      );
      if (enviado) {
        setMensajes((prev) =>
          prev.some((x) => x.id === enviado.id) ? prev : [...prev, enviado]);
      }
      setAdjunto(null);
      if (selector.current) selector.current.value = "";
    } catch (e) {
      // El error se ENSEÑA. Un adjunto que desaparece sin decir nada deja a
      // quien envía creyendo que se mandó.
      setProblema(e instanceof Error ? e.message : "no se pudo enviar el fichero");
    } finally {
      setSubiendo(false);
    }
  };

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

      {problema && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {problema}
        </p>
      )}

      {adjunto && (
        <div className="flex items-center gap-3 border-t border-(--color-borde) py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{adjunto.file.name}</p>
            <p className="text-xs text-(--color-tenue)">
              {tamanoLegible(adjunto.file.size)} · {adjunto.file.type || "tipo desconocido"}
            </p>
          </div>

          {/* Se puede cambiar el tipo: un WebP se adjunta como sticker por
              defecto, pero a veces se quiere mandar como foto. */}
          <select
            value={adjunto.campo}
            onChange={(e) => setAdjunto({ ...adjunto, campo: e.target.value as CampoDeMedio })}
            className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1 text-xs"
          >
            {(Object.keys(ETIQUETAS) as CampoDeMedio[]).map((k) => (
              <option key={k} value={k}>{ETIQUETAS[k]}</option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              setAdjunto(null);
              setProblema(null);
              if (selector.current) selector.current.value = "";
            }}
            className="text-xs text-(--color-tenue) hover:underline"
          >
            quitar
          </button>
        </div>
      )}

      <form
        ref={formulario}
        action={async (formData) => {
          const texto = String(formData.get("texto") ?? "").trim();

          // Con adjunto, el texto es el PIE de la foto, no otro mensaje: dos
          // mensajes separados no es lo que se pidió al escribir junto.
          if (adjunto) {
            formulario.current?.reset();
            await mandarAdjunto(texto);
            return;
          }

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
          ref={selector}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setProblema(null);
            if (file.size > MAX_BYTES) {
              // Se avisa ANTES de subir: mandar sesenta megas para que el otro
              // lado los rechace es el viaje entero perdido.
              setProblema(`${tamanoLegible(file.size)} es demasiado; el máximo es ${tamanoLegible(MAX_BYTES)}`);
              e.target.value = "";
              return;
            }
            setAdjunto({ file, campo: campoPara(file) });
          }}
        />
        <button
          type="button"
          onClick={() => selector.current?.click()}
          disabled={subiendo}
          aria-label="Adjuntar un fichero"
          className="rounded-lg border border-(--color-borde) px-3 py-2 text-sm hover:bg-(--color-ajeno) disabled:opacity-50"
        >
          +
        </button>
        <input
          name="texto" autoComplete="off"
          placeholder={adjunto ? "Pie de foto (opcional)…" : "Escribe un mensaje…"}
          className="flex-1 rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)"
        />
        <button
          disabled={subiendo}
          className="rounded-lg bg-(--color-acento) px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
        >
          {subiendo ? "Enviando…" : "Enviar"}
        </button>
      </form>
    </main>
  );
}
