"use client";

import { useEffect, useState } from "react";

/**
 * Respuestas rápidas al escribir: «/» al principio del campo, como en WhatsApp
 * Business.
 *
 * Funciona igual que el «@» de las menciones: una lista que se filtra con lo
 * que se escribe, flechas para moverse, Enter o Tab para elegir y Esc para
 * cerrar. Al elegir, el texto guardado SUSTITUYE al atajo y queda en el campo
 * para retocarlo: no se envía solo, porque una respuesta enlatada casi
 * siempre se ajusta antes («Hola Ana, …»).
 */

export interface Respuesta {
  readonly id: string;
  /** Sin la barra: «precios», que se escribe «/precios». */
  readonly shortcut: string;
  readonly text: string;
}

/**
 * Si el campo está pidiendo una respuesta rápida, y con qué filtro.
 *
 * Solo con la barra AL PRINCIPIO del campo y el cursor todavía en el atajo,
 * es decir, antes del primer espacio. Una barra en medio de una frase
 * —«24/7», «sí/no», una ruta— no abre nada.
 */
export function consultaDeRespuesta(texto: string, cursor: number): { filtro: string } | null {
  if (!texto.startsWith("/")) return null;
  const atajo = texto.slice(1, cursor);
  if (cursor < 1 || /\s/.test(atajo)) return null;
  return { filtro: atajo };
}

const plano = (t: string): string =>
  t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Las que encajan con lo escrito, de mejor a peor: primero las que EMPIEZAN
 * por ello —es lo que se espera al escribir un atajo—, luego las que lo
 * contienen en el atajo, y al final las que lo contienen en el texto, para
 * quien no recuerda el atajo pero sí lo que decía.
 */
export function filtrarRespuestas(lista: readonly Respuesta[], filtro: string, max = 8): Respuesta[] {
  const f = plano(filtro);
  if (!f) return lista.slice(0, max);
  const empieza = lista.filter((r) => plano(r.shortcut).startsWith(f));
  const contiene = lista.filter((r) => !plano(r.shortcut).startsWith(f) && plano(r.shortcut).includes(f));
  const enTexto = lista.filter((r) => !plano(r.shortcut).includes(f) && plano(r.text).includes(f));
  return [...empieza, ...contiene, ...enTexto].slice(0, max);
}

/**
 * Pone la respuesta en lugar del atajo. Lo que hubiera detrás del atajo se
 * conserva: «/precios para Ana» → «<texto> para Ana».
 */
export function insertarRespuesta(texto: string, cursor: number, r: Respuesta): { texto: string; cursor: number } {
  const resto = texto.slice(cursor).replace(/^\s+/, "");
  const nuevo = resto ? `${r.text} ${resto}` : r.text;
  return { texto: nuevo, cursor: r.text.length };
}

/**
 * Las respuestas de la organización, pedidas al abrir la conversación.
 *
 * Sin caché entre conversaciones a propósito: son pocas y cortas, y así lo
 * que se acaba de crear en la pantalla de gestión está al volver al chat, sin
 * recargar. `null` mientras llegan, para no decir «no hay ninguna» antes de
 * saberlo.
 */
export function useRespuestas(): Respuesta[] | null {
  const [lista, setLista] = useState<Respuesta[] | null>(null);
  useEffect(() => {
    let vivo = true;
    void fetch("/api/omni/v1/quick-replies")
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Respuesta[] }).data : []))
      .catch(() => [] as Respuesta[])
      .then((l) => { if (vivo) setLista(l); });
    return () => { vivo = false; };
  }, []);
  return lista;
}
