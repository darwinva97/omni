"use client";

import { useEffect, useState } from "react";

/**
 * Quién escribe, quién graba y quién está en línea, por conversación.
 *
 * Funciones puras: el estado entra, el evento entra, sale el estado nuevo. Así
 * se prueban sin navegador, y los dos sitios que lo enseñan —la cabecera del
 * chat y la lista— leen lo mismo.
 *
 * Lo que manda WhatsApp tiene una trampa: «escribiendo» no siempre termina con
 * un «ha parado». Si la otra persona cierra la aplicación a mitad de frase, el
 * «paused» no llega nunca. Por eso cada «escribiendo» CADUCA solo, como en el
 * teléfono, y mientras la persona sigue escribiendo WhatsApp lo va renovando.
 */

export type EstadoDePresencia =
  | "composing" | "recording" | "paused" | "available" | "unavailable";

export interface PresenciaDePersona {
  readonly address: string;
  readonly name: string;
  /** Qué está haciendo, si hace algo: escribir o grabar. */
  readonly haciendo: "composing" | "recording" | null;
  /** Hasta cuándo vale `haciendo` sin renovarse. */
  readonly hasta: number;
  /** `true` en línea, `false` desconectado, `null` si no se sabe. */
  readonly enLinea: boolean | null;
  readonly ultimaVez: number | null;
}

/** Por conversación, por persona. */
export type Presencias = ReadonlyMap<string, ReadonlyMap<string, PresenciaDePersona>>;

/** Lo que dura un «escribiendo» sin renovar. WhatsApp lo renueva cada pocos segundos. */
export const CADUCA_MS = 12_000;

export interface EventoDePresencia {
  readonly chat?: string;
  readonly estados?: readonly {
    address: string; name: string; state: string; lastSeen?: number;
  }[];
}

export function aplicarPresencia(
  antes: Presencias, evento: EventoDePresencia, ahora: number,
): Presencias {
  if (!evento.chat || !evento.estados?.length) return antes;
  const delChat = new Map(antes.get(evento.chat) ?? []);

  for (const e of evento.estados) {
    const previa = delChat.get(e.address);
    const estado = e.state as EstadoDePresencia;
    const haciendo = estado === "composing" || estado === "recording" ? estado : null;
    delChat.set(e.address, {
      address: e.address,
      // Un mensaje que llega apaga el «escribiendo» sin traer nombre: se
      // conserva el que ya se sabía.
      name: e.name || previa?.name || "",
      haciendo,
      hasta: haciendo ? ahora + CADUCA_MS : 0,
      // Quien escribe está en línea aunque no lo haya dicho; «paused» no dice
      // nada de eso, así que se conserva lo que se supiera.
      enLinea: estado === "unavailable" ? false
        : estado === "available" || haciendo ? true
        : previa?.enLinea ?? null,
      ultimaVez: e.lastSeen ?? (estado === "unavailable" ? ahora : previa?.ultimaVez ?? null),
    });
  }

  const despues = new Map(antes);
  despues.set(evento.chat, delChat);
  return despues;
}

/** Quién está escribiendo o grabando AHORA en una conversación. */
export function activos(
  presencias: Presencias, chat: string, ahora: number,
): PresenciaDePersona[] {
  return [...(presencias.get(chat)?.values() ?? [])]
    .filter((p) => p.haciendo && p.hasta > ahora);
}

/**
 * La frase, como la dice WhatsApp.
 *
 * En un chat de dos no hace falta decir quién: «escribiendo…». En un grupo sí,
 * y con tres o más se cuentan en vez de nombrarlos, que la cabecera no da
 * para una lista. Grabar gana a escribir: es lo que se va a recibir.
 *
 * Sin nadie haciendo nada, en un chat de dos se dice si está en línea o cuándo
 * se conectó; en un grupo, nada (`null`), y quien llama pone lo de siempre.
 */
export function describir(
  presencias: Presencias, chat: string, esGrupo: boolean, ahora: number,
): { texto: string; activo: boolean } | null {
  const quienes = activos(presencias, chat, ahora);
  if (quienes.length > 0) {
    const graban = quienes.filter((p) => p.haciendo === "recording");
    const grupo = graban.length > 0 ? graban : quienes;
    const accion = graban.length > 0 ? "grabando audio" : "escribiendo";
    if (!esGrupo) return { texto: `${accion}…`, activo: true };
    const primero = (n: string) => n.split(/\s+/)[0]!;
    const texto = grupo.length === 1
      ? `${primero(grupo[0]!.name)} está ${accion}…`
      : grupo.length === 2
        ? `${primero(grupo[0]!.name)} y ${primero(grupo[1]!.name)} están ${accion}…`
        : `${grupo.length} personas están ${accion}…`;
    return { texto, activo: true };
  }

  if (esGrupo) return null;
  const persona = [...(presencias.get(chat)?.values() ?? [])][0];
  if (persona?.enLinea) return { texto: "en línea", activo: false };
  if (persona?.ultimaVez) return { texto: `últ. vez ${ultimaVez(persona.ultimaVez, ahora)}`, activo: false };
  return null;
}

function ultimaVez(cuando: number, ahora: number): string {
  const d = new Date(cuando);
  const hoy = new Date(ahora);
  const hora = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const mismoDia = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (mismoDia(d, hoy)) return `hoy a las ${hora}`;
  const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
  if (mismoDia(d, ayer)) return `ayer a las ${hora}`;
  return `el ${d.toLocaleDateString("es", { day: "numeric", month: "short" })} a las ${hora}`;
}

/**
 * La presencia de una pantalla: escucha el socket y hace caducar lo viejo.
 *
 * El reloj solo corre mientras alguien escribe: con nada que caducar, no hay
 * por qué repintar cada dos segundos.
 */
export function usePresencias(
  suscribir: (o: (evento: string, data: Record<string, unknown>) => void) => () => void,
): { presencias: Presencias; ahora: number } {
  const [presencias, setPresencias] = useState<Presencias>(() => new Map());
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => suscribir((evento, data) => {
    if (evento === "presence.updated") {
      setPresencias((prev) => aplicarPresencia(prev, data as EventoDePresencia, Date.now()));
      setAhora(Date.now());
      return;
    }
    // Quien manda el mensaje ha dejado de escribir, aunque no lo haya dicho.
    if (evento === "message.received") {
      const key = (data["key"] ?? {}) as { remoteJid?: string; participant?: string };
      if (!key.remoteJid) return;
      setPresencias((prev) => aplicarPresencia(prev, {
        chat: key.remoteJid!,
        estados: [{ address: key.participant ?? key.remoteJid!, name: "", state: "paused" }],
      }, Date.now()));
    }
  }), [suscribir]);

  const hayActivos = [...presencias.values()]
    .some((m) => [...m.values()].some((p) => p.haciendo && p.hasta > ahora));
  useEffect(() => {
    if (!hayActivos) return;
    const t = setInterval(() => setAhora(Date.now()), 2000);
    return () => clearInterval(t);
  }, [hayActivos]);

  return { presencias, ahora };
}
