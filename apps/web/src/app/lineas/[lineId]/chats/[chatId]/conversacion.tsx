"use client";

import {
  useCallback, useEffect, useLayoutEffect, useOptimistic, useRef, useState, startTransition,
} from "react";
import type { Chat, Cita as CitaDe, Medio as TipoMedio, Mensaje } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { diaDeSeparador, hora, mismoDia, trozosConMenciones } from "@/lib/formato";
import { partirEnlaces } from "@/lib/enlaces";
import { Acuse, Avatar } from "@/componentes/piezas";
import { tonoDe } from "@/lib/formato";
import { Medio } from "@/componentes/medio";
import { Encuesta } from "@/componentes/encuesta";
import { BuscarEnChat, type Resultado } from "@/componentes/buscar-en-chat";
import { describir, usePresencias } from "@/lib/presencia";
import {
  candidatosDeMencion, consultaDeMencion, filtrarParticipantes, insertarMencion,
  prepararMenciones, type Participante,
} from "@/lib/menciones";
import { useAgenda } from "@/lib/agenda";
import { abreTanda, esAvisoDe } from "@/lib/tandas";
import { Grabadora } from "@/componentes/grabadora";
import { FichaContacto } from "@/componentes/ficha-contacto";
import {
  IconoAdjuntar, IconoBloquear, IconoCamara, IconoCerrar, IconoCheck, IconoCopiar, IconoDescargar,
  IconoDocumento, IconoEditar, IconoImagen, IconoMicrofono, IconoSonido,
  IconoBuscar, IconoEnviar, IconoInfo, IconoPapelera, IconoReenviar, IconoResponder, IconoSticker,
  IconoVolver,
} from "@/componentes/iconos";
import { Reenviar } from "@/componentes/reenviar";
import Link from "next/link";
import { Menu, useMenu, type OpcionMenu } from "@/componentes/menu";
import { Reacciones, Stickers } from "@/componentes/stickers";
import {
  agregarAdjuntos, ETIQUETAS, ficherosPegados, MAX_ADJUNTOS, type Adjunto, type CampoDeMedio,
} from "@/lib/adjuntar";
import { tamano } from "@/lib/formato";
import { guardarBorrador, leerBorrador, type Borrador } from "@/lib/borradores";
import { ControlesDeAtencion } from "@/componentes/atencion";
import { useEquipo } from "@/lib/equipo";
import type { Conversacion as Atencion } from "@/lib/api";

/** Quienes han escrito en el hilo cargado, una vez cada uno. */
function quienesEscribieron(mensajes: readonly Mensaje[]): Participante[] {
  const vistos = new Map<string, Participante>();
  for (const m of mensajes) {
    if (m.fromMe || !m.senderAddress || !m.senderName) continue;
    vistos.set(m.senderAddress, { address: m.senderAddress, name: m.senderName });
  }
  return [...vistos.values()];
}

/** La hora de ahora, para los manejadores: fuera del componente, que no es render. */
const marcaDeTiempo = (): number => Date.now();

/**
 * Lo que dice una cita, como WhatsApp: el texto si lo hay; si no, qué es.
 * Un audio con su duración, un documento con su nombre.
 */
function textoDeCita(cita: CitaDe): string {
  const texto = cita.body?.trim();
  const duracion = cita.seconds
    ? ` ${Math.floor(cita.seconds / 60)}:${String(Math.floor(cita.seconds % 60)).padStart(2, "0")}`
    : "";
  switch (cita.kind) {
    case "audio": return `${cita.ptt ? "Mensaje de voz" : "Audio"}${duracion}`;
    case "video": return texto || `Vídeo${duracion}`;
    case "image": return texto || "Foto";
    case "sticker": return "Sticker";
    case "document": return cita.fileName || texto || "Documento";
    default: return texto || ETIQUETA[cita.kind] || "Mensaje";
  }
}

/** El icono delante de lo que se cita, cuando no es texto. Dibujado, no emoji. */
function IconoDeCita({ kind, ptt }: { kind: string; ptt: boolean }) {
  const clase = "size-3.5 shrink-0";
  switch (kind) {
    case "audio": return ptt ? <IconoMicrofono className={clase} /> : <IconoSonido className={clase} />;
    case "video": return <IconoCamara className={clase} />;
    case "image": return <IconoImagen className={clase} />;
    case "sticker": return <IconoSticker className={clase} />;
    case "document": return <IconoDocumento className={clase} />;
    default: return null;
  }
}

/** De un mensaje del hilo a la cita que lo representa. */
function citaDeMensaje(m: Mensaje): CitaDe {
  return {
    id: m.providerMessageId ?? m.id,
    fromMe: m.fromMe,
    senderName: m.senderName ?? null,
    kind: m.kind,
    body: m.body,
    // Solo lo que es imagen se cita con imagen: la URL de un audio en una
    // `<img>` es una imagen rota.
    thumbUrl: m.kind === "image" || m.kind === "sticker" ? m.media?.url ?? null : null,
    fileName: m.media?.fileName ?? null,
    disponible: true,
  };
}

/**
 * Cuánto se puede editar un mensaje propio: lo que deja WhatsApp.
 *
 * Pasado ese tiempo la edición no falla allí, se IGNORA, y la API la rechaza
 * con el motivo (ver `VENTANA_DE_EDICION_MS` en la API). Aquí solo sirve para
 * no ofrecer «Editar» donde no va a llegar.
 */
const VENTANA_DE_EDICION_MS = 15 * 60_000;

/**
 * Si un mensaje se puede editar desde aquí.
 *
 * Solo texto propio que ya tiene identificador de WhatsApp —se edita por él—
 * y sin menciones: la edición viaja como texto plano, y una mención editada
 * llegaría como «@120238196658384». Los pies de foto tampoco: Baileys manda
 * la edición como un mensaje de texto, y WhatsApp espera el pie dentro de la
 * foto; ofrecerlo sería prometer algo que no sabemos si llega.
 */
