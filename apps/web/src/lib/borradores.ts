"use client";

import { useSyncExternalStore } from "react";
import type { Mensaje } from "./api";

/**
 * Lo que se dejó escrito a medias en cada conversación.
 *
 * Sin esto, escribir media respuesta, saltar a otro chat a mirar un dato y
 * volver dejaba el campo vacío: la página del chat se monta de nuevo y el
 * campo no tiene estado. WhatsApp lo guarda, y quien viene de ahí lo da por
 * hecho.
 *
 * Vive en el navegador y no en el servidor a propósito: un borrador es de
 * quien lo escribe en ESTA pestaña, no del equipo. Guardarlo en la API haría
 * que lo que Ana tiene a medias le apareciera a Bruno en el mismo chat.
 */
export interface Borrador {
  texto: string;
  /**
   * El mensaje al que se estaba respondiendo. Se guarda entero y no solo su
   * identificador: el hilo trae los últimos cien, y la cita tiene que volver
   * aunque el citado ya no esté entre ellos.
   */
  cita?: Mensaje | null;
  /**
   * Las menciones elegidas, como pares nombre → dirección. El texto dice
   * «@Rodrigo»; sin este mapa, al volver se mandaría como texto y a Rodrigo no
   * le llegaría el aviso. Ver lib/menciones.ts.
   */
  menciones?: [string, string][];
  /** Cuándo se escribió por última vez, para poder podar los viejos. */
  en: number;
}

type Mapa = Record<string, Borrador>;

const CLAVE = "omni.borradores";

/**
 * Cuántos se guardan como mucho. Un borrador olvidado no caduca —tampoco en
 * WhatsApp—, pero el almacén del navegador sí tiene fondo: si se pasa, se van
 * los más viejos y nunca el que se acaba de escribir.
 */
export const MAX_BORRADORES = 200;

/** Una conversación de una línea: la misma dirección en dos líneas son dos chats. */
export const claveDe = (lineId: string, chat: string): string => `${lineId} ${chat}`;

/** Lee el mapa tal cual esté guardado; si está roto, como si no hubiera nada. */
export function leerMapa(crudo: string | null): Mapa {
  if (!crudo) return {};
  try {
    const m = JSON.parse(crudo) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Mapa) : {};
  } catch {
    return {};
  }
}

/**
 * El mapa con este borrador puesto, o quitado.
 *
 * Un borrador sin texto y sin cita no es un borrador: se quita, y así la lista
 * deja de decir «Borrador:» en cuanto se vacía el campo.
 */
export function conBorrador(mapa: Mapa, clave: string, b: Borrador | null): Mapa {
  const siguiente = { ...mapa };
  if (!b || (!b.texto.trim() && !b.cita)) {
    delete siguiente[clave];
    return siguiente;
  }
  siguiente[clave] = b;
  const claves = Object.keys(siguiente);
  if (claves.length > MAX_BORRADORES) {
    claves
      .filter((k) => k !== clave)
      .sort((a, z) => siguiente[a]!.en - siguiente[z]!.en)
      .slice(0, claves.length - MAX_BORRADORES)
      .forEach((k) => { delete siguiente[k]; });
  }
  return siguiente;
}

/**
 * Lo que se lee en la lista: una sola línea, como el resto de adelantos. Un
 * borrador que solo tiene la cita —se pulsó «Responder» y no se escribió
 * nada— también lo es, y lo dice.
 */
export function resumenDeBorrador(b: Borrador): string {
  const texto = b.texto.trim().replace(/\s+/g, " ");
  return texto || "respondiendo a un mensaje";
}

/*
 * Un solo mapa para toda la página, como las preferencias de avisos.
 *
 * La conversación lo escribe y la lista lo lee: con una copia en cada uno, el
 * «Borrador:» de la lista no aparecía hasta recargar. El `storage` del
 * navegador avisa además a las otras pestañas del panel.
 */
let cache: Mapa | null = null;
const oyentes = new Set<() => void>();
const VACIO: Mapa = {};

function leer(): Mapa {
  if (typeof window === "undefined") return VACIO;
  try {
    return leerMapa(window.localStorage.getItem(CLAVE));
  } catch {
    return VACIO;
  }
}

function instantanea(): Mapa {
  cache ??= leer();
  return cache;
}

function suscribirse(avisar: () => void): () => void {
  oyentes.add(avisar);
  const deOtraPestana = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== CLAVE) return;
    cache = leer();
    for (const o of oyentes) o();
  };
  window.addEventListener("storage", deOtraPestana);
  return () => {
    oyentes.delete(avisar);
    window.removeEventListener("storage", deOtraPestana);
  };
}

/** El borrador de una conversación, si lo hay. */
export function leerBorrador(lineId: string, chat: string): Borrador | null {
  return instantanea()[claveDe(lineId, chat)] ?? null;
}

/** Guarda (o, con `null` o vacío, quita) el borrador de una conversación. */
export function guardarBorrador(lineId: string, chat: string, b: Borrador | null): void {
  const clave = claveDe(lineId, chat);
  const antes = instantanea();
  // Quitar lo que no está no avisa a nadie: la lista no tiene nada que repintar.
  if (!b && !(clave in antes)) return;
  cache = conBorrador(antes, clave, b);
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(cache));
  } catch { /* modo privado o almacén lleno: vale para esta sesión */ }
  for (const o of oyentes) o();
}

/**
 * Los borradores de una línea, por conversación, y vivos.
 *
 * En el servidor no hay ninguno: allí no existe `localStorage`, y pintar otra
 * cosa haría que el HTML del servidor y el del navegador no coincidieran.
 */
export function useBorradores(lineId: string): ReadonlyMap<string, Borrador> {
  const mapa = useSyncExternalStore(suscribirse, instantanea, () => VACIO);
  return delaLinea(mapa, lineId);
}

/*
 * El filtrado por línea se recuerda por mapa: `useSyncExternalStore` devuelve
 * el mismo objeto mientras nada cambie, y rehacerlo en cada pintado de la
 * lista —que se repinta con cada «escribiendo…»— sería trabajo tirado.
 */
const porLinea = new WeakMap<Mapa, Map<string, ReadonlyMap<string, Borrador>>>();
function delaLinea(mapa: Mapa, lineId: string): ReadonlyMap<string, Borrador> {
  let deMapa = porLinea.get(mapa);
  if (!deMapa) { deMapa = new Map(); porLinea.set(mapa, deMapa); }
  let hecho = deMapa.get(lineId);
  if (!hecho) {
    const prefijo = `${lineId} `;
    hecho = new Map(
      Object.entries(mapa)
        .filter(([k]) => k.startsWith(prefijo))
        .map(([k, b]) => [k.slice(prefijo.length), b]),
    );
    deMapa.set(lineId, hecho);
  }
  return hecho;
}
