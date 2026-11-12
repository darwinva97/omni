import { setImmediate as cederTurno } from "node:timers/promises";

/**
 * Trabajo en bloque sin acaparar el proceso.
 *
 * Al enlazar una línea, WhatsApp vuelca de golpe la agenda, las parejas
 * LID ↔ teléfono y el estado de miles de chats. Cada elemento acaba en la
 * ingesta, que hace sus consultas a la base. Lanzarlos todos a la vez —un
 * `void emit(...)` por elemento, que es lo que se hacía— tenía dos efectos:
 *
 *  - el bucle que los lanza se come el event loop entero mientras arranca
 *    miles de cadenas de promesas, y
 *  - esas cadenas dejan miles de consultas en la cola del pool de Postgres,
 *    DELANTE de las que hacen `/health` y el panel. La sonda de Kubernetes
 *    caducaba esperando turno aunque el proceso estuviera vivo.
 *
 * Aquí se procesan por lotes acotados, con pocas en vuelo a la vez, y se cede
 * el turno entre lote y lote para que el HTTP pase por medio.
 */

export interface OpcionesPorLotes {
  /** Cuántos elementos se procesan antes de ceder el turno. */
  readonly lote?: number;
  /** Cuántos elementos de un lote van a la vez hacia la ingesta. */
  readonly paralelo?: number;
}

export const LOTE_POR_DEFECTO = 100;
/*
 * El pool de la API tiene diez conexiones. Cuatro para el volcado dejan las
 * demás libres para lo que llega por HTTP, y bastan para que una agenda de
 * miles de contactos se ingiera en segundos y no en minutos.
 */
export const PARALELO_POR_DEFECTO = 4;

/**
 * Pasa cada elemento por `fn`, por lotes, sin tener más de `paralelo` en vuelo.
 *
 * Un fallo en un elemento no corta los demás: el que falla se pierde igual que
 * se perdía antes, cuando cada uno iba por su cuenta.
 */
export async function procesarPorLotes<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  opts: OpcionesPorLotes = {},
): Promise<void> {
  const lote = Math.max(1, opts.lote ?? LOTE_POR_DEFECTO);
  const paralelo = Math.max(1, opts.paralelo ?? PARALELO_POR_DEFECTO);

  for (let inicio = 0; inicio < items.length; inicio += lote) {
    /*
     * Ceder el turno ANTES de cada lote, el primero incluido. Si `fn`
     * resuelve sin E/S de verdad —un suscriptor que no espera a nada— el lote
     * entero corre en microtareas sin soltar el event loop; esto lo suelta
     * cada `lote` elementos, también entre una llamada y la siguiente.
     */
    await cederTurno();
    const fin = Math.min(inicio + lote, items.length);
    let siguiente = inicio;
    const trabajador = async (): Promise<void> => {
      while (siguiente < fin) {
        const item = items[siguiente++] as T;
        try {
          await fn(item);
        } catch {
          /* aislado: un elemento roto no tumba el volcado */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(paralelo, fin - inicio) }, trabajador));
  }
}

/**
 * Funde los elementos que comparten clave, el último gana campo a campo.
 *
 * Es lo que hace Baileys al juntar trozos de historial: un campo que no viene
 * (`undefined`) no borra el que ya se tenía. Con las claves únicas, el orden
 * en que se procesen dentro de un lote deja de importar, y lo repetido no se
 * ingiere dos veces.
 */
export function fundirPorClave<T extends object>(
  items: readonly T[],
  clave: (item: T) => string | undefined,
): T[] {
  const porClave = new Map<string, T>();
  const sinClave: T[] = [];
  for (const item of items) {
    const k = clave(item);
    if (k === undefined) {
      sinClave.push(item);
      continue;
    }
    const previo = porClave.get(k);
    if (!previo) {
      porClave.set(k, { ...item });
      continue;
    }
    for (const [campo, valor] of Object.entries(item)) {
      if (valor !== undefined) (previo as Record<string, unknown>)[campo] = valor;
    }
  }
  return [...porClave.values(), ...sinClave];
}

/**
 * Una cola en serie: cada tarea empieza cuando acaba la anterior.
 *
 * Los volcados llegan en trozos y detrás de ellos los cambios sueltos. Sin
 * serializarlos, un cambio reciente podía ingerirse ANTES que un trozo viejo
 * que aún se estaba procesando, y el dato viejo ganaba.
 */
export class ColaEnSerie {
  #cola: Promise<void> = Promise.resolve();

  encolar(tarea: () => Promise<void>): Promise<void> {
    // `#cola` nunca rechaza: una tarea que falla no atasca a las siguientes.
    this.#cola = this.#cola.then(tarea).catch(() => {});
    return this.#cola;
  }

  /** Se resuelve cuando no queda nada pendiente de lo encolado hasta ahora. */
  vacia(): Promise<void> {
    return this.#cola;
  }
}