function editable(m: Mensaje): boolean {
  return m.fromMe && m.kind === "text" && Boolean(m.body) && Boolean(m.providerMessageId)
    && !m.deleted && !(m.mentions?.length)
    && marcaDeTiempo() - Date.parse(m.timestamp) < VENTANA_DE_EDICION_MS;
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
  enviar: (texto: string, replyTo?: string, mentions?: string[]) => Promise<Mensaje | null>;
  enviarMedio: (
    campo: string, storageKey: string, pie: string, fileName: string,
    extra?: Record<string, unknown>,
    replyTo?: string,
  ) => Promise<Mensaje | null>;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>(iniciales);
  const [ficha, setFicha] = useState(false);
  const { conectado, suscribir } = useEventos(lineId);
  const { presencias, ahora } = usePresencias(suscribir);
  const [buscando, setBuscando] = useState(false);
  /*
   * `ventana`: el hilo enseña mensajes de alrededor de un resultado de
   * búsqueda, no los últimos. Mientras dura, lo que llega en vivo no se pega
   * al final —quedaría un salto de meses en medio— y se avisa en el botón de
   * volver a lo reciente.
   */
  const [ventana, setVentana] = useState(false);
  const [hayNuevos, setHayNuevos] = useState(false);
  // El manejador del socket se crea una vez: lee la ventana por aquí.
  const ventanaRef = useRef(false);
  useEffect(() => { ventanaRef.current = ventana; }, [ventana]);
  const saltoPendiente = useRef<string | null>(null);
  const fondo = useRef<HTMLDivElement>(null);
  const formulario = useRef<HTMLFormElement>(null);
  const selector = useRef<HTMLInputElement>(null);
  /*
   * Lo que está listo para enviar: una tira, como en WhatsApp.
   *
   * Cada uno lleva su pie, y el campo de texto edita el del que esté elegido.
   * Enter los manda todos, en orden, uno por mensaje.
   */
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<{ hecho: number; total: number } | null>(null);
  const actual = adjuntos.find((a) => a.id === elegido) ?? adjuntos[0] ?? null;
  const [subiendo, setSubiendo] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);

  // Al cambiar de conversación entra otra lista: sin esto se vería el hilo
  // anterior hasta que llegara el primer evento del nuevo.
  useEffect(() => {
    setMensajes(iniciales); setFicha(false); setBuscando(false);
    setVentana(false); setHayNuevos(false);
  }, [iniciales]);

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
      // Una edición: el motor ya la abrió y trae el texto nuevo.
      if (typeof data["text"] === "string" && data["editedAt"]) {
        const texto = data["text"] as string;
        const editedAt = data["editedAt"] as string;
        setMensajes((prev) => prev.map((x) =>
          x.providerMessageId === key.id ? { ...x, body: texto, editedAt } : x));
        return;
      }
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
    // `chatId` es la conversación donde el motor lo guardó: la misma persona
    // puede escribir por su teléfono o por su LID y su chat es uno solo.
    if (((data["chatId"] as string | undefined) ?? key.remoteJid) !== chat) return;

    /*
     * Lo que no es contenido no entra en el hilo.
     *
     * Una reacción ya se aplicó arriba, y un `protocolMessage` es una orden
     * sobre otro mensaje. El motor tampoco los guarda, así que pintarlos aquí
     * creaba burbujas que desaparecían al recargar.
     */
    const kind = String(data["kind"] ?? "text");
    if (kind === "reaction" || kind === "system") return;
    if (ventanaRef.current) { setHayNuevos(true); return; }

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

  /*
   * Quién lleva este chat y en qué estado. Se sigue en vivo: si otra persona
   * se lo asigna o lo resuelve desde su pestaña, aquí se ve al momento.
   */
  const { yo, miembros } = useEquipo();
  // Atada a SU chat, como los participantes: al cambiar de conversación, la
  // del anterior deja de valer sin tener que borrarla a mano.
  const [atencionDe, setAtencionDe] = useState<{ chat: string; conv: Atencion | null } | null>(null);
  const atencion = atencionDe?.chat === chat ? atencionDe.conv : info?.conversation ?? null;
  const setAtencion = useCallback(
    (conv: Atencion | null) => setAtencionDe({ chat, conv }), [chat]);
  useEffect(() => suscribir((evento, data) => {
    if (evento !== "conversation.updated") return;
    const c = data as unknown as Atencion;
    if (c.chatId !== chat) return;
    setAtencionDe((previa) => {
      const actual = previa?.chat === chat ? previa.conv : info?.conversation ?? null;
      // La resuelta de antes no tapa la que se acaba de abrir.
      return { chat, conv: actual && actual.id !== c.id && actual.openedAt > c.openedAt ? actual : c };
    });
  }), [chat, suscribir, info]);

  const yaColocado = useRef(false);
  useEffect(() => {
    // Si se acaba de cargar una ventana para ir a un resultado, el sitio es
    // ese resultado y no el final: bajar a la vez que se sube los pisaba, y
    // la vista se quedaba a medio camino.
    if (saltoPendiente.current) return;
    // Al abrir, de golpe: ver el hilo deslizarse desde arriba durante medio
    // segundo cada vez que se entra en una conversación es ruido, no feedback.
    fondo.current?.scrollIntoView({
      behavior: yaColocado.current ? "smooth" : "instant",
      block: "end",
    });
    yaColocado.current = true;
  }, [conPendientes.length]);
  useEffect(() => { yaColocado.current = false; }, [chat]);

  /** Lo que había escrito cuando entró el primer adjunto. Ver prepararAdjuntos. */
  const textoAntesDeAdjuntar = useRef<string | null>(null);

  /**
   * Añade ficheros a la tira: el mismo camino para el clip y para pegar.
   *
   * El pie que se estuviera escribiendo se guarda en el adjunto elegido antes
   * de cambiar de elegido; si no, se perdería al saltar al nuevo.
   */
  const prepararAdjuntos = (ficheros: readonly File[]): void => {
    if (ficheros.length === 0) return;
    const conPie = guardarPie(adjuntos);
    const { lista, avisos } = agregarAdjuntos(conPie, ficheros, () => crypto.randomUUID());
    setProblema(avisos.length > 0 ? avisos.join(" ") : null);
    if (lista.length === conPie.length) return;
    if (conPie.length === 0) {
      /*
       * Lo escrito pasa a ser el PIE del primero, como en WhatsApp: pegar una
       * captura con el texto ya escrito es ponerle ese texto debajo. Antes se
       * vaciaba el campo y lo escrito se perdía, borrador incluido.
       *
       * Se aparta también por si se quitan los adjuntos sin enviar: entonces
       * vuelve al campo. El borrador se queda como estaba, con ese texto.
       */
      const escrito = campo.current?.value ?? "";
      textoAntesDeAdjuntar.current = escrito;
      const conTexto = lista.map((a, i) => (i === 0 ? { ...a, pie: escrito } : a));
      elegir(conTexto[0]!.id, conTexto);
      return;
    }
    setAdjuntos(lista);
    // Se elige el primero de los recién añadidos, que es lo que se acaba de
    // mirar, y su pie (vacío) pasa al campo.
    elegir(lista[conPie.length]!.id, lista);
  };

  /** Copia lo escrito en el campo al pie del adjunto elegido. */
  const guardarPie = (lista: readonly Adjunto[]): Adjunto[] => {
    const pie = campo.current?.value ?? "";
    const id = actual?.id;
    return lista.map((a) => (a.id === id ? { ...a, pie } : a));
  };

  /** Cambia de adjunto elegido, guardando el pie del anterior. */
  const elegir = (id: string, lista: readonly Adjunto[] = guardarPie(adjuntos)): void => {
    setAdjuntos([...lista]);
    setElegido(id);
    if (campo.current) campo.current.value = lista.find((a) => a.id === id)?.pie ?? "";
    ajustarAltura();
    campo.current?.focus();
  };

  const quitarAdjunto = (id: string): void => {
    const conPie = guardarPie(adjuntos);
    const lista = conPie.filter((a) => a.id !== id);
    setAdjuntos(lista);
    setProblema(null);
    if (lista.length === 0) {
      /*
       * Sin adjuntos, el campo vuelve a ser un mensaje, y no se queda vacío:
       * lleva el pie del último que se quita si se escribió algo en él, o si
       * no lo que había antes de adjuntar. Quitar una imagen pegada por
       * error no borra lo que estabas escribiendo.
       */
      const pie = conPie.find((a) => a.id === id)?.pie ?? "";
      if (campo.current) campo.current.value = pie.trim() ? pie : textoAntesDeAdjuntar.current ?? "";
      textoAntesDeAdjuntar.current = null;
      setElegido(null);
      ajustarAltura();
      return;
    }
    if (id === actual?.id) {
      const siguiente = lista[0];
      setElegido(siguiente?.id ?? null);
      if (campo.current) campo.current.value = siguiente?.pie ?? "";
      ajustarAltura();
    }
  };

  const mandarFichero = async (
    file: File, campo: CampoDeMedio, pie: string, extra: Record<string, unknown> = {},
    replyTo?: string, cita?: CitaDe | null,
  ): Promise<boolean> => {
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
      return true;
    } catch (e) {
      // El error se ENSEÑA: un adjunto que desaparece sin decir nada deja a
      // quien envía creyendo que se mandó.
      setProblema(`«${file.name}»: ${
        e instanceof Error ? e.message : "no se pudo enviar el fichero"}`);
      return false;
    } finally {
      setSubiendo(false);
    }
  };

  const menu = useMenu();
  const [sobre, setSobre] = useState<Mensaje | null>(null);
  const [stickers, setStickers] = useState(false);
  const [reaccionando, setReaccionando] = useState<string | null>(null);
  const [respondiendo, setRespondiendo] = useState<Mensaje | null>(null);
  /*
   * El mensaje propio que se está corrigiendo. Mientras dura, el campo de
   * abajo es SU texto y no un mensaje nuevo, como en WhatsApp Desktop: Enter
   * guarda y Esc deja las cosas como estaban.
   */
  const [editando, setEditando] = useState<Mensaje | null>(null);
  const [reenviando, setReenviando] = useState<Mensaje | null>(null);
  const [senalado, setSenalado] = useState<string | null>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  /*
   * El campo crece con lo escrito, hasta unas ocho líneas, y luego se
   * desplaza por dentro. Se recalcula también cuando el texto cambia sin
   * teclear —al enviar, al elegir otro adjunto, al insertar una mención—,
   * porque entonces no hay evento `input` que lo avise.
   */
  const ajustarAltura = (): void => {
    const el = campo.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  };

  /**
   * Sube al mensaje citado y lo señala.
   *
   * Solo se puede si está CARGADO: el hilo trae los últimos cien, y una cita
   * puede apuntar a algo de hace meses. Cuando no está, la cita no es pulsable
   * en vez de desplazar a ninguna parte y dejar a quien lo pulsó perdido.
   */
  /** Sube a un mensaje que está en pantalla y lo señala con un destello. */
  const senalar = (id: string, como: ScrollBehavior = "smooth"): void => {
    document.getElementById(`mensaje-${id}`)
      ?.scrollIntoView({ behavior: como, block: "center" });
    setSenalado(id);
    // Se quita solo: una marca permanente dejaría el hilo lleno de
    // mensajes resaltados sin que nadie los haya vuelto a pedir.
    setTimeout(() => setSenalado((x) => (x === id ? null : x)), 1200);
  };

  const saltarA = (id: string): (() => void) | null => {
    const destino = mensajes.find((x) => x.providerMessageId === id);
    if (!destino) return null;
    return () => senalar(destino.id);
  };

  const historial = async (consulta: string): Promise<Mensaje[] | null> => {
    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages?${consulta}`);
    if (!r.ok) return null;
    const { data } = (await r.json()) as { data: Mensaje[] };
    // La API da de más nuevo a más viejo; el hilo se pinta al revés.
    return [...data].reverse();
  };

  /**
   * Va a un resultado de búsqueda.
   *
   * Si ya está en pantalla, se sube a él. Si no —lo normal: el hilo trae los
   * últimos cien—, se cargan los mensajes de alrededor y se salta cuando
   * estén pintados.
   */
  const irAResultado = async (r: Resultado): Promise<void> => {
    const cargado = mensajes.find((m) => m.id === r.id
      || (r.providerMessageId !== null && m.providerMessageId === r.providerMessageId));
    if (cargado) { senalar(cargado.id); return; }
    const alrededor = await historial(`around=${encodeURIComponent(r.timestamp)}&limit=60`);
    if (!alrededor) return;
    saltoPendiente.current = r.id;
    setMensajes(alrededor);
    setVentana(true);
  };

  const volverAlPresente = async (): Promise<void> => {
    const ultimos = await historial("limit=100");
    if (!ultimos) return;
    setMensajes(ultimos);
    setVentana(false);
    setHayNuevos(false);
    requestAnimationFrame(() => fondo.current?.scrollIntoView({ block: "end" }));
  };

  // El salto, cuando la ventana ya está pintada: antes no hay a dónde ir.
  useEffect(() => {
    const id = saltoPendiente.current;
    if (!id) return;
    saltoPendiente.current = null;
    // De golpe: el hilo es otro, y deslizarse por sesenta mensajes que no se
    // han pedido es ruido.
    requestAnimationFrame(() => senalar(id, "instant"));
  }, [mensajes]);

  /*
   * Lo que se anuncia de uno mismo: «escribiendo…» y «grabando audio…».
   *
   * Se manda al empezar y se renueva cada 8 s mientras se teclea —WhatsApp
   * lo da por caducado si no—, y «paused» a los 4 s sin teclear, al enviar o
   * al cambiar de conversación. Un fallo aquí no le importa a nadie: no se
   * enseña.
   */
  const ultimoAnuncio = useRef(0);
  const pausa = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anunciar = (presence: "composing" | "recording" | "paused"): void => {
    void fetch(`/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presence }),
    }).catch(() => {});
  };
  const pararDeEscribir = (): void => {
    if (pausa.current) clearTimeout(pausa.current);
    pausa.current = null;
    if (ultimoAnuncio.current) {
      ultimoAnuncio.current = 0;
      anunciar("paused");
    }
  };
  const alEscribir = (texto: string): void => {
    if (!texto.trim()) { pararDeEscribir(); return; }
    if (marcaDeTiempo() - ultimoAnuncio.current > 8000) {
      ultimoAnuncio.current = marcaDeTiempo();
      anunciar("composing");
    }
    if (pausa.current) clearTimeout(pausa.current);
    pausa.current = setTimeout(pararDeEscribir, 4000);
  };
  // Al cambiar de conversación o cerrarla, lo que se estuviera escribiendo
  // ya no se escribe ahí.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => pararDeEscribir(), [chat]);

  /*
   * Mencionar con «@». Solo en grupos, como en WhatsApp: en un chat de dos
   * solo hay a quién mencionar, y es a quien se le escribe.
   */
  // Los participantes y la consulta van atados a SU conversación: al cambiar
  // de chat, lo del anterior deja de valer sin tener que borrarlo a mano.
  const [delGrupo, setDelGrupo] = useState<{ chat: string; lista: Participante[] } | null>(null);
  const [consultaDe, setConsulta] = useState<
    { chat: string; inicio: number; filtro: string } | null
  >(null);
  /*
   * Si no se pudo preguntar a WhatsApp —la línea está desconectada, o el
   * grupo no responde—, se ofrece a quienes han escrito en el hilo. Es menos
   * que la lista entera, pero el «@» no se queda mudo justo cuando falla.
   */
  const participantes = delGrupo?.chat === chat
    ? delGrupo.lista
    : chat.endsWith("@g.us") ? quienesEscribieron(mensajes) : [];
  const consulta = consultaDe?.chat === chat ? consultaDe : null;
  const [resaltada, setResaltada] = useState(0);
  const elegidas = useRef(new Map<string, string>());
  // Las menciones elegidas se reponen con el borrador, más abajo: vaciarlas
  // aquí las borraba justo después de devolverlas.
  useEffect(() => {
    if (!chat.endsWith("@g.us")) return;
    let vivo = true;
    void fetch(`/api/omni/v1/lines/${lineId}/groups/${encodeURIComponent(chat)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data: { participants: Participante[] } }) : null))
      .then((g) => { if (vivo && g) setDelGrupo({ chat, lista: g.data.participants }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [lineId, chat]);

  /*
   * A quién se puede nombrar: los del grupo, y después toda la agenda. En un
   * chat de dos, solo la agenda, como texto (ver `fuera` en lib/menciones).
   */
  const agenda = useAgenda(lineId);
  const candidatos = candidatosDeMencion(participantes, agenda);
  const opcionesDeMencion = consulta ? filtrarParticipantes(candidatos, consulta.filtro) : [];

  const revisarMencion = (): void => {
    const el = campo.current;
    if (!el || candidatos.length === 0) { setConsulta(null); return; }
    const nueva = consultaDeMencion(el.value, el.selectionStart ?? el.value.length);
    setConsulta(nueva ? { chat, ...nueva } : null);
    if (nueva?.filtro !== consulta?.filtro) setResaltada(0);
  };

  const mencionar = (p: Participante): void => {
    const el = campo.current;
    if (!el || !consulta) return;
    const r = insertarMencion(el.value, consulta.inicio, el.selectionStart ?? el.value.length, p.name);
    el.value = r.texto;
    el.setSelectionRange(r.cursor, r.cursor);
    ajustarAltura();
    el.focus();
    // Solo lo del grupo es mención de verdad; lo demás se queda en texto.
    if (!p.fuera) elegidas.current.set(p.name, p.address);
    setConsulta(null);
    apuntarBorrador();
  };

  /*
   * El borrador de esta conversación: lo que se deja escrito a medias vuelve
   * al volver, como en WhatsApp. Ver lib/borradores.ts.
   *
   * Qué se guarda y qué no:
   *
   * - **El texto**, con sus menciones elegidas y la cita a la que se responde.
   *   Es lo que cuesta volver a escribir.
   * - **Los adjuntos, no.** Son ficheros del disco de quien los eligió: el
   *   navegador no deja guardarlos para otra visita, y un pie guardado sin su
   *   foto no es nada que se pueda enviar. Mientras hay adjuntos, el campo es
   *   el PIE del elegido, no un mensaje, y no se guarda como borrador.
   *
   * Se escribe con un respiro de medio segundo y no a cada tecla —la lista
   * repinta su «Borrador:» con cada escritura—, y lo pendiente se escribe sí o
   * sí al salir del chat o cerrar la pestaña.
   */
  const pendiente = useRef<{ lineId: string; chat: string; b: Borrador | null } | null>(null);
  const reloj = useRef<ReturnType<typeof setTimeout> | null>(null);
  const escribirBorrador = (): void => {
    if (reloj.current) clearTimeout(reloj.current);
    reloj.current = null;
    const p = pendiente.current;
    pendiente.current = null;
    if (p) guardarBorrador(p.lineId, p.chat, p.b);
  };
  /**
   * Apunta lo que hay ahora en el campo. La cita se pasa cuando acaba de
   * cambiar: el estado de React no la tendría hasta el próximo pintado.
   */
  const apuntarBorrador = (cita: Mensaje | null = respondiendo): void => {
    if (adjuntos.length > 0 || editando) return;
    pendiente.current = {
      lineId, chat,
      b: {
        texto: campo.current?.value ?? "",
        cita,
        menciones: [...elegidas.current],
        en: marcaDeTiempo(),
      },
    };
    if (reloj.current) clearTimeout(reloj.current);
    reloj.current = setTimeout(escribirBorrador, 500);
  };
  /** Al enviar: lo que había ya no es un borrador, y se quita en el acto. */
  const olvidarBorrador = (): void => {
    if (reloj.current) clearTimeout(reloj.current);
    reloj.current = null;
    pendiente.current = null;
    guardarBorrador(lineId, chat, null);
  };

  /** Cambia lo escrito sin teclear: con su altura, el foco y el cursor al final. */
  const ponerEnCampo = (texto: string): void => {
    const el = campo.current;
    if (!el) return;
    el.value = texto;
    ajustarAltura();
    el.focus();
    el.setSelectionRange(texto.length, texto.length);
  };

  /**
   * Pasa el campo a corregir un mensaje propio.
   *
   * Lo que hubiera escrito no se pierde: el borrador se guarda tal cual, o el
   * pie se guarda en su adjunto, y vuelve al terminar.
   */
  const empezarEdicion = (m: Mensaje): void => {
    if (adjuntos.length > 0) setAdjuntos(guardarPie(adjuntos));
    else { apuntarBorrador(); escribirBorrador(); }
    pararDeEscribir();
    setConsulta(null);
    setProblema(null);
    setEditando(m);
  };

  /** Sale de la edición y devuelve al campo lo que había antes. */
  const terminarEdicion = (): void => {
    setEditando(null);
    if (adjuntos.length > 0) {
      ponerEnCampo(actual?.pie ?? "");
    } else {
      const b = leerBorrador(lineId, chat);
      elegidas.current = new Map(b?.menciones ?? []);
      ponerEnCampo(b?.texto ?? "");
    }
  };

  /**
   * Guarda la corrección.
   *
   * La burbuja cambia al instante, como una reacción: esperar al servidor
   * para ver el texto que se acaba de escribir se siente roto. Si la API dice
   * que no —pasó el plazo, el transporte no sabe editar—, vuelve el texto de
   * antes y se ENSEÑA el motivo que da: una edición que no llega y no avisa
   * deja a quien la hizo creyendo que el otro ve lo corregido.
   */
  const guardarEdicion = async (m: Mensaje): Promise<void> => {
    const texto = campo.current?.value.trim() ?? "";
    if (!texto) {
      setProblema("Un mensaje no puede quedarse vacío. Para quitarlo, bórralo para todos.");
      return;
    }
    terminarEdicion();
    if (texto === m.body) return;

    const marcar = (body: string | null, editedAt: string | null | undefined): void =>
      setMensajes((prev) => prev.map((x) => (x.id === m.id ? { ...x, body, editedAt } : x)));
    marcar(texto, new Date().toISOString());

    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(m.providerMessageId!)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: texto }),
      },
    ).catch(() => null);
    if (r?.ok) return;
    marcar(m.body, m.editedAt);
    const detalle = (await r?.json().catch(() => null)) as { detail?: string } | null;
    setProblema(`No se pudo editar: ${detalle?.detail ?? "no hay conexión con el servidor"}.`);
  };

  /*
   * Al abrir la conversación se repone, ANTES de pintar: con un efecto normal
   * se vería el campo vacío un instante y luego saltar al texto y a su altura.
   */
  useLayoutEffect(() => {
    const b = leerBorrador(lineId, chat);
    if (campo.current) campo.current.value = b?.texto ?? "";
    // El borrador vive fuera de React, en el almacén del navegador, y solo se
    // puede leer después de hidratar: el servidor no lo tiene.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRespondiendo(b?.cita ?? null);
    elegidas.current = new Map(b?.menciones ?? []);
    ajustarAltura();
    // Cerrar la pestaña no desmonta nada: sin esto se perdería lo escrito en
    // el último medio segundo.
    window.addEventListener("pagehide", escribirBorrador);
    return () => {
      window.removeEventListener("pagehide", escribirBorrador);
      escribirBorrador();
    };
  }, [lineId, chat]);

  // El texto entra al campo cuando la franja ya está puesta: es el campo de
  // la edición, no el de antes.
  useEffect(() => {
    if (editando) ponerEnCampo(editando.body ?? "");
    // Solo al EMPEZAR a editar otro mensaje; lo demás lo lleva quien teclea.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editando?.id]);

  /**
   * Vuelve a pedir un fichero que no se pudo bajar. Pasa a «Descargando…» al
   * instante y el fichero llega solo por el socket (`message.updated`); si el
   * servidor dice que no, vuelve el error.
   */
  const reintentarMedio = async (m: Mensaje): Promise<void> => {
    const marcar = (mediaError: string | null) => setMensajes((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, mediaError } : x)));
    marcar(null);
    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(m.id)}/media/retry`,
      { method: "POST" },
    ).catch(() => null);
    if (!r?.ok) marcar(m.mediaError ?? "no se pudo reintentar");
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
   * Reenvía a UN chat de esta línea. Devuelve el motivo si no se pudo: el
   * diálogo lo enseña junto a ese chat, que es donde hay que leerlo.
   */
  const reenviarA = async (m: Mensaje, to: string): Promise<string | null> => {
    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(m.providerMessageId!)}/forward`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      },
    ).catch(() => null);
    if (r?.ok) return null;
    const detalle = (await r?.json().catch(() => null)) as { detail?: string } | null;
    return detalle?.detail ?? "no hay conexión con el servidor";
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
          apuntarBorrador(m);
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
    if (editable(m)) {
      opciones.push({ texto: "Editar", Icono: IconoEditar, onSelect: () => empezarEdicion(m) });
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
    // Se reenvía por el identificador de WhatsApp: uno que aún no lo tiene
    // no hay forma de señalarlo.
    if (m.providerMessageId && !m.deleted) {
      opciones.push({ texto: "Reenviar", Icono: IconoReenviar, onSelect: () => setReenviando(m) });
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
  const detalleFijo = info?.phone
    ? `+${info.phone.split("@")[0]}`
    : info?.kind === "group" ? "Grupo" : chat;
  // Lo que está pasando gana a lo fijo: «escribiendo…», «en línea».
  const vivo = describir(presencias, chat, esGrupo, ahora);

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
            <span
              aria-live="polite"
              className={`block truncate text-xs ${
                vivo?.activo ? "font-medium text-(--color-acento-fuerte)" : "text-(--color-tenue)"
              }`}
            >
              {vivo?.texto ?? detalleFijo}
            </span>
          </button>

          {/* Un grupo también se atiende: quién lo lleva y si está resuelto. */}
          <ControlesDeAtencion
            lineId={lineId}
            chat={chat}
            conv={atencion}
            miembros={miembros}
            yo={yo?.id ?? null}
            onCambio={setAtencion}
            onError={setProblema}
          />

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
            onClick={() => { setBuscando((v) => !v); setFicha(false); }}
            aria-label={buscando ? "Cerrar la búsqueda" : "Buscar en esta conversación"}
            title="Buscar mensajes"
            aria-expanded={buscando}
            className={`flex size-9 items-center justify-center rounded-lg transition-colors duration-150 ${
              buscando
                ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            }`}
          >
            <IconoBuscar className="size-5" />
          </button>

          <button
            type="button"
            onClick={() => { setFicha((v) => !v); setBuscando(false); }}
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
                    {m.kind === "notice" ? (
                      // «Brenda fijó un mensaje»: quién y qué, centrado, como
                      // lo enseña WhatsApp.
                      <span className="rounded-full bg-(--color-panel)/70 px-3 py-1 text-[11px] text-(--color-tenue)">
                        {m.fromMe ? "Tú" : m.senderName ?? info?.displayName ?? "Alguien"} {m.body}
                        <time className="ml-1.5 text-(--color-apagado)" dateTime={m.timestamp}>{hora(m.timestamp)}</time>
                      </span>
                    ) : (
                      <span
                        title="Llegó un mensaje de un tipo que WhatsApp no deja leer a este transporte. Queda guardado tal cual vino."
                        className="rounded-full bg-(--color-panel)/70 px-3 py-1 text-[11px] text-(--color-apagado)"
                      >
                        Mensaje no compatible
                        <time className="ml-1.5" dateTime={m.timestamp}>{hora(m.timestamp)}</time>
                      </span>
                    )}
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
                        <Medio
                          kind={m.kind} medio={m.media} error={m.mediaError}
                          onReintentar={() => void reintentarMedio(m)}
                        />
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

        {/*
          Viendo mensajes antiguos tras una búsqueda. Sin esto no habría forma
          de volver a la conversación de ahora, más que recargando; y lo que
          llega mientras tanto se avisa con un punto.
        */}
        {ventana && (
          <div className="pointer-events-none relative">
            <button
              type="button"
              onClick={() => void volverAlPresente()}
              className="pointer-events-auto absolute right-4 bottom-3 flex items-center gap-2 rounded-full border border-(--color-borde) bg-(--color-panel) px-3.5 py-2 text-xs font-medium shadow-[0_4px_16px_rgba(0,0,0,0.14)] hover:bg-(--color-hundido)"
            >
              {hayNuevos && <span aria-hidden className="size-2 rounded-full bg-(--color-acento)" />}
              {hayNuevos ? "Mensajes nuevos: ir a lo reciente" : "Ir a lo más reciente"}
              <span aria-hidden>↓</span>
            </button>
          </div>
        )}

        {problema && (
          <p
            role="alert"
            className="border-t border-(--color-error) bg-(--color-error-tenue) px-4 py-2 text-xs text-(--color-error)"
          >
            {problema}
          </p>
        )}

        {actual && !editando && (
          <div className="border-t border-(--color-borde) bg-(--color-panel) px-4 py-2.5">
            {/*
              Las miniaturas, en fila. La elegida lleva el anillo y es la que
              edita el campo de texto: su pie y su tipo. En una fila que se
              desplaza de lado, para que treinta no empujen el hilo hacia
              arriba.
            */}
            <ul className="scroll-discreto flex gap-2 overflow-x-auto pb-1">
              {adjuntos.map((a) => (
                <li key={a.id} className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => elegir(a.id)}
                    aria-label={`${a.file.name}${a.pie ? `, con pie` : ""}`}
                    aria-pressed={a.id === actual.id}
                    className={`block overflow-hidden rounded-md ${
                      a.id === actual.id
                        ? "ring-2 ring-(--color-acento)"
                        : "opacity-80 hover:opacity-100"
                    }`}
                  >
                    <Miniatura file={a.file} />
                  </button>
                  <button
                    type="button"
                    onClick={() => quitarAdjunto(a.id)}
                    disabled={subiendo}
                    aria-label={`Quitar ${a.file.name}`}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-(--color-borde) bg-(--color-panel) text-(--color-tenue) shadow-sm hover:text-(--color-texto) disabled:opacity-40"
                  >
                    <IconoCerrar className="size-3" />
                  </button>
                </li>
              ))}
              {adjuntos.length < MAX_ADJUNTOS && (
                <li className="shrink-0">
                  <button
                    type="button"
                    onClick={() => selector.current?.click()}
                    disabled={subiendo}
                    aria-label="Añadir más ficheros"
                    title="Añadir más"
                    className="flex size-12 items-center justify-center rounded-md border border-dashed border-(--color-borde) text-lg text-(--color-tenue) hover:border-(--color-acento) hover:text-(--color-acento-fuerte) disabled:opacity-40"
                  >
                    +
                  </button>
                </li>
              )}
            </ul>

            <div className="mt-1.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{actual.file.name}</p>
                <p className="text-xs text-(--color-tenue)">
                  {progreso
                    ? `Enviando ${progreso.hecho + 1} de ${progreso.total}…`
                    : `${tamano(actual.file.size)} · ${actual.file.type || "tipo desconocido"}${
                      adjuntos.length > 1 ? ` · ${adjuntos.length} listos` : ""}`}
                </p>
              </div>

              {/* El tipo se puede cambiar: un WebP se adjunta como sticker por
                  defecto, pero a veces se quiere mandar como foto. */}
              <label className="text-xs text-(--color-tenue)">
                <span className="sr-only">Enviar como</span>
                <select
                  value={actual.campo}
                  disabled={subiendo}
                  onChange={(e) => setAdjuntos((prev) => prev.map((a) => a.id === actual.id
                    ? { ...a, campo: e.target.value as CampoDeMedio } : a))}
                  className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1.5 text-xs"
                >
                  {(Object.keys(ETIQUETAS) as CampoDeMedio[]).map((k) => (
                    <option key={k} value={k}>{ETIQUETAS[k]}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}

        {/*
          A quién se está respondiendo, encima del campo.
          Va aquí y no dentro del formulario porque se ve ANTES de escribir: es
          lo que confirma que la respuesta va a ese mensaje y no al aire.
        */}
        {respondiendo && !editando && (
          <div className="flex items-center gap-2 border-t border-(--color-borde) bg-(--color-panel) px-3 pt-2 md:px-4">
            <span className="flex items-center gap-2 text-(--color-tenue)">
              <IconoResponder className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <Cita cita={citaDeMensaje(respondiendo)} propia={false} onSaltar={null} />
            </div>
            <button
              type="button"
              onClick={() => { setRespondiendo(null); apuntarBorrador(null); }}
              aria-label="No responder a ese mensaje"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          </div>
        )}

        {/*
          Qué se está corrigiendo, en el sitio de la cita: es lo que dice que
          Enter va a CAMBIAR ese mensaje y no a mandar otro.
        */}
        {editando && (
          <div className="flex items-center gap-2 border-t border-(--color-borde) bg-(--color-panel) px-3 pt-2 md:px-4">
            <span className="text-(--color-tenue)">
              <IconoEditar className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-hidden rounded-md bg-(--color-cita-propia)">
              <span aria-hidden className="w-1 shrink-0 bg-(--color-acento-fuerte)" />
              <span className="min-w-0 flex-1 py-1 pr-1">
                <span className="block text-xs font-semibold text-(--color-acento-fuerte)">Editando mensaje</span>
                <span className="block truncate text-xs text-(--color-tenue)">{editando.body}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={terminarEdicion}
              aria-label="Cancelar la edición"
              title="Cancelar (Esc)"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          </div>
        )}

        <form
          ref={formulario}
          /*
            Con `onSubmit` y no con `action`, a propósito.

            Una `action` de formulario hace que React vacíe el formulario
            cuando la acción TERMINA, es decir, cuando el servidor contesta. Lo
            que se haya empezado a escribir mientras tanto —el segundo mensaje,
            que se escribe rápido— se borraba entonces de golpe. Aquí el campo
            se vacía a mano en el momento de enviar, y nada más.

            La transición sigue envolviendo el envío entero: es lo que mantiene
            el mensaje «enviando» en la lista hasta que llega la respuesta.
          */
          onSubmit={(e) => {
            e.preventDefault();
            // Corrigiendo, Enter guarda la corrección: no manda nada nuevo.
            if (editando) { void guardarEdicion(editando); return; }
            const formData = new FormData(e.currentTarget);
            startTransition(async () => {
              const texto = String(formData.get("texto") ?? "").trim();
              pararDeEscribir();
              // Lo que se manda va al final del hilo de verdad, no al de una
              // ventana de hace meses.
              if (ventanaRef.current) await volverAlPresente();

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
              olvidarBorrador();
              const citaLocal = citado ? citaDeMensaje(citado) : null;

              if (adjuntos.length > 0) {
                /*
                 * Todos, en orden, uno por mensaje. La cita solo en el primero:
                 * en WhatsApp responder con varias fotos cita una vez.
                 *
                 * Si uno falla se PARA ahí. Lo que no salió se queda en la tira
                 * para reintentar, y no se repite el mismo error treinta veces.
                 */
                let pendientes = guardarPie(adjuntos).map((a) => ({ ...a, pie: a.pie.trim() }));
                // Lo escrito antes de adjuntar sale ahora como pie: ya no hay
                // nada que devolver al campo.
                textoAntesDeAdjuntar.current = null;
                formulario.current?.reset();
                ajustarAltura();
                const total = pendientes.length;
                for (const [i, a] of [...pendientes].entries()) {
                  setProgreso({ hecho: i, total });
                  const pie = prepararMenciones(a.pie, elegidas.current);
                  const ok = await mandarFichero(
                    a.file, a.campo, pie.texto,
                    {
                      // Un GIF sale como vídeo en bucle, que es lo que WhatsApp
                      // llama «GIF»; sin la marca llega como un vídeo normal.
                      ...(a.gif && a.campo === "video" ? { gifPlayback: true } : {}),
                      ...(pie.mentions.length > 0 ? { mentions: pie.mentions } : {}),
                    },
                    i === 0 ? citado?.providerMessageId ?? undefined : undefined,
                    i === 0 ? citaLocal : null,
                  );
                  if (!ok) break;
                  pendientes = pendientes.filter((x) => x.id !== a.id);
                  setAdjuntos(pendientes);
                }
                setProgreso(null);
                if (pendientes.length === 0) elegidas.current = new Map();
                setElegido(pendientes[0]?.id ?? null);
                if (campo.current) campo.current.value = pendientes[0]?.pie ?? "";
                ajustarAltura();
                if (selector.current) selector.current.value = "";
                return;
              }

              if (!texto) return;
              formulario.current?.reset();
              ajustarAltura();
              setConsulta(null);
              startTransition(() => anadirPendiente(texto));

              // Lo que se ve dice «@Rodrigo»; lo que se manda, «@número» y a
              // quién. Ver lib/menciones.ts.
              const conMenciones = prepararMenciones(texto, elegidas.current);
              elegidas.current = new Map();
              const enviado = await enviar(
                conMenciones.texto, citado?.providerMessageId ?? undefined,
                conMenciones.mentions.length > 0 ? conMenciones.mentions : undefined,
              );
              if (enviado) {
                /*
                 * La cita se pinta con lo que YA tenemos aquí.
                 *
                 * El servidor la devolvería resuelta en la siguiente carga, pero
                 * esperar a eso dejaría la respuesta sin cita unos segundos,
                 * justo la que se acaba de mandar.
                 */
                const conCita = {
                  ...enviado,
                  ...(citaLocal ? { replyTo: citaLocal } : {}),
                  ...(conMenciones.menciones.length > 0 ? { mentions: conMenciones.menciones } : {}),
                };
                setMensajes((prev) =>
                  prev.some((x) => x.id === conCita.id) ? prev : [...prev, conCita]);
              }
            });
          }}
          /*
            Pegar un fichero lo adjunta, como en WhatsApp: una captura con
            Ctrl+V, o un fichero copiado del explorador. Pegar texto no se
            toca. Va en el formulario y no solo en el campo para que valga
            también con el foco en un botón del compositor.
          */
          onPaste={(e) => {
            if (subiendo) return;
            const ficheros = ficherosPegados(e.clipboardData);
            if (ficheros.length === 0) return;
            e.preventDefault();
            prepararAdjuntos(ficheros);
          }}
          className="relative flex items-end gap-1.5 border-t border-(--color-borde) bg-(--color-panel) px-3 py-2.5"
        >
          {opcionesDeMencion.length > 0 && (
            <ul
              id="menciones"
              role="listbox"
              aria-label="Mencionar a"
              className="absolute bottom-full left-3 z-30 mb-2 w-72 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) py-1 shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
            >
              {opcionesDeMencion.map((p, i) => (
                <li
                  key={p.address}
                  id={`mencion-${i}`}
                  role="option"
                  aria-selected={i === resaltada}
                  // `mousedown` y no `click`: el clic llega después de que el
                  // campo pierda el foco, y para entonces la lista ya se cerró.
                  onMouseDown={(e) => { e.preventDefault(); mencionar(p); }}
                  onMouseEnter={() => setResaltada(i)}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm ${
                    i === resaltada ? "bg-(--color-hundido)" : ""
                  }`}
                >
                  <Avatar nombre={p.name} direccion={p.address} kind="pn" tamano="sm" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {/* Que se sepa antes de elegir: a esta persona no le llega aviso. */}
                  {p.fuera && esGrupo && (
                    <span className="shrink-0 text-[11px] text-(--color-apagado)">no está en el grupo</span>
                  )}
                </li>
              ))}
            </ul>
          )}
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
            multiple
            className="hidden"
            onChange={(e) => {
              prepararAdjuntos(Array.from(e.target.files ?? []));
              // Se vacía para que elegir el mismo fichero otra vez vuelva a
              // disparar el cambio.
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => selector.current?.click()}
            disabled={subiendo || editando !== null}
            aria-label="Adjuntar un fichero"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-texto) disabled:opacity-40 md:size-10"
          >
            <IconoAdjuntar className="size-5" />
          </button>

          <button
            type="button"
            onClick={() => setStickers((v) => !v)}
            disabled={subiendo || editando !== null}
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
            deshabilitado={subiendo || adjuntos.length > 0 || editando !== null}
            onError={setProblema}
            onGrabado={async (file) => { await mandarFichero(file, "audio", "", { ptt: true }); }}
            onGrabando={(activo) => anunciar(activo ? "recording" : "paused")}
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
              deshabilitado={subiendo || adjuntos.length > 0 || editando !== null}
              onError={setProblema}
              onGrabado={async (file) => { await mandarFichero(file, "video", ""); }}
              onGrabando={(activo) => anunciar(activo ? "recording" : "paused")}
            />
          </span>

          <textarea
            ref={campo}
            name="texto"
            rows={1}
            autoComplete="off"
            role="combobox"
            aria-expanded={opcionesDeMencion.length > 0}
            aria-controls="menciones"
            aria-autocomplete="list"
            aria-activedescendant={opcionesDeMencion.length > 0 ? `mencion-${resaltada}` : undefined}
            onInput={(e) => {
              ajustarAltura();
              // Corregir no es escribir: ni «escribiendo…», ni menciones —la
              // edición viaja como texto plano—, ni borrador.
              if (editando) return;
              alEscribir(e.currentTarget.value); revisarMencion(); apuntarBorrador();
            }}
            onSelect={() => { if (!editando) revisarMencion(); }}
            onBlur={() => setTimeout(() => setConsulta(null), 150)}
            onKeyDown={(e) => {
              if (editando && e.key === "Escape") {
                e.preventDefault();
                terminarEdicion();
                return;
              }
              if (opcionesDeMencion.length === 0) {
                /*
                 * Enter envía y Shift+Enter hace salto de línea, como en
                 * WhatsApp de escritorio. En un teléfono, Enter es salto de
                 * línea y se envía con el botón: el teclado táctil no tiene
                 * Shift a mano.
                 *
                 * `isComposing`: con un teclado que compone (chino, japonés,
                 * acentos en algunos sistemas), Enter confirma la palabra, no
                 * envía el mensaje.
                 */
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                if (window.matchMedia("(pointer: coarse)").matches) return;
                e.preventDefault();
                formulario.current?.requestSubmit();
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = opcionesDeMencion.length;
                setResaltada((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              } else if (e.key === "Enter" || e.key === "Tab") {
                // Con la lista abierta, Enter elige: mandar «@Ro» a medias
                // nunca es lo que se quiere.
                e.preventDefault();
                mencionar(opcionesDeMencion[Math.min(resaltada, opcionesDeMencion.length - 1)]!);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setConsulta(null);
              }
            }}
            placeholder={editando ? "Corrige el mensaje" : actual
              ? adjuntos.length > 1 ? "Pie de este (opcional)…" : "Añade un pie (opcional)…"
              : "Escribe un mensaje"}
            className="scroll-discreto max-h-48 min-w-0 flex-1 resize-none rounded-xl bg-(--color-hundido) px-3.5 py-2.5 text-sm leading-5 md:px-4 outline-none placeholder:text-(--color-apagado) focus:ring-2 focus:ring-(--color-acento)"
          />

          <button
            disabled={subiendo}
            aria-label={editando ? "Guardar la edición" : "Enviar"}
            title={editando ? "Guardar (Enter)" : undefined}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-(--color-acento) md:size-10 text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            {editando ? <IconoCheck className="size-5" /> : <IconoEnviar className="size-5" />}
          </button>
        </form>
      </div>

      <Menu
        punto={menu.punto}
        opciones={sobre ? accionesMensaje(sobre) : []}
        onCerrar={menu.cerrar}
      />

      {buscando && (
        <BuscarEnChat
          lineId={lineId}
          chat={chat}
          esGrupo={esGrupo}
          onElegir={(r) => void irAResultado(r)}
          onCerrar={() => setBuscando(false)}
        />
      )}
      {reenviando && (
        <Reenviar
          lineId={lineId}
          resumen={textoDeCita(citaDeMensaje(reenviando))}
          onReenviar={(to) => reenviarA(reenviando, to)}
          onCerrar={() => setReenviando(null)}
        />
      )}
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
        <span className="flex items-center gap-1 truncate text-xs text-(--color-tenue)">
          <IconoDeCita kind={cita.kind} ptt={cita.ptt ?? false} />
          <span className="truncate">{textoDeCita(cita)}</span>
        </span>
      </span>
      {cita.thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cita.thumbUrl}
          alt=""
          // Si aun así no carga, se quita en vez de dejar el icono roto.
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          className="size-12 shrink-0 object-cover"
        />
      )}
    </Caja>
  );
}

