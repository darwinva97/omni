"use client";

import { useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import type { Chat, Cita as CitaDe, Medio as TipoMedio, Mensaje } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { diaDeSeparador, hora, mismoDia, trozosConMenciones } from "@/lib/formato";
import { Acuse, Avatar } from "@/componentes/piezas";
import { tonoDe } from "@/lib/formato";
import { Medio } from "@/componentes/medio";
import { Encuesta } from "@/componentes/encuesta";
import { abreTanda, esAvisoDe } from "@/lib/tandas";
import { Grabadora } from "@/componentes/grabadora";
import { FichaContacto } from "@/componentes/ficha-contacto";
import {
  IconoAdjuntar, IconoBloquear, IconoCerrar, IconoCopiar, IconoDescargar,
  IconoEnviar, IconoInfo, IconoPapelera, IconoResponder, IconoSticker, IconoVolver,
} from "@/componentes/iconos";
import Link from "next/link";
import { Menu, useMenu, type OpcionMenu } from "@/componentes/menu";
import { Reacciones, Stickers } from "@/componentes/stickers";
import { campoPara, ETIQUETAS, MAX_BYTES, type CampoDeMedio } from "@/lib/adjuntar";
import { tamano } from "@/lib/formato";

/** De un mensaje del hilo a la cita que lo representa. */
function citaDeMensaje(m: Mensaje): CitaDe {
  return {
    id: m.providerMessageId ?? m.id,
    fromMe: m.fromMe,
    senderName: m.senderName ?? null,
    kind: m.kind,
    body: m.body,
    thumbUrl: m.media?.url ?? null,
    disponible: true,
  };
}

/** Los tipos que se pintan como fichero y no como texto. */
const MEDIOS = new Set(["image", "sticker", "video", "audio", "document"]);

/** Un sticker va suelto, sin burbuja: con fondo se ve peor que en WhatsApp. */
const SIN_BURBUJA = new Set(["sticker"]);

/**
 * Cómo se llama en castellano lo que no se pinta con su propio aspecto.
 *
 * Es lo que se lee cuando un mensaje no trae texto: antes salía el nombre
 * interno del tipo —«poll», «template»— dentro de la burbuja, que no le dice
 * nada a nadie.
 */
const ETIQUETA: Record<string, string> = {
  poll: "Encuesta", contact: "Contacto", location: "Ubicación",
  template: "Plantilla", buttons: "Mensaje con botones", list: "Mensaje con lista",
  unknown: "Mensaje no compatible", system: "Aviso del sistema",
};

export function Conversacion({
  lineId,
  chat,
  info,
  iniciales,
  enviar,
  enviarMedio,
}: {
  lineId: string;
  chat: string;
  info: Chat | null;
  iniciales: Mensaje[];
  enviar: (texto: string, replyTo?: string) => Promise<Mensaje | null>;
  enviarMedio: (
    campo: string, storageKey: string, pie: string, fileName: string,
    extra?: Record<string, unknown>,
    replyTo?: string,
  ) => Promise<Mensaje | null>;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>(iniciales);
  const [ficha, setFicha] = useState(false);
  const { conectado, suscribir } = useEventos(lineId);
  const fondo = useRef<HTMLDivElement>(null);
  const formulario = useRef<HTMLFormElement>(null);
  const selector = useRef<HTMLInputElement>(null);
  const [adjunto, setAdjunto] = useState<
    { file: File; campo: CampoDeMedio; gif?: boolean } | null
  >(null);
  const [subiendo, setSubiendo] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);

  // Al cambiar de conversación entra otra lista: sin esto se vería el hilo
  // anterior hasta que llegara el primer evento del nuevo.
  useEffect(() => { setMensajes(iniciales); setFicha(false); }, [iniciales]);

  /*
   * Abrir una conversación la marca como leída.
   *
   * Es lo que hace cualquier cliente de mensajería, y sin ello el globo de no
   * leídos se quedaba puesto mientras uno está leyendo justo esa conversación.
   * Se avisa a la lista por el mismo socket que ya escucha, para que el
   * contador baje sin recargar.
   */
  useEffect(() => {
    void fetch(`/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [lineId, chat]);

  // Lo escrito aparece al instante. Esperar al servidor para pintar lo que
  // acabas de escribir se siente roto aunque tarde 200 ms.
  const [conPendientes, anadirPendiente] = useOptimistic(
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
     * Los acuses se aplican por IDENTIFICADOR, sin mirar la conversación:
     * WhatsApp puede reportar el chat de un acuse con otra forma de la misma
     * dirección, y filtrar por chat dejaba el estado sin actualizar nunca.
     */
    if (evento === "message.receipt") {
      const estado = String(data["state"] ?? "");
      const cliente = data["clientMessageId"] as string | undefined;
      setMensajes((prev) =>
        prev.map((x) =>
          (x.providerMessageId !== null && x.providerMessageId === key.id)
          || (cliente !== undefined && x.clientMessageId === cliente)
            ? { ...x, state: estado, providerMessageId: x.providerMessageId ?? key.id ?? null }
            : x));
      return;
    }

    // El fichero llega DESPUÉS del mensaje —la descarga va en una cola—, así
    // que el hueco pintado se rellena aquí sin recargar.
    if (evento === "message.updated") {
      const medio = data["media"] as TipoMedio | undefined;
      if (!medio) return;
      setMensajes((prev) =>
        prev.map((x) =>
          x.providerMessageId === key.id ? { ...x, media: medio, mediaError: null } : x));
      return;
    }

    /*
     * Una reacción NO es un mensaje.
     *
     * Llega por el mismo canal, y sin esto se añadía al hilo como una burbuja
     * vacía con la palabra «reaction» dentro. Es un dato SOBRE otro mensaje:
     * su sitio es el del mensaje al que apunta.
     *
     * Se aplica por identificador y sin mirar la conversación, como los
     * acuses: el chat de una reacción puede venir con otra forma de la misma
     * dirección, y filtrar por él dejaba la reacción sin aparecer nunca.
     */
    if (evento === "message.reaction") {
      const emoji = String(data["emoji"] ?? "").trim();
      const mia = key.fromMe === true;
      setMensajes((prev) => prev.map((x) => {
        if (x.providerMessageId !== key.id) return x;
        const lista = (x.reacciones ?? []).map((r) => ({ ...r }));

        // De cada persona solo puede haber una: la nueva retira la anterior.
        // La nuestra se sabe cuál era; la ajena no —el modelo agrupa por
        // emoji, no por persona— y esa se corrige al recargar.
        if (mia) {
          const i = lista.findIndex((r) => r.mia);
          const previa = lista[i];
          if (previa) {
            if (previa.cuantas > 1) { previa.cuantas--; previa.mia = false; }
            else lista.splice(i, 1);
          }
        }

        // Un emoji vacío es cómo WhatsApp dice «la retiro».
        if (emoji) {
          const igual = lista.find((r) => r.emoji === emoji);
          if (igual) { igual.cuantas++; igual.mia = igual.mia || mia; }
          else lista.push({ emoji, cuantas: 1, mia });
        }
        return { ...x, reacciones: lista };
      }));
      return;
    }

    // Retirado por quien lo escribió: se marca donde está, no se quita de la
    // lista, para que quien lee vea que ahí hubo algo.
    if (evento === "message.deleted") {
      setMensajes((prev) =>
        prev.map((x) => (x.providerMessageId === key.id ? { ...x, deleted: true } : x)));
      return;
    }

    if (evento === "message.upsert") return;
    if (key.remoteJid !== chat) return;

    /*
     * Lo que no es contenido no entra en el hilo.
     *
     * Una reacción ya se aplicó arriba, y un `protocolMessage` es una orden
     * sobre otro mensaje. El motor tampoco los guarda, así que pintarlos aquí
     * creaba burbujas que desaparecían al recargar.
     */
    const kind = String(data["kind"] ?? "text");
    if (kind === "reaction" || kind === "system") return;

    setMensajes((prev) => {
      if (key.id && prev.some((x) => x.providerMessageId === key.id)) return prev;

      /*
       * Un mensaje propio que vuelve es el eco del que ya fijamos al enviarlo.
       * Se empareja por el identificador que pusimos NOSOTROS, que viaja con el
       * evento: comparar el texto falla con dos mensajes iguales seguidos y no
       * sirve para un audio, que no tiene.
       */
      if (key.fromMe) {
        const cliente = data["clientMessageId"] as string | undefined;
        const i = cliente !== undefined
          ? prev.findIndex((x) => x.clientMessageId === cliente)
          : prev.findLastIndex(
              (x) => x.fromMe && !x.providerMessageId
                && x.body === ((data["text"] as string | null) ?? null),
            );
        if (i >= 0) {
          const copia = [...prev];
          copia[i] = { ...copia[i]!, providerMessageId: key.id ?? null, state: "sent" };
          return copia;
        }
      }

      /*
       * La cita, resuelta con lo que ya está en pantalla.
       *
       * El evento trae el identificador del citado y una copia de su
       * contenido, pero no el nombre de quien lo escribió ni su miniatura: eso
       * lo resuelve la API al cargar. Si el citado está en el hilo se saca de
       * ahí —sale completo, con miniatura—; si no, se pinta con la copia, que
       * es lo que WhatsApp también hace.
       */
      const citaEvento = data["replyTo"] as
        { id?: string; author?: string | null; kind?: string; text?: string | null }
        | undefined;
      let cita: CitaDe | null = null;
      if (citaEvento?.id) {
        const original = prev.find((x) => x.providerMessageId === citaEvento.id);
        cita = original
          ? citaDeMensaje(original)
          : {
              id: citaEvento.id, fromMe: false, senderName: null,
              kind: citaEvento.kind ?? "unknown", body: citaEvento.text ?? null,
              thumbUrl: null, disponible: false,
            };
      }

      return [...prev, {
        id: key.id ?? crypto.randomUUID(),
        providerMessageId: key.id ?? null,
        fromMe: key.fromMe ?? false,
        kind,
        body: (data["text"] as string | null) ?? null,
        state: key.fromMe ? "sent" : "delivered",
        timestamp: new Date(Number(data["timestamp"] ?? Date.now())).toISOString(),
        ...(cita ? { replyTo: cita } : {}),
        /*
         * Los nombres los pone el motor en el evento: quién escribe y a quién
         * menciona. Sin ellos un mensaje recién llegado enseñaba el número
         * hasta recargar, y el mismo mensaje cambiaba de aspecto al hacerlo.
         */
        ...(typeof data["senderName"] === "string"
          ? { senderName: data["senderName"] as string } : {}),
        ...(typeof data["senderAvatarUrl"] === "string"
          ? { senderAvatarUrl: data["senderAvatarUrl"] as string } : {}),
        // Quién escribe, para saber dónde empieza cada tanda en un grupo.
        ...(key.fromMe ? {} : {
          senderAddress: (data["key"] as { participant?: string })?.participant
            ?? key.remoteJid ?? null,
        }),
        ...(data["mentionNames"]
          ? {
              mentions: Object.entries(data["mentionNames"] as Record<string, string>)
                .map(([token, name]) => ({ token, name })),
            }
          : {}),
      }];
    });
  }), [chat, suscribir]);

  const yaColocado = useRef(false);
  useEffect(() => {
    // Al abrir, de golpe: ver el hilo deslizarse desde arriba durante medio
    // segundo cada vez que se entra en una conversación es ruido, no feedback.
    fondo.current?.scrollIntoView({
      behavior: yaColocado.current ? "smooth" : "instant",
      block: "end",
    });
    yaColocado.current = true;
  }, [conPendientes.length]);
  useEffect(() => { yaColocado.current = false; }, [chat]);

  const mandarFichero = async (
    file: File, campo: CampoDeMedio, pie: string, extra: Record<string, unknown> = {},
    replyTo?: string, cita?: CitaDe | null,
  ): Promise<void> => {
    setProblema(null);
    setSubiendo(true);
    try {
      const cuerpo = new FormData();
      cuerpo.append("file", file);
      cuerpo.append("lineId", lineId);
      const r = await fetch("/api/omni/v1/media", { method: "POST", body: cuerpo });
      if (!r.ok) {
        const detalle = (await r.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(detalle?.detail ?? `la subida falló (${r.status})`);
      }
      const { data } = (await r.json()) as { data: { storageKey: string } };

      const enviado = await enviarMedio(
        campo, data.storageKey, pie, file.name, extra, replyTo);
      if (enviado) {
        const conCita = cita ? { ...enviado, replyTo: cita } : enviado;
        setMensajes((prev) =>
          prev.some((x) => x.id === conCita.id) ? prev : [...prev, conCita]);
      }
      setAdjunto(null);
      if (selector.current) selector.current.value = "";
    } catch (e) {
      // El error se ENSEÑA: un adjunto que desaparece sin decir nada deja a
      // quien envía creyendo que se mandó.
      setProblema(e instanceof Error ? e.message : "no se pudo enviar el fichero");
    } finally {
      setSubiendo(false);
    }
  };

  const menu = useMenu();
  const [sobre, setSobre] = useState<Mensaje | null>(null);
  const [stickers, setStickers] = useState(false);
  const [reaccionando, setReaccionando] = useState<string | null>(null);
  const [respondiendo, setRespondiendo] = useState<Mensaje | null>(null);
  const [senalado, setSenalado] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);

  /**
   * Sube al mensaje citado y lo señala.
   *
   * Solo se puede si está CARGADO: el hilo trae los últimos cien, y una cita
   * puede apuntar a algo de hace meses. Cuando no está, la cita no es pulsable
   * en vez de desplazar a ninguna parte y dejar a quien lo pulsó perdido.
   */
  const saltarA = (id: string): (() => void) | null => {
    const destino = mensajes.find((x) => x.providerMessageId === id);
    if (!destino) return null;
    return () => {
      document.getElementById(`mensaje-${destino.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setSenalado(destino.id);
      // Se quita solo: una marca permanente dejaría el hilo lleno de
      // mensajes resaltados sin que nadie los haya vuelto a pedir.
      setTimeout(() => setSenalado((x) => (x === destino.id ? null : x)), 1200);
    };
  };

  /** Reacciona a un mensaje. Repetir el mismo emoji la retira, como WhatsApp. */
  const reaccionar = async (m: Mensaje, emoji: string): Promise<void> => {
    if (!m.providerMessageId) return;
    const yaEstaba = m.reacciones?.some((r) => r.mia && r.emoji === emoji);
    const final = yaEstaba ? "" : emoji;

    // Se pinta antes de que conteste la red: una reacción que tarda medio
    // segundo en aparecer se pulsa dos veces.
    setMensajes((prev) => prev.map((x) => {
      if (x.id !== m.id) return x;
      const otras = (x.reacciones ?? []).filter((r) => !r.mia);
      return {
        ...x,
        reacciones: final ? [...otras, { emoji: final, cuantas: 1, mia: true }] : otras,
      };
    }));

    await fetch(
      `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(m.providerMessageId)}/reaction`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: final }),
      },
    ).catch(() => {});
  };

  /**
   * Las acciones de un mensaje.
   *
   * Solo aparecen las que de verdad se pueden hacer con ESE mensaje: borrar
   * para todos solo en los propios —WhatsApp no deja borrar el de otro— y
   * descargar solo cuando hay fichero. Un menú con opciones que fallan al
   * pulsarlas es peor que un menú corto.
   */
  const accionesMensaje = (m: Mensaje): OpcionMenu[] => {
    const opciones: OpcionMenu[] = [];

    /*
     * Primera, y solo con identificador del proveedor: WhatsApp cita por el
     * identificador que él asignó, y uno recién enviado todavía no lo tiene.
     * Ofrecerlo igual mandaría una respuesta que llega sin cita.
     */
    if (m.providerMessageId && !m.deleted) {
      opciones.push({
        texto: "Responder",
        Icono: IconoResponder,
        onSelect: () => {
          setRespondiendo(m);
          campo.current?.focus();
        },
      });
    }
    if (m.body) {
      opciones.push({
        texto: "Copiar texto",
        Icono: IconoCopiar,
        onSelect: () => navigator.clipboard.writeText(m.body!),
      });
    }
    if (m.media) {
      opciones.push({
        texto: "Descargar",
        Icono: IconoDescargar,
        onSelect: () => { window.open(m.media!.url, "_blank", "noreferrer"); },
      });
    }
    if (m.providerMessageId) {
      opciones.push({
        texto: "Reaccionar",
        onSelect: () => setReaccionando(m.id),
      });
    }
    if (m.fromMe && m.providerMessageId) {
      opciones.push({
        texto: "Borrar para todos",
        peligro: true,
        Icono: IconoPapelera,
        onSelect: async () => {
          if (!confirm("Se borrará para todos en esta conversación.")) return;
          const r = await fetch(
            `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(m.providerMessageId!)}`,
            { method: "DELETE" },
          );
          if (r.ok) {
            setMensajes((prev) => prev.filter((x) => x.id !== m.id));
          }
        },
      });
    }
    return opciones;
  };

  const esGrupo = info?.kind === "group";
  const nombre = info?.displayName ?? chat;
  const detalle = info?.phone
    ? `+${info.phone.split("@")[0]}`
    : info?.kind === "group" ? "Grupo" : chat;

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-(--color-borde) bg-(--color-panel) px-3 py-2.5 md:px-4">
          {/* Volver a la lista. Solo en móvil: en escritorio la lista está al
              lado y un botón de volver no llevaría a ninguna parte nueva. */}
          <Link
            href={`/lineas/${lineId}`}
            aria-label="Volver a las conversaciones"
            className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto) md:hidden"
          >
            <IconoVolver className="size-5" />
          </Link>
          <Avatar
            nombre={nombre}
            direccion={chat}
            kind={info?.kind ?? "pn"}
            tamano="sm"
            url={info?.avatarUrl}
          />
          <button
            type="button"
            onClick={() => setFicha((v) => !v)}
            className="min-w-0 flex-1 text-left"
            aria-expanded={ficha}
          >
            <span className="block truncate text-sm font-semibold">{nombre}</span>
            <span className="block truncate text-xs text-(--color-tenue)">{detalle}</span>
          </button>

          <span
            title={conectado ? "Recibiendo en vivo" : "Reconectando"}
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-(--color-tenue)"
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                conectado ? "bg-(--color-exito)" : "bg-(--color-apagado)"
              }`}
            />
            <span className="sr-only">
              {conectado ? "Conexión en vivo activa" : "Reconectando"}
            </span>
          </span>

          <button
            type="button"
            onClick={() => setFicha((v) => !v)}
            aria-label={ficha ? "Ocultar información" : "Ver información del contacto"}
            className={`flex size-9 items-center justify-center rounded-lg transition-colors duration-150 ${
              ficha
                ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            }`}
          >
            <IconoInfo className="size-5" />
          </button>
        </header>

        <ol className="scroll-discreto flex-1 space-y-0.5 overflow-y-auto bg-(--color-lienzo) px-4 py-4 md:px-10">
          {conPendientes.map((m, i) => {
            const anterior = conPendientes[i - 1];
            const nuevoDia = !anterior || !mismoDia(anterior.timestamp, m.timestamp);
            /*
             * Una tanda es una ráfaga de la MISMA persona.
             *
             * Antes solo se miraba si era propio o ajeno, y en un grupo eso
             * juntaba a todos los demás en una sola tanda: lo que escribían
             * aimet y Esteban salía debajo del nombre de Rodrigo, sin el suyo.
             * Cada cambio de persona abre tanda nueva, con nombre, foto y cola.
             */
            const primeroDeTanda = nuevoDia || abreTanda(anterior, m, esGrupo);
            // En un grupo, lo ajeno lleva una columna a la izquierda para la
            // foto: la tiene la primera burbuja de la tanda y las demás dejan
            // el hueco, para que todas queden alineadas como en WhatsApp.
            const conFoto = esGrupo && !m.fromMe;
            const suelto = SIN_BURBUJA.has(m.kind) && m.media != null && !m.deleted
              && !m.replyTo;
            /*
             * Lo que este transporte no supo leer.
             *
             * No es de nadie y no dice nada, así que no merece una burbuja con
             * remitente y acuse: un aviso centrado, como el separador de día.
             */
            const esAviso = esAvisoDe(m);
            // Hay texto donde meter la hora: el cuerpo, o el aviso de retirado.
            const conTexto = m.deleted || Boolean(m.body);

            return (
              <li
                key={m.id}
                id={`mensaje-${m.id}`}
                className={senalado === m.id ? "mensaje-senalado" : undefined}
              >
                {nuevoDia && (
                  <div className="flex justify-center py-3">
                    <span className="rounded-full bg-(--color-panel) px-3 py-1 text-[11px] font-medium text-(--color-tenue) shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
                      {diaDeSeparador(m.timestamp)}
                    </span>
                  </div>
                )}

                {esAviso ? (
                  <div className="flex justify-center py-1.5">
                    <span
                      title="Llegó un mensaje de un tipo que WhatsApp no deja leer a este transporte. Queda guardado tal cual vino."
                      className="rounded-full bg-(--color-panel)/70 px-3 py-1 text-[11px] text-(--color-apagado)"
                    >
                      Mensaje no compatible
                      <time className="ml-1.5" dateTime={m.timestamp}>{hora(m.timestamp)}</time>
                    </span>
                  </div>
                ) : (
                <div
                  onContextMenu={(e) => { setSobre(m); menu.enContexto(e); }}
                  className={`mensaje-nuevo flex items-start gap-1.5 ${
                    m.fromMe ? "justify-end" : "justify-start"
                  } ${primeroDeTanda ? "mt-2" : ""}`}
                >
                  {conFoto && (
                    <span className="w-8 shrink-0">
                      {primeroDeTanda && (
                        <Avatar
                          nombre={m.senderName ?? "?"}
                          direccion={m.senderAddress ?? m.id}
                          kind="pn"
                          tamano="sm"
                          url={m.senderAvatarUrl ?? null}
                        />
                      )}
                    </span>
                  )}
                  <div
                    className={`relative max-w-[min(32rem,75%)] ${
                      suelto
                        ? ""
                        : `rounded-(--radius-burbuja) border px-2.5 py-1.5 ${
                            m.fromMe
                              ? "border-(--color-propio-borde) bg-(--color-propio)"
                              : "border-(--color-ajeno-borde) bg-(--color-ajeno)"
                          } ${
                            primeroDeTanda
                              ? m.fromMe ? "pico-propio" : "pico-ajeno"
                              : ""
                          }`
                    }`}
                  >
                    {/*
                      En un grupo, quién escribe. Sin esto, veinte burbujas
                      iguales y ninguna forma de seguir quién dice qué.
                    */}
                    {/*
                      Un sticker no tiene burbuja, así que su nombre va en una
                      pastilla propia y SIEMPRE, no solo al abrir la tanda:
                      suelto debajo de un texto, sin él no se sabría de quién
                      es. Es lo que hace WhatsApp.
                    */}
                    {esGrupo && !m.fromMe && m.senderName && (primeroDeTanda || suelto) && (
                      <p
                        className={`text-xs font-semibold ${
                          suelto
                            ? "mb-1 inline-block rounded-(--radius-burbuja) border border-(--color-ajeno-borde) bg-(--color-ajeno) px-2.5 py-1"
                            : "mb-0.5"
                        }`}
                        style={{
                          color: `oklch(var(--l-remitente) 0.12 ${tonoDe(m.senderAddress ?? "")})`,
                        }}
                      >
                        {m.senderName}
                      </p>
                    )}

                    {/*
                      La cita va DENTRO de la burbuja y antes del contenido,
                      como en WhatsApp: fuera parecería otro mensaje, y debajo
                      se leería al revés de como se escribió.
                    */}
                    {m.replyTo && !m.deleted && (
                      <Cita
                        cita={m.replyTo}
                        propia={m.fromMe}
                        onSaltar={m.replyTo.disponible ? saltarA(m.replyTo.id) : null}
                      />
                    )}

                    {m.deleted ? (
                      /*
                        Quien lo escribió lo retiró. Se dice, no se esconde: un
                        hueco donde había algo deja a quien lee sin saber si
                        perdió un mensaje o nunca hubo ninguno.
                      */
                      <p className="text-sm italic text-(--color-apagado)">
                        <IconoBloquear className="mr-1.5 inline-block size-3.5 -translate-y-px" />
                        Se eliminó este mensaje
                        <Firma mensaje={m} />
                      </p>
                    ) : m.poll ? (
                      // Sin `Firma`: la encuesta no es un párrafo donde quepa
                      // la hora flotando, así que va debajo como en una foto.
                      <Encuesta datos={m.poll} />
                    ) : MEDIOS.has(m.kind) ? (
                      <div className="space-y-1">
                        <Medio kind={m.kind} medio={m.media} error={m.mediaError} />
                        {/* El pie, cuando lo trae: en WhatsApp una foto puede
                            venir con texto y perderlo es perder medio mensaje. */}
                        {m.body && (
                          <p className="px-0.5 text-sm wrap-anywhere whitespace-pre-wrap">
                            <Texto mensaje={m} />
                            <Firma mensaje={m} />
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                        {m.body ? <Texto mensaje={m} /> : (
                          <em className="text-(--color-tenue)">
                            {ETIQUETA[m.kind] ?? m.kind}
                          </em>
                        )}
                        {/* La firma solo va DENTRO cuando hay texto donde
                            meterla; sin él se pintaba la hora dos veces. */}
                        {m.body && <Firma mensaje={m} />}
                      </p>
                    )}

                    {(m.reacciones?.length ?? 0) > 0 && (
                      <span
                        className={`absolute -bottom-2.5 flex gap-0.5 ${
                          m.fromMe ? "right-2" : "left-2"
                        }`}
                      >
                        {m.reacciones!.map((r) => (
                          <button
                            key={r.emoji}
                            type="button"
                            onClick={() => void reaccionar(m, r.emoji)}
                            title={r.mia ? "Tu reacción; púlsala para quitarla" : undefined}
                            className={`flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[11px] ${
                              r.mia
                                ? "border-(--color-acento) bg-(--color-acento-tenue)"
                                : "border-(--color-borde) bg-(--color-panel)"
                            }`}
                          >
                            <span>{r.emoji}</span>
                            {r.cuantas > 1 && <span>{r.cuantas}</span>}
                          </button>
                        ))}
                      </span>
                    )}

                    {reaccionando === m.id && (
                      <span
                        className={`absolute -top-10 z-20 ${m.fromMe ? "right-0" : "left-0"}`}
                      >
                        <Reacciones
                          onElegir={(e) => reaccionar(m, e)}
                          onCerrar={() => setReaccionando(null)}
                        />
                      </span>
                    )}

                    {/*
                      Cuando no hay texto donde meter la hora —una foto sola, un
                      sticker— va debajo, que es lo único que queda.
                    */}
                    {(!conTexto || suelto) && (
                      <span
                        className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] text-(--color-apagado) ${
                          suelto ? "pr-1" : ""
                        }`}
                      >
                        <time dateTime={m.timestamp}>{hora(m.timestamp)}</time>
                        {m.fromMe && <Acuse estado={m.state} />}
                      </span>
                    )}
                  </div>
                </div>
                )}
              </li>
            );
          })}
          <div ref={fondo} />
        </ol>

        {problema && (
          <p
            role="alert"
            className="border-t border-(--color-error) bg-(--color-error-tenue) px-4 py-2 text-xs text-(--color-error)"
          >
            {problema}
          </p>
        )}

        {adjunto && (
          <div className="flex items-center gap-3 border-t border-(--color-borde) bg-(--color-panel) px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{adjunto.file.name}</p>
              <p className="text-xs text-(--color-tenue)">
                {tamano(adjunto.file.size)} · {adjunto.file.type || "tipo desconocido"}
              </p>
            </div>

            {/* El tipo se puede cambiar: un WebP se adjunta como sticker por
                defecto, pero a veces se quiere mandar como foto. */}
            <label className="text-xs text-(--color-tenue)">
              <span className="sr-only">Enviar como</span>
              <select
                value={adjunto.campo}
                onChange={(e) => setAdjunto({ ...adjunto, campo: e.target.value as CampoDeMedio })}
                className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1.5 text-xs"
              >
                {(Object.keys(ETIQUETAS) as CampoDeMedio[]).map((k) => (
                  <option key={k} value={k}>{ETIQUETAS[k]}</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => {
                setAdjunto(null);
                setProblema(null);
                if (selector.current) selector.current.value = "";
              }}
              aria-label="Quitar el adjunto"
              className="flex size-8 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          </div>
        )}

        {/*
          A quién se está respondiendo, encima del campo.
          Va aquí y no dentro del formulario porque se ve ANTES de escribir: es
          lo que confirma que la respuesta va a ese mensaje y no al aire.
        */}
        {respondiendo && (
          <div className="flex items-center gap-2 border-t border-(--color-borde) bg-(--color-panel) px-3 pt-2 md:px-4">
            <span className="flex items-center gap-2 text-(--color-tenue)">
              <IconoResponder className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <Cita cita={citaDeMensaje(respondiendo)} propia={false} onSaltar={null} />
            </div>
            <button
              type="button"
              onClick={() => setRespondiendo(null)}
              aria-label="No responder a ese mensaje"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          </div>
        )}

        <form
          ref={formulario}
          action={async (formData) => {
            const texto = String(formData.get("texto") ?? "").trim();

            // Con adjunto, lo escrito es el PIE y no otro mensaje: dos
            // mensajes separados no es lo que se pidió al escribir junto.
            /*
             * La cita se toma y se suelta ANTES de enviar.
             *
             * Si se dejara puesta hasta que el servidor conteste, lo siguiente
             * que se escriba —y se escribe rápido— saldría citando también.
             */
            const citado = respondiendo;
            setRespondiendo(null);
            const citaLocal = citado ? citaDeMensaje(citado) : null;

            if (adjunto) {
              formulario.current?.reset();
              await mandarFichero(
                adjunto.file, adjunto.campo, texto,
                // Un GIF sale como vídeo en bucle, que es lo que WhatsApp
                // llama «GIF»; sin la marca llega como un vídeo normal.
                adjunto.gif && adjunto.campo === "video" ? { gifPlayback: true } : {},
                citado?.providerMessageId ?? undefined,
                citaLocal,
              );
              return;
            }

            if (!texto) return;
            formulario.current?.reset();
            startTransition(() => anadirPendiente(texto));

            const enviado = await enviar(texto, citado?.providerMessageId ?? undefined);
            if (enviado) {
              /*
               * La cita se pinta con lo que YA tenemos aquí.
               *
               * El servidor la devolvería resuelta en la siguiente carga, pero
               * esperar a eso dejaría la respuesta sin cita unos segundos,
               * justo la que se acaba de mandar.
               */
              const conCita = citaLocal ? { ...enviado, replyTo: citaLocal } : enviado;
              setMensajes((prev) =>
                prev.some((x) => x.id === conCita.id) ? prev : [...prev, conCita]);
            }
          }}
          className="relative flex items-end gap-1.5 border-t border-(--color-borde) bg-(--color-panel) px-3 py-2.5"
        >
          {stickers && (
            <Stickers
              lineId={lineId}
              onCerrar={() => setStickers(false)}
              onElegir={async (storageKey) => {
                const enviado = await enviarMedio("sticker", storageKey, "", "sticker.webp");
                if (enviado) {
                  setMensajes((prev) =>
                    prev.some((x) => x.id === enviado.id) ? prev : [...prev, enviado]);
                }
              }}
            />
          )}
          <input
            ref={selector}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setProblema(null);
              if (file.size > MAX_BYTES) {
                // Se avisa ANTES de subir: mandar sesenta megas para que el
                // otro lado los rechace es el viaje entero perdido.
                setProblema(`${tamano(file.size)} es demasiado; el máximo es ${tamano(MAX_BYTES)}`);
                e.target.value = "";
                return;
              }
              setAdjunto({ file, campo: campoPara(file), gif: file.type === "image/gif" });
            }}
          />
          <button
            type="button"
            onClick={() => selector.current?.click()}
            disabled={subiendo}
            aria-label="Adjuntar un fichero"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-texto) disabled:opacity-40 md:size-10"
          >
            <IconoAdjuntar className="size-5" />
          </button>

          <button
            type="button"
            onClick={() => setStickers((v) => !v)}
            disabled={subiendo}
            aria-label="Stickers"
            aria-expanded={stickers}
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-40 md:size-10 ${
              stickers
                ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            }`}
          >
            <IconoSticker className="size-5" />
          </button>

          <Grabadora
            tipo="audio"
            deshabilitado={subiendo || adjunto !== null}
            onError={setProblema}
            onGrabado={(file) => mandarFichero(file, "audio", "", { ptt: true })}
          />
          {/*
            El de vídeo, solo en escritorio.
            En 390 píxeles, cuatro botones y el campo de texto no caben: el
            campo se queda en «Escribe un mer». Grabar vídeo es lo menos
            frecuente de los cuatro y un vídeo se puede adjuntar igual.
          */}
          <span className="hidden md:contents">
            <Grabadora
              tipo="video"
              deshabilitado={subiendo || adjunto !== null}
              onError={setProblema}
              onGrabado={(file) => mandarFichero(file, "video", "")}
            />
          </span>

          <input
            ref={campo}
            name="texto"
            autoComplete="off"
            placeholder={adjunto ? "Añade un pie (opcional)…" : "Escribe un mensaje"}
            className="min-w-0 flex-1 rounded-xl bg-(--color-hundido) px-3.5 py-2.5 text-sm md:px-4 outline-none placeholder:text-(--color-apagado) focus:ring-2 focus:ring-(--color-acento)"
          />

          <button
            disabled={subiendo}
            aria-label="Enviar"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-(--color-acento) md:size-10 text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            <IconoEnviar className="size-5" />
          </button>
        </form>
      </div>

      <Menu
        punto={menu.punto}
        opciones={sobre ? accionesMensaje(sobre) : []}
        onCerrar={menu.cerrar}
      />

      {ficha && info && (
        <FichaContacto
          info={info}
          mensajes={mensajes}
          onCerrar={() => setFicha(false)}
        />
      )}
    </div>
  );
}

/**
 * La hora y el acuse, metidos en la última línea del texto.
 *
 * Es la densidad que hace que WhatsApp quepa: con la hora en su propia línea,
 * un «vale» ocupa dos renglones y una ráfaga de diez mensajes cortos llena la
 * pantalla sin decir nada. El hueco en blanco reserva el sitio para que la
 * hora no se monte encima de la última palabra.
 */
/**
 * La cita de un mensaje que responde a otro.
 *
 * Es la forma de WhatsApp y cada parte está por algo:
 *
 * - **Barra de color a la izquierda** del color de quien escribió el citado,
 *   el mismo que lleva su nombre en los grupos. Es lo que permite ver de un
 *   vistazo a quién se está respondiendo sin leer el nombre.
 * - **Fondo un paso más oscuro** que la burbuja, no un color distinto: la cita
 *   es la misma burbuja mirando atrás, no un mensaje dentro de otro.
 * - **Una sola línea** de texto, recortada. La cita sitúa; el mensaje que
 *   importa es el de debajo, y una cita de seis líneas lo entierra.
 * - **Miniatura a la derecha** cuando el citado lleva foto o vídeo: reconocer
 *   una imagen por su miniatura es inmediato y por el texto «Foto» no.
 * - **Pulsable** para subir al original, con un destello al llegar.
 */
function Cita({
  cita, propia, onSaltar,
}: {
  cita: CitaDe;
  /** Si la burbuja que la contiene es nuestra: cambia el fondo, no la cita. */
  propia: boolean;
  onSaltar: (() => void) | null;
}) {
  const quien = cita.fromMe ? "Tú" : cita.senderName ?? "Alguien";
  /*
   * El color sale de QUIEN escribió el citado, no de quien responde: así la
   * cita de Ana es del color de Ana en toda la conversación. Lo propio va con
   * el acento, que es el color que ya tiene lo nuestro en el panel.
   */
  const color = cita.fromMe
    ? "var(--color-acento-fuerte)"
    : `oklch(var(--l-remitente) 0.12 ${tonoDe(cita.senderName ?? cita.id)})`;

  const Caja = onSaltar ? "button" : "div";
  return (
    <Caja
      {...(onSaltar
        ? { type: "button" as const, onClick: onSaltar,
            title: `Ir al mensaje de ${quien}` }
        : {})}
      className={`mb-1 flex w-full items-stretch gap-2 overflow-hidden rounded-md text-left ${
        propia ? "bg-(--color-cita-propia)" : "bg-(--color-cita-ajena)"
      } ${onSaltar ? "cursor-pointer hover:brightness-[0.97]" : ""}`}
    >
      <span aria-hidden className="w-1 shrink-0" style={{ background: color }} />
      <span className="min-w-0 flex-1 py-1 pr-1">
        <span className="block truncate text-xs font-semibold" style={{ color }}>
          {quien}
        </span>
        <span className="block truncate text-xs text-(--color-tenue)">
          {cita.body?.trim() || ETIQUETA[cita.kind] || "Mensaje"}
        </span>
      </span>
      {cita.thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cita.thumbUrl}
          alt=""
          className="size-12 shrink-0 object-cover"
        />
      )}
    </Caja>
  );
}

/**
 * El texto de un mensaje, con las menciones como en WhatsApp.
 *
 * WhatsApp manda `@120238196658384` y deja al cliente poner el nombre. Aquí
 * se pinta `@Nadkym` en el color de acento y en negrita suave, que es como se
 * distingue en el teléfono que eso es una persona y no texto. El número sigue
 * en el `title`: es el detalle, no lo que se lee.
 */
function Texto({ mensaje }: { mensaje: Mensaje }) {
  return (
    <>
      {trozosConMenciones(mensaje.body ?? "", mensaje.mentions).map((t, i) =>
        "texto" in t
          ? <span key={i}>{t.texto}</span>
          : (
            <span
              key={i}
              title={t.token}
              className="font-medium text-(--color-acento-fuerte)"
            >
              @{t.mencion}
            </span>
          ))}
    </>
  );
}

function Firma({ mensaje }: { mensaje: Mensaje }) {
  return (
    <>
      {/* Hueco reservado para que la hora no se monte sobre la última palabra. */}
      <span aria-hidden className="inline-block w-14 select-none" />
      <span className="float-right ml-1.5 inline-flex translate-y-0.5 items-center gap-1 text-[11px] leading-none text-(--color-apagado)">
        <time dateTime={mensaje.timestamp}>{hora(mensaje.timestamp)}</time>
        {mensaje.fromMe && <Acuse estado={mensaje.state} />}
      </span>
    </>
  );
}