/**
 * El texto de un mensaje, con las menciones y los enlaces como en WhatsApp.
 *
 * WhatsApp manda `@120238196658384` y deja al cliente poner el nombre. Aquí
 * se pinta `@Nadkym` en el color de acento y en negrita suave, que es como se
 * distingue en el teléfono que eso es una persona y no texto. El número sigue
 * en el `title`: es el detalle, no lo que se lee.
 *
 * Los enlaces se abren en otra pestaña y sin `opener` ni `referrer`: quien
 * manda un enlace no tiene por qué saber desde dónde se abrió, ni la página
 * abierta tocar la del panel.
 */
function Texto({ mensaje }: { mensaje: Mensaje }) {
  return (
    <>
      {trozosConMenciones(mensaje.body ?? "", mensaje.mentions).map((t, i) =>
        "texto" in t
          ? partirEnlaces(t.texto).map((e, j) => "texto" in e
            ? <span key={`${i}-${j}`}>{e.texto}</span>
            : (
              <a
                key={`${i}-${j}`}
                href={e.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-(--color-enlace) underline decoration-1 underline-offset-2 hover:decoration-2"
              >
                {e.enlace}
              </a>
            ))
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

/**
 * Lo que se va a mandar, visto antes de mandarlo.
 *
 * Una captura pegada se llama «captura-…png»: sin la miniatura no hay forma de
 * saber si es la que se quería. Solo imágenes; para lo demás el nombre basta.
 */
function Miniatura({ file }: { file: File }) {
  // La URL vive lo que vive la imagen: se crea al montarla y se libera al
  // quitarla o cambiar de fichero. Si no, cada captura pegada se queda en
  // memoria hasta cerrar la pestaña.
  const enlazar = useCallback((img: HTMLImageElement | null) => {
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!file.type.startsWith("image/")) {
    // Lo que no es imagen se reconoce por su extensión, como en WhatsApp.
    const ext = file.name.includes(".") ? file.name.split(".").pop()!.slice(0, 4) : "";
    return (
      <span className="flex size-12 flex-col items-center justify-center gap-0.5 rounded-md bg-(--color-hundido) text-(--color-tenue)">
        <IconoDocumento className="size-5" />
        {ext && <span className="text-[9px] font-semibold uppercase">{ext}</span>}
      </span>
    );
  }
  // El `src` lo pone `enlazar` al montar, antes de pintar: no hay caja rota.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={enlazar} alt="" className="size-12 rounded-md object-cover" />; // impeccable-disable-line broken-image -- src asignado por la ref al montar
}

function Firma({ mensaje }: { mensaje: Mensaje }) {
  return (
    <>
      {/* Hueco reservado para que la hora no se monte sobre la última palabra. */}
      <span aria-hidden className={`inline-block select-none ${mensaje.editedAt ? "w-24" : "w-14"}`} />
      <span className="float-right ml-1.5 inline-flex translate-y-0.5 items-center gap-1 text-[11px] leading-none text-(--color-apagado)">
        {/* Como en WhatsApp: «Editado» delante de la hora, y cuándo al pasar por encima. */}
        {mensaje.editedAt && (
          <span title={`Editado ${new Date(mensaje.editedAt).toLocaleString("es")}`}>Editado</span>
        )}
        <time dateTime={mensaje.timestamp}>{hora(mensaje.timestamp)}</time>
        {mensaje.fromMe && <Acuse estado={mensaje.state} />}
      </span>
    </>
  );
}
